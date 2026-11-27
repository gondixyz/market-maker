import { basisPoints, BPS, percentOf } from './basisPoints';
import type { ExitOffer } from './market';
import type { Position } from './pnl';
import type { BidExit } from './task';

const HOUR_MS = 60 * 60_000;

/**
 * The gas one sale into a collection bid is priced at before it is sent: Seaport's
 * `fulfillAdvancedOrder` with a criteria resolver and a signed-zone check stays under it.
 * `ExitSale.minProceeds` leaves the market room to refuse a sale whose real gas costs more.
 */
export const EXIT_GAS_UNITS = 250_000n;

/** Why a held item is not sold into the offer this round. */
export type ExitHoldReason =
  | 'noOffer'
  | 'unknownCost'
  | 'dailyLimit'
  | 'pendingTransaction'
  | 'gasTooHigh'
  | 'belowMinPrice'
  | 'ownBidHigher'
  | 'belowCost'
  | 'stillBidding'
  | 'lossTooLarge';

export type ExitDecision =
  | { type: 'sell'; offer: ExitOffer; minProceeds: bigint; reason: 'profit' | 'stopLoss' }
  | { type: 'hold'; reason: ExitHoldReason };

/** The least `cost` may come back as and still lose at most `maxLossPercent` of it. */
const stopLossFloor = (cost: bigint, maxLossPercent: number) =>
  cost - percentOf(cost, maxLossPercent);

/**
 * Whether to sell a held item into the best collection bid of GONDI and OpenSea this round, and the least the sale must
 * pay once its gas is paid (`minProceeds`). The proceeds are the offer's `netPrice` minus the gas
 * `EXIT_GAS_UNITS` would cost now. It sells when the proceeds are at least what the item cost
 * (`profit`), or, once the item has been held `afterHours`, when they lose at most
 * `maxLossPercent` of it (`stopLoss`). Never under the listing task's `minPrice`, never more than
 * `maxPerDay` items a UTC day, never above `maxGasGwei`, and never while a transaction of the
 * wallet's is unmined. An item with no buy in the ledger has no known cost, so it is held. It also
 * holds while the wallet's own bid on the collection, live or the one the sale would let it place
 * again, is at or above the proceeds (`ownBidHigher`), which would buy the item back for more than
 * it sold for. A stop loss also waits until the
 * collection's bids can buy no more (`bidsFull`): while they still can, the item is not sold at a
 * loss (`stillBidding`).
 */
export const decideExit = ({
  exit,
  minPrice,
  position,
  offer,
  gasPrice,
  pendingTransaction,
  ownTopBid,
  bidsFull,
  soldToday,
  now,
}: {
  exit: BidExit;
  minPrice: bigint;
  position: Position | undefined;
  offer: ExitOffer | null;
  gasPrice: bigint;
  pendingTransaction: boolean;
  /**
   * The most the wallet's own bids on the collection pay, on any venue, live or bid again once
   * the sale makes room; `null` without one.
   */
  ownTopBid: bigint | null;
  /** Whether no bid task on the collection can buy another item (halted, full, or capped). */
  bidsFull: boolean;
  soldToday: number;
  now: Date;
}): ExitDecision => {
  if (!offer) return { type: 'hold', reason: 'noOffer' };
  if (!position) return { type: 'hold', reason: 'unknownCost' };
  if (soldToday >= exit.maxPerDay) return { type: 'hold', reason: 'dailyLimit' };
  if (pendingTransaction) return { type: 'hold', reason: 'pendingTransaction' };
  if (gasPrice > BigInt(Math.round(exit.maxGasGwei * 1e9)))
    return { type: 'hold', reason: 'gasTooHigh' };
  const proceeds = offer.netPrice - gasPrice * EXIT_GAS_UNITS;
  if (proceeds < minPrice) return { type: 'hold', reason: 'belowMinPrice' };
  if (ownTopBid !== null && ownTopBid >= proceeds) return { type: 'hold', reason: 'ownBidHigher' };
  const atLeast = (floor: bigint) => (floor > minPrice ? floor : minPrice);
  if (proceeds >= position.cost) {
    return { type: 'sell', offer, minProceeds: atLeast(position.cost), reason: 'profit' };
  }
  if (!bidsFull) return { type: 'hold', reason: 'stillBidding' };
  if (now.getTime() - position.boughtAt.getTime() < exit.afterHours * HOUR_MS) {
    return { type: 'hold', reason: 'belowCost' };
  }
  const floor = stopLossFloor(position.cost, exit.maxLossPercent);
  if (proceeds < floor) return { type: 'hold', reason: 'lossTooLarge' };
  return { type: 'sell', offer, minProceeds: atLeast(floor), reason: 'stopLoss' };
};

/**
 * The price of a `resaleBid` offer: the most it may pay for an item and still make `marginPercent`
 * of that price when `decideExit` sells the item into `offer` at once, `offer`'s fees and the
 * sale's gas at `gasPrice` taken out, rounded down onto `priceStep`. Never at or above `floorPrice`,
 * where buying the cheapest listing would cost less, nor above `maxPrice`. `null` with no offer,
 * while `bidExit` would not sell (gas above its `maxGasGwei`), or when no step above zero fits.
 */
export const resalePrice = ({
  offer,
  gasPrice,
  maxGasGwei,
  marginPercent,
  floorPrice,
  maxPrice,
  priceStep,
}: {
  offer: ExitOffer | null;
  gasPrice: bigint;
  maxGasGwei: number;
  marginPercent: number;
  floorPrice: bigint | null;
  maxPrice: bigint;
  priceStep: bigint;
}): bigint | null => {
  if (!offer || gasPrice > BigInt(Math.round(maxGasGwei * 1e9))) return null;
  const proceeds = offer.netPrice - gasPrice * EXIT_GAS_UNITS;
  const profitable = (proceeds * BPS) / (BPS + basisPoints(marginPercent));
  const belowFloor =
    floorPrice === null ? profitable : floorPrice - (priceStep > 0n ? priceStep : 1n);
  const capped = [profitable, belowFloor, maxPrice].reduce((lowest, price) =>
    price < lowest ? price : lowest,
  );
  const stepped = priceStep > 0n ? capped - (capped % priceStep) : capped;
  return stepped > 0n ? stepped : null;
};
