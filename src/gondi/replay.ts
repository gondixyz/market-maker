import { type Address, parseEther, zeroAddress } from 'viem';
import { z } from 'zod';

import type {
  ApiOrder,
  CollectionMarket,
  GondiApi,
  OrdersFilter,
  PriceApi,
  StatPoint,
} from './api';
import { WETH } from './market';

export const REPLAY_STEP_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
const FLOORS_PER_QUERY = 48;
const REPLAY_MAKER: Address = '0x000000000000000000000000000000000000dEaD';

/** The market at one moment: the floor and the best bid, `null` when there was none. */
export type PriceSample = { at: Date; floorPrice: bigint | null; bestBid: bigint | null };

/** A sale of one of the collection's items: `tookAsk` when a buyer took a listing, else a bid. */
export type RecordedSale = { at: Date; price: bigint; tookAsk: boolean };

/**
 * A recorded collection. `priceStep`, `saleFeeBps` and `sales` are what a backtest needs on top of
 * a replay; a history recorded before they were has them at `0n`, `0n` and none.
 */
export type ReplayCollection = Omit<CollectionMarket, 'floorPrice' | 'highestBid'> & {
  samples: PriceSample[];
  priceStep: bigint;
  saleFeeBps: bigint;
  sales: RecordedSale[];
};

/** A recorded stretch of market, what `PriceReplay` plays back. */
export type PriceHistory = {
  recordedAt: Date;
  ethUsdPrice: number;
  collections: Record<string, ReplayCollection>;
};

const address = z.string().transform((value) => value as Address);
const date = z.string().transform((value) => new Date(value));
const wei = z
  .string()
  .nullable()
  .transform((value) => (value === null ? null : BigInt(value)));
const integer = z.string().transform((value) => BigInt(value));
const priceHistory = z.object({
  recordedAt: date,
  ethUsdPrice: z.number().positive(),
  collections: z.record(
    z.string(),
    z.object({
      collectionId: z.number(),
      contractAddress: address,
      seaportConduitKey: z.string().transform((value) => value as `0x${string}`),
      royalties: z.array(
        z.object({ beneficiary: address, percentage: z.number(), required: z.boolean() }),
      ),
      samples: z
        .array(z.object({ at: date, floorPrice: wei, bestBid: wei }))
        .nonempty()
        .transform((samples) => samples.sort((first, second) => +first.at - +second.at)),
      priceStep: integer.default(0n),
      saleFeeBps: integer.default(0n),
      sales: z
        .array(z.object({ at: date, price: integer, tookAsk: z.boolean() }))
        .default([])
        .transform((sales) => sales.sort((first, second) => +first.at - +second.at)),
    }),
  ),
});

/** A history as `serializePriceHistory` wrote it. */
export const parsePriceHistory = (json: string): PriceHistory =>
  priceHistory.parse(JSON.parse(json));

/** The history as JSON, amounts as wei strings. */
export const serializePriceHistory = (history: PriceHistory) =>
  JSON.stringify(history, (_, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );

/** An amount of ETH as a float, in wei, rounded to the gwei so float noise stays out. */
const toWei = (eth: number) => parseEther(eth.toFixed(9));

/** The UTC day of a moment, the key of the API's daily series. */
const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/**
 * Each day's top bid over its floor, the latest earlier day standing in for a day with no ratio of
 * its own; `null` before the first.
 */
const bidRatioAt = (floors: StatPoint[], topBids: StatPoint[]) => {
  const dayFloors = new Map(floors.map((point) => [dayOf(point.timestamp), point.value]));
  const ratios = topBids
    .flatMap((point) => {
      const day = dayOf(point.timestamp);
      const floor = dayFloors.get(day);
      return floor ? [{ day, ratio: point.value / floor }] : [];
    })
    .sort((first, second) => first.day.localeCompare(second.day));
  return (at: Date) => ratios.findLast((entry) => entry.day <= dayOf(at))?.ratio ?? null;
};

/**
 * The collection's floor every `REPLAY_STEP_MS` from `from` to `to`, and its best bid. The API
 * keeps a floor at any moment but a top bid only per day, so each sample's best bid is its floor
 * times that day's top bid over that day's floor: it moves with the floor within the day, at the
 * day's real spread.
 */
const recordSamples = async (api: GondiApi, slug: string, from: Date, to: Date) => {
  const times = Array.from(
    { length: Math.floor((+to - +from) / REPLAY_STEP_MS) + 1 },
    (_, index) => new Date(+from + index * REPLAY_STEP_MS),
  );
  const floors: (number | null)[] = [];
  for (let start = 0; start < times.length; start += FLOORS_PER_QUERY)
    floors.push(
      ...(await api.floorPricesAt({
        slug,
        timestamps: times.slice(start, start + FLOORS_PER_QUERY),
      })),
    );
  const { floors: dailyFloors, topBids } = await api.dailyPriceHistory({
    slug,
    from: new Date(+from - DAY_MS),
    to,
  });
  const ratioAt = bidRatioAt(dailyFloors, topBids);
  return times.map((at, index): PriceSample => {
    const floor = floors[index] ?? null;
    const ratio = ratioAt(at);
    return {
      at,
      floorPrice: floor === null ? null : toWei(floor),
      bestBid: floor === null || ratio === null ? null : toWei(floor * ratio),
    };
  });
};

/** Every sale of the collection from `from` to `to` in ETH or WETH, as a backtest replays it. */
const recordSales = async (api: GondiApi, collectionId: number, from: Date, to: Date) =>
  (await api.collectionSales({ collectionId, currencies: [zeroAddress, WETH], from, to })).map(
    (sale): RecordedSale => ({
      at: sale.timestamp,
      price: sale.price,
      tookAsk: sale.originatedFromAsk,
    }),
  );

/**
 * Records the last `days` of `api`'s market for every collection of `slugs`: the floor and best bid
 * every 15 minutes, every sale, what else the bot reads off a collection (its id, contract,
 * conduit, royalties, bid price step and sale fee) and ETH's USD price as of now, which a replay
 * holds for the whole run.
 */
export const recordPriceHistory = async ({
  api,
  slugs,
  days,
  now = new Date(),
}: {
  api: GondiApi;
  slugs: string[];
  days: number;
  now?: Date;
}): Promise<PriceHistory> => {
  const to = new Date(Math.floor(+now / REPLAY_STEP_MS) * REPLAY_STEP_MS);
  const from = new Date(+to - days * DAY_MS);
  const collections: Record<string, ReplayCollection> = {};
  for (const slug of slugs) {
    const market = await api.collectionMarket({ slug, currencies: [zeroAddress, WETH] });
    collections[slug] = {
      collectionId: market.collectionId,
      contractAddress: market.contractAddress,
      seaportConduitKey: market.seaportConduitKey,
      royalties: market.royalties,
      samples: await recordSamples(api, slug, from, to),
      priceStep: await api.priceStep(market.collectionId),
      saleFeeBps: await api.saleFeeBps(market.collectionId),
      sales: await recordSales(api, market.collectionId, from, to),
    };
  }
  return { recordedAt: now, ethUsdPrice: await api.currencyUsdPrice(WETH), collections };
};

/**
 * Serves a recorded `PriceHistory` in place of the live price reads, on a clock `speed` times
 * faster than the wall clock that starts at the history's first sample when it was recorded and
 * starts over after the last. Every process replaying one file reads the same moment, since the
 * clock runs from `recordedAt` rather than from when each started.
 *
 * Each read answers with the latest sample at or before the replay time: the floor as the
 * collection's floor and its cheapest listing, the best bid as its best bid, both as orders of a
 * maker that is not the bot. ETH's USD price stays at the recording's.
 */
export class PriceReplay implements PriceApi {
  private readonly from: number;
  private readonly span: number;

  constructor(
    private readonly history: PriceHistory,
    private readonly speed: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    const times = Object.values(history.collections).flatMap((collection) =>
      collection.samples.map((sample) => +sample.at),
    );
    this.from = Math.min(...times);
    this.span = Math.max(...times) - this.from + REPLAY_STEP_MS;
  }

  /** The moment of the history being played now. */
  replayTime(): Date {
    const elapsed = Math.max(0, +this.now() - +this.history.recordedAt) * this.speed;
    return new Date(this.from + (elapsed % this.span));
  }

  async collectionMarket({ slug }: { slug: string }): Promise<CollectionMarket> {
    const collection = this.history.collections[slug];
    if (!collection) throw new Error(`invalid collection ${slug}`);
    const sample = this.sample(collection);
    return {
      collectionId: collection.collectionId,
      contractAddress: collection.contractAddress,
      seaportConduitKey: collection.seaportConduitKey,
      royalties: collection.royalties,
      floorPrice: sample.floorPrice,
      highestBid: sample.bestBid === null ? null : replayOrder(collection, sample, false),
    };
  }

  async orders(filter: OrdersFilter): Promise<{ orders: ApiOrder[]; nextCursor: string | null }> {
    const collection = Object.values(this.history.collections).find((candidate) =>
      filter.collections?.includes(candidate.collectionId),
    );
    const sample = collection && this.sample(collection);
    const isAsk = filter.side === 'ASK';
    const price = isAsk ? sample?.floorPrice : sample?.bestBid;
    return {
      orders: collection && sample && price != null ? [replayOrder(collection, sample, isAsk)] : [],
      nextCursor: null,
    };
  }

  async currencyUsdPrice(): Promise<number> {
    return this.history.ethUsdPrice;
  }

  private sample(collection: ReplayCollection) {
    const at = this.replayTime();
    return collection.samples.findLast((sample) => sample.at <= at) ?? collection.samples[0]!;
  }
}

/** The sample's floor as a listing (`isAsk`) or its best bid as a collection bid. */
const replayOrder = (
  collection: ReplayCollection,
  sample: PriceSample,
  isAsk: boolean,
): ApiOrder => ({
  __typename: isAsk ? 'SingleNFTOrder' : 'CollectionOrder',
  id: +sample.at / REPLAY_STEP_MS,
  price: (isAsk ? sample.floorPrice : sample.bestBid)!,
  steppedPrice: null,
  currencyAddress: isAsk ? zeroAddress : WETH,
  maker: REPLAY_MAKER,
  isAsk,
  status: 'OrderStatus.Active',
  startTime: sample.at,
  expiration: new Date(+sample.at + DAY_MS),
  executions: 0,
  maxExecutions: 1,
  cancelsOffChain: true,
  marketPlace: 'MarketPlace.Gondi',
  collectionId: collection.collectionId,
});
