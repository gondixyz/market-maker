import { basisPoints, BPS, percentOf } from './basisPoints';
import type { ListingSnapshot, OwnListing } from './market';
import { aboveBy, belowBy } from './reference';
import type { ListingPricingRule, ListingTask } from './task';

const MINIMUM_REFRESH_MARGIN_MS = 2 * 60_000;
const HOUR_MS = 60 * 60_000;

export type ListingWaitReason =
  | 'noPrice'
  | 'notOwned'
  | 'notApproved'
  | 'needsOnChainCancel'
  | 'crossedBook';

/**
 * Whether the cheapest other ask sits under the best bid. No real seller stays listed there, as
 * anyone would buy and sell straight into the bid, so it is bad data, such as a dust listing, and
 * nothing is priced from it.
 */
export const isCrossed = (ask: bigint | null, bid: bigint | null) =>
  ask !== null && bid !== null && ask < bid;

/**
 * What to do with a task's listing this round. Unlike a bid, a listing is never cancelled: that
 * costs a transaction. An older listing a cheaper one replaced stays live, dominated, until it
 * expires. A `needsOnChainCancel` wait carries the cheaper live listing it leaves up.
 */
export type ListingDecision =
  | { type: 'keep'; listing: OwnListing }
  | { type: 'place'; price: bigint }
  | { type: 'wait'; reason: ListingWaitReason; listing?: OwnListing }
  | { type: 'halt'; reason: 'filled' };

/** What an item cost the wallet, and what a sale of it pays away in royalties and fees. */
export type ItemCost = { cost: bigint; feeBps: bigint };

/** The prices a listing's safeguards hold it above, beside the market's snapshot. */
export type ListingBounds = {
  /** The task's smoothed cheapest competing listing, for its `reference`. */
  referencePrice?: bigint | null;
  /** What the item cost, for `aboveCost`; unset when the fills do not say. */
  itemCost?: ItemCost;
};

export type DecideListingInput = ListingBounds & {
  task: ListingTask;
  snapshot: ListingSnapshot;
  now: Date;
  /** The pause between two rounds, which the refresh margin must outlast. */
  pollSeconds: number;
  /** When this run first found the item held: the start of the task's `decay`. */
  listedSince: Date;
};

/**
 * How long before its expiration an order is placed again: a share of its lifetime, at least two
 * minutes, and at least two poll intervals, so a round that comes `pollSeconds` late, plus however
 * long the round itself takes, still finds the order live and refreshes it before it lapses.
 */
export const refreshMarginMs = (expirationMinutes: number, pollSeconds: number) =>
  Math.max(MINIMUM_REFRESH_MARGIN_MS, expirationMinutes * 6_000, 2 * pollSeconds * 1_000);

const ruleListingPrice = (
  rule: ListingPricingRule,
  snapshot: ListingSnapshot,
  maxPrice: bigint,
) => {
  switch (rule.mode) {
    case 'fixed':
      return rule.price;
    case 'floor':
      return snapshot.lowestCompetingAsk === null
        ? null
        : percentOf(snapshot.lowestCompetingAsk, rule.percent);
    case 'undercut':
      return snapshot.lowestCompetingAsk === null
        ? maxPrice
        : snapshot.lowestCompetingAsk - rule.amount;
  }
};

/**
 * `price` less the task's `decay`: `percent` of it for each full `everyHours` since `listedSince`,
 * so the price steps down rather than drifting every round, which would list again each round.
 * Unchanged without `decay`; at most the whole price, which `minPrice` then holds up.
 */
export const decayedListingPrice = (
  price: bigint,
  decay: ListingTask['decay'],
  listedSince: Date,
  now: Date,
) => {
  if (!decay) return price;
  const elapsedSteps = Math.floor(
    Math.max(0, now.getTime() - listedSince.getTime()) / (decay.everyHours * HOUR_MS),
  );
  return price - percentOf(price, Math.min(100, elapsedSteps * decay.percent));
};

/**
 * The least a sale at which pays back `cost` plus `marginPercent` of it once `feeBps` of the price
 * is paid away, rounded up to the wei.
 */
export const breakEvenPrice = ({ cost, feeBps }: ItemCost, marginPercent: number) => {
  const wanted = (cost * (BPS + basisPoints(marginPercent)) + BPS - 1n) / BPS;
  const kept = BPS - feeBps;
  return kept > 0n ? (wanted * BPS + kept - 1n) / kept : null;
};

/**
 * The least the task lists at: `minPrice`, and above it whichever of its safeguards is set and
 * higher: `aboveCost` over the item's `breakEvenPrice`, `reference` at most `maxBelowPercent` under
 * the smoothed cheapest competing listing, and `behindGondi` `percent` above a cheapest competing
 * listing on GONDI. `null` when `aboveCost` cannot be met at any price (fees of 100% or more).
 */
const listingFloor = (
  task: ListingTask,
  snapshot: ListingSnapshot,
  { referencePrice = null, itemCost }: ListingBounds,
): bigint | null => {
  const floors = [task.minPrice];
  if (task.aboveCost && itemCost) {
    const breakEven = breakEvenPrice(itemCost, task.aboveCost.marginPercent);
    if (breakEven === null) return null;
    floors.push(breakEven);
  }
  if (task.reference && referencePrice !== null) {
    floors.push(belowBy(referencePrice, task.reference.maxBelowPercent));
  }
  if (task.behindGondi && snapshot.lowestCompetingAskOnGondi && snapshot.lowestCompetingAsk) {
    floors.push(aboveBy(snapshot.lowestCompetingAsk, task.behindGondi.percent));
  }
  return floors.reduce((highest, floor) => (floor > highest ? floor : highest));
};

/**
 * The price the listing should sit at now: the task's rule capped at `maxPrice`, lowered by its
 * `decay`, and held up at its `listingFloor`, which may lift it over `maxPrice`, since selling
 * under cost or into a dip is what those safeguards refuse; or `null` when the rule has nothing to
 * price from. Not rounded: listings are not price-stepped.
 */
export const targetListingPrice = (
  task: ListingTask,
  snapshot: ListingSnapshot,
  listedSince: Date,
  now: Date,
  bounds: ListingBounds = {},
): bigint | null => {
  const rulePrice = ruleListingPrice(task.pricing, snapshot, task.maxPrice);
  const floor = listingFloor(task, snapshot, bounds);
  if (rulePrice === null || floor === null) return null;
  const capped = rulePrice > task.maxPrice ? task.maxPrice : rulePrice;
  const decayed = decayedListingPrice(capped, task.decay, listedSince, now);
  return decayed < floor ? floor : decayed;
};

const needsRefresh = (listing: OwnListing, task: ListingTask, now: Date, pollSeconds: number) =>
  listing.expiration.getTime() - now.getTime() <=
  refreshMarginMs(task.expirationMinutes, pollSeconds);

/**
 * Whether a buyer can still take the listing. The API can keep an order `Active` long after its
 * expiration, which Seaport no longer fills, so the expiration decides too.
 */
export const isLive = (listing: OwnListing, now: Date) =>
  listing.active && listing.expiration.getTime() > now.getTime();

/** The live listing a buyer would take: the cheapest, and of those the one that lasts longest. */
export const cheapestListing = (listings: OwnListing[]) =>
  [...listings].sort((first, second) =>
    first.price === second.price
      ? second.expiration.getTime() - first.expiration.getTime()
      : first.price < second.price
        ? -1
        : 1,
  )[0];

/**
 * Decides what a listing task does this round, from one snapshot. Pure: the runner carries the
 * decision out. A fill halts the task. Without the item or the marketplace's approval, on a crossed
 * book, or without a price, it places nothing. A lower target lists again at that price, leaving the older listing to
 * expire; a higher target than a live listing waits for the user, since only an on-chain cancel
 * removes the cheaper one. A listing past its expiration is not live, whatever its status says.
 * The input's `ListingBounds` hold the target up for `aboveCost` and `reference`.
 */
export const decideListing = ({
  task,
  snapshot,
  now,
  pollSeconds,
  listedSince,
  ...bounds
}: DecideListingInput): ListingDecision => {
  if (snapshot.ownListings.some((listing) => listing.executions > 0)) {
    return { type: 'halt', reason: 'filled' };
  }
  if (!snapshot.owned) return { type: 'wait', reason: 'notOwned' };
  if (!snapshot.approved) return { type: 'wait', reason: 'notApproved' };
  if (isCrossed(snapshot.lowestCompetingAsk, snapshot.bestCompetingBid)) {
    return { type: 'wait', reason: 'crossedBook' };
  }
  const price = targetListingPrice(task, snapshot, listedSince, now, bounds);
  if (price === null) return { type: 'wait', reason: 'noPrice' };
  const live = cheapestListing(snapshot.ownListings.filter((listing) => isLive(listing, now)));
  if (!live || price < live.price) return { type: 'place', price };
  if (price > live.price) return { type: 'wait', reason: 'needsOnChainCancel', listing: live };
  return needsRefresh(live, task, now, pollSeconds)
    ? { type: 'place', price }
    : { type: 'keep', listing: live };
};

/**
 * Decides one item of a listing task without `tokenId`, which lists every item of the collection
 * the wallet holds and never halts. `null` skips an item the wallet no longer holds (sold, moved,
 * or not yet out of the owners index). A sold listing of an item held again is history, so only
 * the item's live listings count.
 */
export const decideInventoryItem = ({
  snapshot,
  ...input
}: DecideListingInput): Exclude<ListingDecision, { type: 'halt' }> | null => {
  if (!snapshot.owned) return null;
  const ownListings = snapshot.ownListings.filter((listing) => isLive(listing, input.now));
  const decision = decideListing({ ...input, snapshot: { ...snapshot, ownListings } });
  return decision.type === 'halt' ? null : decision;
};
