import { formatEther } from 'viem';

import type { Fill, SaleTerms } from './market';
import type { LossLimits } from './task';

const BPS = 10_000n;
const DAY_MS = 24 * 60 * 60_000;

/** An item the wallet bought since `since` and has not sold since. */
export type Position = { slug: string; tokenId: bigint; cost: bigint };

/** A sale of an item the wallet bought since `since`, beside what it paid for it. */
export type ClosedSale = { slug: string; price: bigint; cost: bigint; timestamp: Date };

/** The wallet's trades since `since`: what it still holds and what it sold, each with its cost. */
export type Ledger = { positions: Position[]; sales: ClosedSale[] };

/** The loss over the UTC day and the ISO week, in USD, or why it could not be measured. */
export type LossReport =
  | {
      status: 'measured';
      dailyLossUsd: number;
      weeklyLossUsd: number;
      reached: boolean;
      /** Why this round's read failed, when the loss is the one an earlier round measured. */
      staleReason?: string;
    }
  | { status: 'unmeasured'; reason: string };

/** 00:00 UTC of `now`'s day. */
export const dayStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Monday 00:00 UTC of `now`'s ISO week. */
export const weekStart = (now: Date) =>
  new Date(dayStart(now).getTime() - ((now.getUTCDay() + 6) % 7) * DAY_MS);

const itemKey = (fill: Pick<Fill, 'slug' | 'tokenId'>) => `${fill.slug}#${fill.tokenId}`;

/**
 * Matches each sale since `since` with the latest buy of the same item before it. A fill before
 * `since` never counts, so an item bought earlier and sold later has no cost and is left out: the
 * ledger only knows what the bot traded.
 */
export const ledgerOf = (fills: Fill[], since: Date): Ledger => {
  const open = new Map<string, Position>();
  const sales: ClosedSale[] = [];
  const ordered = fills
    .filter((fill) => fill.timestamp >= since)
    .sort((first, second) => first.timestamp.getTime() - second.timestamp.getTime());
  for (const fill of ordered) {
    const key = itemKey(fill);
    if (fill.side === 'buy') {
      open.set(key, { slug: fill.slug, tokenId: fill.tokenId, cost: fill.price });
      continue;
    }
    const position = open.get(key);
    if (!position) continue;
    sales.push({
      slug: fill.slug,
      price: fill.price,
      cost: position.cost,
      timestamp: fill.timestamp,
    });
    open.delete(key);
  }
  return { positions: [...open.values()], sales };
};

/** The collections of `positions` and `sales`, each once. */
const slugsOf = (positions: Position[], sales: ClosedSale[]) => [
  ...new Set([...positions.map((position) => position.slug), ...sales.map((sale) => sale.slug)]),
];

/** The collections whose floor and fees the loss of `now`'s week depends on. */
export const valuedCollections = (ledger: Ledger, now: Date) =>
  slugsOf(
    ledger.positions,
    ledger.sales.filter((sale) => sale.timestamp >= weekStart(now)),
  );

/** Every collection the ledger traded, which the P&L values: `valuedCollections` and older sales. */
export const tradedCollections = (ledger: Ledger) => slugsOf(ledger.positions, ledger.sales);

/** What a sale at `price` pays the seller: the price net of royalties and fees. */
const netOf = (price: bigint, feeBps: bigint) => price - (price * feeBps) / BPS;

/** What a sale made: its price net of fees over what the item cost. */
const saleProfit = (sale: ClosedSale, feeBps: bigint) => netOf(sale.price, feeBps) - sale.cost;

/** A held item's profit if it sold at `floorPrice` today, net of fees like a sale. */
const heldProfit = (position: Position, floorPrice: bigint, feeBps: bigint) =>
  netOf(floorPrice, feeBps) - position.cost;

/**
 * A held item's `heldProfit`, never above zero: the floor can be the wallet's own listing, so a
 * paper gain would offset realized losses that nobody has paid to cover.
 */
const positionProfit = (position: Position, floorPrice: bigint, feeBps: bigint) => {
  const profit = heldProfit(position, floorPrice, feeBps);
  return profit < 0n ? profit : 0n;
};

/** A loss in wei as USD, or 0 when `lossWei` is a gain. */
const lossUsd = (lossWei: bigint, ethUsd: number) =>
  lossWei > 0n ? Number(formatEther(lossWei)) * ethUsd : 0;

/**
 * What every item still held would lose at the floor today, and what each sale since the start
 * of the week made, or why one of them cannot be valued.
 */
const valuation = (
  ledger: Ledger,
  terms: Map<string, SaleTerms>,
  now: Date,
): { reason: string } | { unrealized: bigint; sales: { profit: bigint; timestamp: Date }[] } => {
  let unrealized = 0n;
  for (const position of ledger.positions) {
    const positionTerms = terms.get(position.slug);
    if (!positionTerms || positionTerms.floorPrice === null) {
      return { reason: `no floor for ${position.slug}` };
    }
    unrealized += positionProfit(position, positionTerms.floorPrice, positionTerms.feeBps);
  }
  const sales: { profit: bigint; timestamp: Date }[] = [];
  for (const sale of ledger.sales.filter((sale) => sale.timestamp >= weekStart(now))) {
    const saleTerms = terms.get(sale.slug);
    if (!saleTerms) return { reason: `no sale terms for ${sale.slug}` };
    sales.push({ profit: saleProfit(sale, saleTerms.feeBps), timestamp: sale.timestamp });
  }
  return { unrealized, sales };
};

/**
 * The wallet's loss over `now`'s UTC day and ISO week, against `limits`. Each window's profit is
 * what its sales made, net of fees, plus what every item still held would lose at the floor today,
 * net of fees too;
 * a held item counts in both windows, so one held underwater blocks bidding until it sells or
 * recovers. Unmeasured when a held item has no floor or a sale's collection no terms: the caller
 * treats that as the cap being reached.
 */
export const lossReport = ({
  ledger,
  terms,
  ethUsd,
  now,
  limits,
}: {
  ledger: Ledger;
  terms: Map<string, SaleTerms>;
  ethUsd: number;
  now: Date;
  limits: LossLimits;
}): LossReport => {
  const valued = valuation(ledger, terms, now);
  if ('reason' in valued) return { status: 'unmeasured', reason: valued.reason };
  const lossSinceUsd = (start: Date) =>
    lossUsd(
      -valued.sales
        .filter((sale) => sale.timestamp >= start)
        .reduce((total, sale) => total + sale.profit, valued.unrealized),
      ethUsd,
    );
  const dailyLossUsd = lossSinceUsd(dayStart(now));
  const weeklyLossUsd = lossSinceUsd(weekStart(now));
  return {
    status: 'measured',
    dailyLossUsd,
    weeklyLossUsd,
    reached: dailyLossUsd >= limits.dailyUsd || weeklyLossUsd >= limits.weeklyUsd,
  };
};

/**
 * One collection's profit since `since`, in wei: `realized` is what its sales made net of fees
 * over what they cost, `unrealized` what its held items would make at the floor today, net of fees
 * and not clipped at zero, or `null` while items are held with no floor.
 */
export type CollectionPnl = { slug: string; realized: bigint; unrealized: bigint | null };

/** The wallet's profit since `since`, one entry per collection it traded, with ETH's USD price. */
export type PnlReport = { ethUsd: number; collections: CollectionPnl[] };

/**
 * The profit of every collection the ledger traded whose terms are in `terms`; one without them
 * is left out. Unlike the loss it counts every sale since `since` and a held item's paper gain
 * too: it says how the bot is doing, not when it must stop.
 */
export const pnlOf = (ledger: Ledger, terms: Map<string, SaleTerms>): CollectionPnl[] =>
  tradedCollections(ledger).flatMap((slug) => {
    const collectionTerms = terms.get(slug);
    if (!collectionTerms) return [];
    const { floorPrice, feeBps } = collectionTerms;
    const realized = ledger.sales
      .filter((sale) => sale.slug === slug)
      .reduce((total, sale) => total + saleProfit(sale, feeBps), 0n);
    const positions = ledger.positions.filter((position) => position.slug === slug);
    const unrealized =
      positions.length > 0 && floorPrice === null
        ? null
        : positions.reduce(
            (total, position) => total + heldProfit(position, floorPrice ?? 0n, feeBps),
            0n,
          );
    return [{ slug, realized, unrealized }];
  });
