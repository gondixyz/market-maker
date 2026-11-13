import type { BidSnapshot } from './market';
import type { BidTask, PricingRule } from './task';

const BPS = 10_000n;

const floorToStep = (price: bigint, step: bigint) => (step > 0n ? price - (price % step) : price);

const ceilToStep = (price: bigint, step: bigint) => {
  const floored = floorToStep(price, step);
  return floored === price ? price : floored + step;
};

const basisPoints = (percent: number) => BigInt(Math.round(percent * 100));

/** `percent` of `amount`, rounded down to the wei. */
const percentOf = (amount: bigint, percent: number) => (amount * basisPoints(percent)) / BPS;

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

/**
 * The most the task may bid: `maxPrice`, or less under `maxFloorPercent` of the floor. `null` when
 * `maxFloorPercent` is set and there is no floor to measure it against.
 */
const bidCeiling = (task: BidTask, floorPrice: bigint | null) => {
  if (task.maxFloorPercent === undefined) return task.maxPrice;
  if (floorPrice === null) return null;
  const floorShare = percentOf(floorPrice, task.maxFloorPercent);
  return floorShare < task.maxPrice ? floorShare : task.maxPrice;
};

/**
 * The price a bid should sit at now: the task's rule, rounded down onto the marketplace's price
 * step and held between `minPrice` and the lower of `maxPrice` and `maxFloorPercent` of the floor.
 * `null` when there is nothing to price from (no floor yet, for a floor rule or a floor cap, or
 * fewer competing price levels than a level rule names) or no step lies within the limits.
 */
export const targetBidPrice = (task: BidTask, snapshot: BidSnapshot): bigint | null => {
  const rulePrice = ruleBidPrice(task.pricing, snapshot, task.minPrice);
  const ceiling = bidCeiling(task, snapshot.floorPrice);
  if (rulePrice === null || ceiling === null) return null;
  const lowest = ceilToStep(task.minPrice, snapshot.priceStep);
  const highest = floorToStep(ceiling, snapshot.priceStep);
  if (lowest > highest) return null;
  const stepped = floorToStep(rulePrice, snapshot.priceStep);
  return stepped < lowest ? lowest : stepped > highest ? highest : stepped;
};

/**
 * The prices a task's offers should sit at now, best first: the `targetBidPrice` and, with a
 * `ladder`, its other offers on the highest multiples of `spacing` strictly below it, rounded down
 * onto the price step, without repeats and none under `minPrice`. Lower offers stay on the same
 * grid while the top price moves within one spacing, so such a move replaces only the top offer.
 * Empty when there is no target price.
 */
export const ladderPrices = (task: BidTask, snapshot: BidSnapshot): bigint[] => {
  const top = targetBidPrice(task, snapshot);
  if (top === null) return [];
  if (!task.ladder) return [top];
  const { offers, spacing } = task.ladder;
  const highestBelowTop = top - 1n - ((top - 1n) % spacing);
  const lowest = ceilToStep(task.minPrice, snapshot.priceStep);
  const lower = Array.from({ length: offers - 1 }, (_, index) =>
    floorToStep(highestBelowTop - BigInt(index) * spacing, snapshot.priceStep),
  ).filter((price) => price > 0n && price >= lowest && price < top);
  return [top, ...new Set(lower)];
};
