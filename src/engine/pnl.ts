import { formatEther } from 'viem';

import { BPS, percentOf } from './basisPoints';
import type { Fill, SaleTerms } from './market';
import type { LossLimits } from './task';

const DAY_MS = 24 * 60 * 60_000;

/** An item the wallet bought since `since` and has not sold since, and when it bought it. */
export type Position = { slug: string; tokenId: bigint; cost: bigint; boughtAt: Date };

/** A sale of an item the wallet bought since `since`, beside what it paid for it and when. */
export type ClosedSale = {
  slug: string;
  price: bigint;
  cost: bigint;
  boughtAt: Date;
  timestamp: Date;
};

/** The wallet's trades since `since`: what it still holds and what it sold, each with its cost. */
export type Ledger = { positions: Position[]; sales: ClosedSale[] };

/**
 * One collection's loss over the UTC day and the ISO week, in wei, against its caps of
 * `lossLimits.perCollection` (`null` without them, or with neither a floor nor a minimum).
 */
export type CollectionLoss = {
  slug: string;
  dailyLoss: bigint;
  weeklyLoss: bigint;
  dailyLimit: bigint | null;
  weeklyLimit: bigint | null;
  /** Whether its bid tasks stop: a loss at a cap, or a loss with no floor to set the caps. */
  reached: boolean;
};

/**
 * The loss over the UTC day and the ISO week, in USD for the wallet and in wei for each collection
 * it traded this week, or why it could not be measured.
 */
export type LossReport =
  | {
      status: 'measured';
      dailyLossUsd: number;
      weeklyLossUsd: number;
      /** Whether the wallet's loss is at a cap of `dailyUsd` or `weeklyUsd`: every bid stops. */
      reached: boolean;
      collections: CollectionLoss[];
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
      open.set(key, {
        slug: fill.slug,
        tokenId: fill.tokenId,
        cost: fill.price,
        boughtAt: fill.timestamp,
      });
      continue;
    }
    const position = open.get(key);
    if (!position) continue;
    sales.push({
      slug: fill.slug,
      price: fill.price,
      cost: position.cost,
      boughtAt: position.boughtAt,
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

/**
 * The collections whose window floors `lossReport` would use: those of an item held, or sold this
 * week, that the wallet bought before today began.
 */
export const carriedCollections = (ledger: Ledger, now: Date) => {
  const today = dayStart(now);
  return slugsOf(
    ledger.positions.filter((position) => position.boughtAt < today),
    ledger.sales.filter((sale) => sale.timestamp >= weekStart(now) && sale.boughtAt < today),
  );
};

/** Every collection the ledger traded, which the P&L values: `valuedCollections` and older sales. */
export const tradedCollections = (ledger: Ledger) => slugsOf(ledger.positions, ledger.sales);

/** What a sale at `price` pays the seller: the price net of royalties and fees. */
const netOf = (price: bigint, feeBps: bigint) => price - (price * feeBps) / BPS;

/** What a sale made: its price net of fees over what the item cost. */
const saleProfit = (sale: ClosedSale, feeBps: bigint) => netOf(sale.price, feeBps) - sale.cost;

/** A held item's profit if it sold at `floorPrice` today, net of fees like a sale. */
const heldProfit = (position: Position, floorPrice: bigint, feeBps: bigint) =>
  netOf(floorPrice, feeBps) - position.cost;

/** The loss windows: the UTC day and the ISO week. */
type Window = 'day' | 'week';

/** Each window's value of one thing, such as its floor when the window started. */
export type PerWindow<Value> = Record<Window, Value>;

/** When each window of `now` started. */
const windowStarts = (now: Date): PerWindow<Date> => ({ day: dayStart(now), week: weekStart(now) });

/**
 * What an item counts as worth when a window starts: its cost when bought in the window, or with
 * no floor of that moment; otherwise selling it at that floor, net of fees, but never more than it
 * cost, so a paper gain that fades in the window is no loss. So what it lost before the window is
 * left out, and a carried loss does not block the next day.
 */
const startValue = (
  item: { cost: bigint; boughtAt: Date },
  start: Date,
  startFloor: bigint | null | undefined,
  feeBps: bigint,
) => {
  if (item.boughtAt >= start || startFloor === null || startFloor === undefined) return item.cost;
  const value = netOf(startFloor, feeBps);
  return value < item.cost ? value : item.cost;
};

/** A loss in wei as USD, or 0 when `lossWei` is a gain. */
const lossUsd = (lossWei: bigint, ethUsd: number) =>
  lossWei > 0n ? Number(formatEther(lossWei)) * ethUsd : 0;

/** What a held item or a sale this week made in each window, in wei, by collection. */
type Valued = { slug: string; profit: PerWindow<bigint> };

/**
 * What every item still held lost in each window at the floor today, never a gain, since the floor
 * can be the wallet's own listing, and what each sale in a window made in it, both against the
 * item's `startValue` with `windowFloors`, or why one of them cannot be valued.
 */
const valuation = (
  ledger: Ledger,
  terms: Map<string, SaleTerms>,
  windowFloors: Map<string, PerWindow<bigint | null>>,
  now: Date,
): { reason: string } | { valued: Valued[] } => {
  const starts = windowStarts(now);
  const valued: Valued[] = [];
  for (const position of ledger.positions) {
    const positionTerms = terms.get(position.slug);
    if (!positionTerms || positionTerms.floorPrice === null) {
      return { reason: `no floor for ${position.slug}` };
    }
    const { floorPrice, feeBps } = positionTerms;
    const heldIn = (window: Window) => {
      const start = startValue(
        position,
        starts[window],
        windowFloors.get(position.slug)?.[window],
        feeBps,
      );
      const profit = netOf(floorPrice, feeBps) - start;
      return profit < 0n ? profit : 0n;
    };
    valued.push({ slug: position.slug, profit: { day: heldIn('day'), week: heldIn('week') } });
  }
  for (const sale of ledger.sales.filter((sale) => sale.timestamp >= starts.week)) {
    const saleTerms = terms.get(sale.slug);
    if (!saleTerms) return { reason: `no sale terms for ${sale.slug}` };
    const soldIn = (window: Window) =>
      sale.timestamp < starts[window]
        ? 0n
        : netOf(sale.price, saleTerms.feeBps) -
          startValue(sale, starts[window], windowFloors.get(sale.slug)?.[window], saleTerms.feeBps);
    valued.push({ slug: sale.slug, profit: { day: soldIn('day'), week: soldIn('week') } });
  }
  return { valued };
};

/** The loss of `valued` in `window`, in wei: what it lost, or 0 when it gained. */
const lossIn = (valued: Valued[], window: Window) => {
  const profit = valued.reduce((total, entry) => total + entry.profit[window], 0n);
  return profit < 0n ? -profit : 0n;
};

/**
 * A collection's cap: `percent` of `floorPrice` or `minimum`, whichever is larger, in wei; only
 * `minimum` without a floor, and `null` with neither.
 */
const capOf = (floorPrice: bigint | null, percent: number, minimum: bigint | undefined) => {
  const share = floorPrice === null ? null : percentOf(floorPrice, percent);
  if (minimum === undefined) return share;
  return share === null || share < minimum ? minimum : share;
};

/** Whether `loss` reached `limit`; a loss with no limit to hold it to counts as reached. */
const atLimit = (loss: bigint, limit: bigint | null) =>
  loss > 0n && (limit === null || loss >= limit);

/**
 * Each collection's loss in `valued`, against its caps (`capOf`) from its floor in `terms`. Without
 * `perCollection` its limits are `null` and it never counts as reached.
 */
const collectionLosses = (
  valued: Valued[],
  terms: Map<string, SaleTerms>,
  perCollection: LossLimits['perCollection'],
): CollectionLoss[] =>
  [...new Set(valued.map((entry) => entry.slug))].map((slug) => {
    const entries = valued.filter((entry) => entry.slug === slug);
    const dailyLoss = lossIn(entries, 'day');
    const weeklyLoss = lossIn(entries, 'week');
    if (!perCollection) {
      return { slug, dailyLoss, weeklyLoss, dailyLimit: null, weeklyLimit: null, reached: false };
    }
    const floorPrice = terms.get(slug)?.floorPrice ?? null;
    const dailyLimit = capOf(
      floorPrice,
      perCollection.dailyFloorPercent,
      perCollection.minDailyEth,
    );
    const weeklyLimit = capOf(
      floorPrice,
      perCollection.weeklyFloorPercent,
      perCollection.minWeeklyEth,
    );
    return {
      slug,
      dailyLoss,
      weeklyLoss,
      dailyLimit,
      weeklyLimit,
      reached: atLimit(dailyLoss, dailyLimit) || atLimit(weeklyLoss, weeklyLimit),
    };
  });

/**
 * The wallet's loss over `now`'s UTC day and ISO week, against `limits`, and each collection's.
 * Each window counts only what was lost in it: what its sales made, net of fees, plus what every
 * item still held would lose at the floor today, net of fees too, each against what the item was
 * worth when the window started (`startValue`, from `windowFloors`, each collection's floor at
 * the start of the day and of the week). An item bought earlier and still underwater counts only
 * its further fall, so a loss carried from yesterday does not stop today's bids; without its
 * window floor it counts against its cost, the whole loss. Unmeasured when a held item has no
 * floor or a sale's collection no terms: the caller treats that as every cap being reached.
 */
export const lossReport = ({
  ledger,
  terms,
  ethUsd,
  now,
  limits,
  windowFloors = new Map(),
}: {
  ledger: Ledger;
  terms: Map<string, SaleTerms>;
  ethUsd: number;
  now: Date;
  limits: LossLimits;
  windowFloors?: Map<string, PerWindow<bigint | null>>;
}): LossReport => {
  const result = valuation(ledger, terms, windowFloors, now);
  if ('reason' in result) return { status: 'unmeasured', reason: result.reason };
  const dailyLossUsd = lossUsd(lossIn(result.valued, 'day'), ethUsd);
  const weeklyLossUsd = lossUsd(lossIn(result.valued, 'week'), ethUsd);
  return {
    status: 'measured',
    dailyLossUsd,
    weeklyLossUsd,
    reached:
      (limits.dailyUsd !== undefined && dailyLossUsd >= limits.dailyUsd) ||
      (limits.weeklyUsd !== undefined && weeklyLossUsd >= limits.weeklyUsd),
    collections: collectionLosses(result.valued, terms, limits.perCollection),
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
