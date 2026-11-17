import { percentOf } from './basisPoints';

/**
 * How far over its estimate and the current gas price a transaction's gas limit and fee cap go,
 * for a state that moves before it mines.
 */
const GAS_HEADROOM_PERCENT = 120;

/** `amount`, a gas estimate or a gas price, raised by `GAS_HEADROOM_PERCENT`. */
export const withGasHeadroom = (amount: bigint) => percentOf(amount, GAS_HEADROOM_PERCENT);
