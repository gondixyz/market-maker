import { isCrossed } from './listing';
import type { BidSnapshot, OwnBid } from './market';
import { ladderPrices } from './pricing';
import type { BidTask } from './task';

const MINIMUM_REFRESH_MARGIN_MS = 2 * 60_000;

export type HaltReason = 'filled' | 'floorMoved';
export type WaitReason =
  | 'noPrice'
  | 'maxItemsHeld'
  | 'maxHeldValue'
  | 'insufficientBalance'
  | 'insufficientAllowance'
  | 'exposureLimit'
  | 'lossLimit'
  | 'crossedBook';

/** An offer to place: its price and how many items it may buy. */
export type Placement = { price: bigint; quantity: number };

/**
 * What to do with a task's bids this round. Every variant names the wallet's bids to cancel, so a
 * decision is carried out the same way whatever it is: place first (when it places), then cancel.
 * A `bid` keeps the task's offers that already sit where they should and places the missing ones.
 */
export type Decision = { cancel: OwnBid[] } & (
  | { type: 'bid'; keep: OwnBid[]; place: Placement[] }
  | { type: 'wait'; reason: WaitReason }
  | { type: 'halt'; reason: HaltReason }
);

export type ReconcileInput = {
  task: BidTask;
  snapshot: BidSnapshot;
  now: Date;
  /** The floor when the task started, what `haltOnFloorMovePercent` is measured against. */
  referenceFloor: bigint | null;
  /** How much the task's bid may commit, after every other task's live bid. */
  exposureAvailable: bigint;
  /** Whether the wallet's loss reached a cap of `lossLimits`, or could not be measured. */
  lossLimitReached: boolean;
};

const floorMoved = (task: BidTask, floor: bigint | null, referenceFloor: bigint | null) => {
  if (task.haltOnFloorMovePercent === undefined || floor === null || !referenceFloor) return false;
  const movedBps =
    ((floor > referenceFloor ? floor - referenceFloor : referenceFloor - floor) * 10_000n) /
    referenceFloor;
  return movedBps > BigInt(Math.round(task.haltOnFloorMovePercent * 100));
};

const waitReason = (
  commitment: bigint,
  snapshot: BidSnapshot,
  exposureAvailable: bigint,
): WaitReason | null => {
  if (snapshot.balance < commitment) return 'insufficientBalance';
  if (snapshot.allowance < commitment) return 'insufficientAllowance';
  if (exposureAvailable < commitment) return 'exposureLimit';
  return null;
};

/** How many more items `bid` may still buy. */
export const remaining = (bid: OwnBid) => bid.maxExecutions - bid.executions;

/** Newest first: by when each bid was placed, and by id between two placed in the same second. */
const byNewest = (first: OwnBid, second: OwnBid) =>
  second.placedAt.getTime() - first.placedAt.getTime() ||
  second.id.localeCompare(first.id, 'en', { numeric: true });

/** The bids of `bids` the marketplace takes an off-chain cancel of at `now`. */
const cancellableAt = (bids: OwnBid[], now: Date) =>
  bids.filter((bid) => bid.cancellableFrom === undefined || bid.cancellableFrom <= now);

/** Whether a fill leaves the task bidding, held back by what the wallet holds instead. */
const keepsBiddingAfterFills = (task: BidTask) =>
  task.maxItems !== undefined || task.maxHeldValue !== undefined;

/**
 * How many items the task's bid should buy now, before `maxHeldValue`: what is left of `quantity`
 * after its fills, or, when fills do not halt it, `quantity`, at most what `maxItems` still allows.
 */
const wantedQuantity = (task: BidTask, snapshot: BidSnapshot) => {
  if (!keepsBiddingAfterFills(task)) {
    return task.quantity - snapshot.ownBids.reduce((total, bid) => total + bid.executions, 0);
  }
  return task.maxItems === undefined
    ? task.quantity
    : Math.min(task.quantity, task.maxItems - snapshot.held);
};

/**
 * How many items at `price` fit under `maxHeldValue` beside what the wallet already holds, valued
 * at the floor. `null` when it holds items but there is no floor to value them at.
 */
const valueCappedQuantity = (
  maxHeldValue: bigint,
  snapshot: BidSnapshot,
  price: bigint,
  quantity: number,
): number | null => {
  if (snapshot.held > 0 && snapshot.floorPrice === null) return null;
  const room = maxHeldValue - BigInt(snapshot.held) * (snapshot.floorPrice ?? 0n);
  if (room <= 0n) return 0;
  return price === 0n ? quantity : Math.min(quantity, Number(room / price));
};

const needsRefresh = (bid: OwnBid, task: BidTask, now: Date) => {
  const margin = Math.max(MINIMUM_REFRESH_MARGIN_MS, task.expirationMinutes * 6_000);
  return bid.expiration.getTime() - now.getTime() <= margin;
};

/**
 * The `bid` decision for offers at `prices`, each for `quantity` items: each price keeps the newest
 * active bid at it for that quantity that is not near expiry, and places one otherwise; every other
 * active bid is cancelled. While one of those the marketplace will not cancel yet is up, nothing is
 * placed: the task keeps it beside the matched bids and cancels only what it can.
 */
const bidDecision = (
  prices: bigint[],
  quantity: number,
  activeBids: OwnBid[],
  task: BidTask,
  now: Date,
): Decision => {
  const newestFirst = [...activeBids].sort(byNewest);
  const keep = prices.flatMap(
    (price) =>
      newestFirst.find(
        (bid) =>
          bid.price === price && remaining(bid) === quantity && !needsRefresh(bid, task, now),
      ) ?? [],
  );
  const offLadder = activeBids.filter((bid) => !keep.includes(bid));
  const withdrawable = cancellableAt(offLadder, now);
  if (withdrawable.length < offLadder.length) {
    const locked = offLadder.filter((bid) => !withdrawable.includes(bid));
    return { type: 'bid', keep: [...keep, ...locked], place: [], cancel: withdrawable };
  }
  const place = prices
    .filter((price) => !keep.some((bid) => bid.price === price))
    .map((price) => ({ price, quantity }));
  return { type: 'bid', keep, place, cancel: offLadder };
};

/**
 * Decides what a task does with its bids this round, from one snapshot. Pure: the runner carries
 * the decision out. Buying the whole `quantity` or a floor move halts the task; with `maxItems` or
 * `maxHeldValue` a fill does not, and the task withdraws its bid only while the wallet holds that
 * many items, or items worth that much at the floor with no room for one more at the bid, and
 * while the wallet's loss is at a cap of `lossLimits` (`lossLimitReached`), or while the floor sits
 * under the best competing bid (`crossedBook`), as a dust floor would have it value held items at
 * nothing and cap the bid at nothing; a crossed floor never counts as a floor move. A bid
 * that cannot be priced or paid for is withdrawn rather than left at a stale price; otherwise the
 * task keeps exactly one active bid per `ladderPrices` price (one without a `ladder`) for what it
 * still wants to buy, replaced when either changes or the bid nears expiry. The quantity, balance
 * and exposure checks price the top offer alone, as the offers share its WETH. A bid the
 * marketplace will not cancel yet (`cancellableFrom`) is left up: while one is off the ladder, the
 * task places nothing beside it, and a wait cancels only the bids it can, so a later round
 * withdraws the rest.
 * A halt still names every active bid, since a halted task gets no later round to withdraw them.
 */
export const reconcile = ({
  task,
  snapshot,
  now,
  referenceFloor,
  exposureAvailable,
  lossLimitReached,
}: ReconcileInput): Decision => {
  const activeBids = snapshot.ownBids.filter((bid) => bid.active);
  const withdrawable = cancellableAt(activeBids, now);
  const wanted = wantedQuantity(task, snapshot);
  if (!keepsBiddingAfterFills(task) && wanted <= 0) {
    return { type: 'halt', reason: 'filled', cancel: activeBids };
  }
  if (isCrossed(snapshot.floorPrice, snapshot.bestCompetingBid)) {
    return { type: 'wait', reason: 'crossedBook', cancel: withdrawable };
  }
  if (floorMoved(task, snapshot.floorPrice, referenceFloor)) {
    return { type: 'halt', reason: 'floorMoved', cancel: activeBids };
  }
  if (lossLimitReached) return { type: 'wait', reason: 'lossLimit', cancel: withdrawable };
  if (wanted <= 0) return { type: 'wait', reason: 'maxItemsHeld', cancel: withdrawable };
  const prices = ladderPrices(task, snapshot);
  const price = prices.at(0) ?? null;
  const quantity =
    price === null || task.maxHeldValue === undefined
      ? wanted
      : valueCappedQuantity(task.maxHeldValue, snapshot, price, wanted);
  if (price === null || quantity === null) {
    return { type: 'wait', reason: 'noPrice', cancel: withdrawable };
  }
  if (quantity <= 0) return { type: 'wait', reason: 'maxHeldValue', cancel: withdrawable };
  const reason = waitReason(price * BigInt(quantity), snapshot, exposureAvailable);
  if (reason) return { type: 'wait', reason, cancel: withdrawable };
  return bidDecision(prices, quantity, activeBids, task, now);
};
