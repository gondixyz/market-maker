import { basisPoints, BPS } from './basisPoints';

const HOUR_MS = 60 * 60_000;
/** How finely the smoothing weight is kept: millionths, plenty for a price in wei. */
const WEIGHT_SCALE = 1_000_000n;

/** A task's smoothed price: an exponential moving average of the prices it read, and when it last read one. */
export type ReferencePrice = { price: bigint; at: Date };

/**
 * `previous` moved toward `sample`, read at `at`, by the share of the way an exponential moving
 * average with `halfLifeHours` moves in the time since `previous`: half of it after one half-life.
 * The first sample is the average itself; a sample read no later than `previous` leaves it as it is.
 */
export const nextReference = (
  previous: ReferencePrice | undefined,
  sample: bigint,
  at: Date,
  halfLifeHours: number,
): ReferencePrice => {
  if (!previous) return { price: sample, at };
  const elapsedMs = at.getTime() - previous.at.getTime();
  if (elapsedMs <= 0) return previous;
  const weight = BigInt(
    Math.round((1 - 0.5 ** (elapsedMs / (halfLifeHours * HOUR_MS))) * Number(WEIGHT_SCALE)),
  );
  return { price: previous.price + ((sample - previous.price) * weight) / WEIGHT_SCALE, at };
};

/** `price` less `percent` of it. */
export const belowBy = (price: bigint, percent: number) =>
  (price * (BPS - basisPoints(percent))) / BPS;

/** `price` plus `percent` of it, rounded up so it never lands under that share. */
export const aboveBy = (price: bigint, percent: number) =>
  (price * (BPS + basisPoints(percent)) + BPS - 1n) / BPS;
