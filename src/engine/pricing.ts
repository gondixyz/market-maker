import { basisPoints, BPS, percentOf } from './basisPoints';
import type { BidSnapshot } from './market';
import { belowBy } from './reference';
import type { BidTask, PricingRule } from './task';

const floorToStep = (price: bigint, step: bigint) => (step > 0n ? price - (price % step) : price);

const ceilToStep = (price: bigint, step: bigint) => {
  const floored = floorToStep(price, step);
  return floored === price ? price : floored + step;
};

/**
 * `percent` above the best competing bid, rounded up onto the step so rounding never takes it
 * below that share, and at least one step above the bid so a small share still outbids it.
 */
const outbidByPercent = (bestCompetingBid: bigint, percent: number, step: bigint) => {
  const raised = (bestCompetingBid * (BPS + basisPoints(percent)) + BPS - 1n) / BPS;
  const stepped = ceilToStep(raised, step);
  const nextStep = bestCompetingBid + step;
  return stepped > nextStep ? stepped : nextStep;
};

/**
 * The `steps`-th price step strictly below the floor: one step is the highest price a bid can take
 * without reaching the cheapest listing. Without a price step it is the floor itself.
 */
const stepsBelowFloor = (floorPrice: bigint, steps: number, step: bigint) =>
  ceilToStep(floorPrice, step) - step * BigInt(steps);

const ruleBidPrice = (rule: PricingRule, snapshot: BidSnapshot, minPrice: bigint) => {
  switch (rule.mode) {
    case 'fixed':
      return rule.price;
    case 'floor':
      if (snapshot.floorPrice === null) return null;
      return rule.percent === undefined
        ? stepsBelowFloor(snapshot.floorPrice, rule.steps, snapshot.priceStep)
        : percentOf(snapshot.floorPrice, rule.percent);
    case 'outbid':
      if (snapshot.bestCompetingBid === null) return minPrice;
      return rule.percent === undefined
        ? snapshot.bestCompetingBid + snapshot.priceStep * BigInt(rule.steps)
        : outbidByPercent(snapshot.bestCompetingBid, rule.percent, snapshot.priceStep);
    case 'level':
      return snapshot.competingBidLevels?.[rule.level - 1] ?? null;
  }
};

const lowestOf = (prices: bigint[]) =>
  prices.reduce((lowest, price) => (price < lowest ? price : lowest));

/**
 * The most the task may bid: `maxPrice`, or less under `maxFloorPercent` of the floor, under its
 * `reference`'s `belowPercent` below `referencePrice`, and, with `behindGondi`, under a best
 * competing bid on GONDI by its `percent` and at least one price step. `null` when
 * `maxFloorPercent` is set and there is no floor to measure it against.
 */
const bidCeiling = (task: BidTask, snapshot: BidSnapshot, referencePrice: bigint | null) => {
  const { floorPrice, bestCompetingBid, priceStep } = snapshot;
  if (task.maxFloorPercent !== undefined && floorPrice === null) return null;
  const caps = [task.maxPrice];
  if (task.maxFloorPercent !== undefined && floorPrice !== null) {
    caps.push(percentOf(floorPrice, task.maxFloorPercent));
  }
  if (task.reference && referencePrice !== null) {
    caps.push(belowBy(referencePrice, task.reference.belowPercent));
  }
  if (task.behindGondi && snapshot.bestCompetingBidOnGondi && bestCompetingBid !== null) {
    caps.push(
      lowestOf([belowBy(bestCompetingBid, task.behindGondi.percent), bestCompetingBid - priceStep]),
    );
  }
  return lowestOf(caps);
};

/**
 * The price a bid should sit at now: the task's rule, rounded down onto the marketplace's price
 * step and held between `minPrice` and the `bidCeiling`, which `referencePrice`, the task's
 * smoothed floor, lowers with a `reference`. `null` when there is nothing to price from (no floor
 * yet, for a floor rule or a floor cap, or fewer competing price levels than a level rule names)
 * or no step lies within the limits.
 */
export const targetBidPrice = (
  task: BidTask,
  snapshot: BidSnapshot,
  referencePrice: bigint | null = null,
): bigint | null => {
  const rulePrice = ruleBidPrice(task.pricing, snapshot, task.minPrice);
  const ceiling = bidCeiling(task, snapshot, referencePrice);
  if (rulePrice === null || ceiling === null) return null;
  const lowest = ceilToStep(task.minPrice, snapshot.priceStep);
  const highest = floorToStep(ceiling, snapshot.priceStep);
  if (lowest > highest) return null;
  const stepped = floorToStep(rulePrice, snapshot.priceStep);
  return stepped < lowest ? lowest : stepped > highest ? highest : stepped;
};

/**
 * The prices a task's offers should sit at now, best first: the `targetBidPrice` and, with a
 * `ladder`, its other offers on the multiples of `spacing` from at least one spacing below it, rounded down
 * onto the price step, without repeats and none under `minPrice`. Lower offers stay on the same
 * grid while the top price moves within one spacing, so such a move replaces only the top offer.
 * Empty when there is no target price. `referencePrice` is the task's smoothed floor, for a
 * `reference`.
 */
export const ladderPrices = (
  task: BidTask,
  snapshot: BidSnapshot,
  referencePrice: bigint | null = null,
): bigint[] => {
  const top = targetBidPrice(task, snapshot, referencePrice);
  if (top === null) return [];
  if (!task.ladder) return [top];
  const { offers, spacing } = task.ladder;
  const oneSpacingBelowTop = top - spacing;
  const highestBelowTop = oneSpacingBelowTop - (oneSpacingBelowTop % spacing);
  const lowest = ceilToStep(task.minPrice, snapshot.priceStep);
  const lower = Array.from({ length: offers - 1 }, (_, index) =>
    floorToStep(highestBelowTop - BigInt(index) * spacing, snapshot.priceStep),
  ).filter((price) => price > 0n && price >= lowest && price < top);
  return [top, ...new Set(lower)];
};
