import type { ListingSnapshot, OwnListing } from './market';
import type { ListingPricingRule, ListingTask } from './task';

const BPS = 10_000n;
const MINIMUM_REFRESH_MARGIN_MS = 2 * 60_000;

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

export type DecideListingInput = { task: ListingTask; snapshot: ListingSnapshot; now: Date };

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
        : (snapshot.lowestCompetingAsk * BigInt(Math.round(rule.percent * 100))) / BPS;
    case 'undercut':
      return snapshot.lowestCompetingAsk === null
        ? maxPrice
        : snapshot.lowestCompetingAsk - rule.amount;
  }
};

/**
 * The price the listing should sit at now: the task's rule held within `minPrice`–`maxPrice`, or
 * `null` when the rule has nothing to price from. Not rounded: listings are not price-stepped.
 */
export const targetListingPrice = (task: ListingTask, snapshot: ListingSnapshot): bigint | null => {
  const rulePrice = ruleListingPrice(task.pricing, snapshot, task.maxPrice);
  if (rulePrice === null) return null;
  return rulePrice < task.minPrice
    ? task.minPrice
    : rulePrice > task.maxPrice
      ? task.maxPrice
      : rulePrice;
};

const needsRefresh = (listing: OwnListing, task: ListingTask, now: Date) => {
  const margin = Math.max(MINIMUM_REFRESH_MARGIN_MS, task.expirationMinutes * 6_000);
  return listing.expiration.getTime() - now.getTime() <= margin;
};

/**
 * Whether a buyer can still take the listing. The API can keep an order `Active` long after its
 * expiration, which Seaport no longer fills, so the expiration decides too.
 */
const isLive = (listing: OwnListing, now: Date) =>
  listing.active && listing.expiration.getTime() > now.getTime();

/** The live listing a buyer would take: the cheapest, and of those the one that lasts longest. */
const cheapestListing = (listings: OwnListing[]) =>
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
 */
export const decideListing = ({ task, snapshot, now }: DecideListingInput): ListingDecision => {
  if (snapshot.ownListings.some((listing) => listing.executions > 0)) {
    return { type: 'halt', reason: 'filled' };
  }
  if (!snapshot.owned) return { type: 'wait', reason: 'notOwned' };
  if (!snapshot.approved) return { type: 'wait', reason: 'notApproved' };
  if (isCrossed(snapshot.lowestCompetingAsk, snapshot.bestCompetingBid)) {
    return { type: 'wait', reason: 'crossedBook' };
  }
  const price = targetListingPrice(task, snapshot);
  if (price === null) return { type: 'wait', reason: 'noPrice' };
  const live = cheapestListing(snapshot.ownListings.filter((listing) => isLive(listing, now)));
  if (!live || price < live.price) return { type: 'place', price };
  if (price > live.price) return { type: 'wait', reason: 'needsOnChainCancel', listing: live };
  return needsRefresh(live, task, now) ? { type: 'place', price } : { type: 'keep', listing: live };
};

/**
 * Decides one item of a listing task without `tokenId`, which lists every item of the collection
 * the wallet holds and never halts. `null` skips an item the wallet no longer holds (sold, moved,
 * or not yet out of the owners index). A sold listing of an item held again is history, so only
 * the item's live listings count.
 */
export const decideInventoryItem = ({
  task,
  snapshot,
  now,
}: DecideListingInput): Exclude<ListingDecision, { type: 'halt' }> | null => {
  if (!snapshot.owned) return null;
  const ownListings = snapshot.ownListings.filter((listing) => isLive(listing, now));
  const decision = decideListing({ task, snapshot: { ...snapshot, ownListings }, now });
  return decision.type === 'halt' ? null : decision;
};
