/** One whole in basis points: 100% is 10,000 bps. */
export const BPS = 10_000n;

/** `percent` in basis points, rounded to the nearest one: 2.5 becomes 250n. */
export const basisPoints = (percent: number) => BigInt(Math.round(percent * 100));

/** `percent` of `amount`, rounded down to the wei. */
export const percentOf = (amount: bigint, percent: number) => (amount * basisPoints(percent)) / BPS;
