import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { parseEther, zeroAddress } from 'viem';

import { priceApiFrom } from '../src/cli/environment';
import { GondiApi } from '../src/gondi/api';
import { WETH } from '../src/gondi/market';
import {
  parsePriceHistory,
  type PriceHistory,
  PriceReplay,
  recordPriceHistory,
  serializePriceHistory,
} from '../src/gondi/replay';

const NOW = new Date('2026-11-05T12:07:00Z');
const MARKET = {
  id: '7',
  seaportConduitKey: '0x00',
  contractData: { contractAddress: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d' },
  royalties: [
    { beneficiary: '0xa858ddc0445d8131dac4d1de01f834ffcba52ef1', percentage: 2.5, required: true },
  ],
  statistics: { minAskPrice: { amount: '1' }, highestApplicableBid: null },
};

/** A fake lending API: the floor at a moment is 10 ETH plus its hour of the day, bids at 90%. */
const fakeApi = (bidDays = ['2026-11-04', '2026-11-05']) => {
  const queries: string[] = [];
  const post = (async (_url: string, init: RequestInit) => {
    const { query } = JSON.parse(init.body as string) as { query: string };
    queries.push(query);
    const respond = (data: object) => new Response(JSON.stringify({ data }));
    if (query.includes('query collectionMarket')) return respond({ collection: MARKET });
    if (query.includes('query priceStep')) return respond({ steps: { wethStep: '1000' } });
    if (query.includes('query saleFees')) return respond({ fees: [{ bps: '50' }] });
    if (query.includes('query collectionSales'))
      return respond({
        sales: {
          edges: [
            {
              node: {
                price: '21',
                timestamp: '2026-11-05T09:00:00+00:00',
                originatedFromAsk: true,
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
    if (query.includes('query currencyUsdPrice'))
      return respond({ currency: { currentUsdcPrice: 3200.5 } });
    if (query.includes('query dailyPriceHistory')) {
      const days = ['2026-11-04', '2026-11-05'].map((day) => `${day}T00:00:00+00:00`);
      return respond({
        collection: {
          statistics: {
            floorPriceHistory: days.map((timestamp) => ({ timestamp, value: 20 })),
            topBidHistory: bidDays.map((day) => ({
              timestamp: `${day}T00:00:00+00:00`,
              value: 18,
            })),
          },
        },
      });
    }
    const statistics = Object.fromEntries(
      [...query.matchAll(/(f\d+): floorPriceAt\(timestamp: "([^"]+)"\)/g)].map(([, alias, at]) => [
        alias,
        10 + new Date(at!).getUTCHours(),
      ]),
    );
    return respond({ collection: { statistics } });
  }) as unknown as typeof fetch;
  return { api: new GondiApi('https://api.test', post), queries };
};

const history = (): PriceHistory => ({
  recordedAt: NOW,
  ethUsdPrice: 3000,
  collections: {
    boredapeyachtclub: {
      collectionId: 7,
      contractAddress: zeroAddress,
      seaportConduitKey: '0x00',
      royalties: [],
      samples: [
        { at: new Date('2026-11-04T00:00:00Z'), floorPrice: 10n, bestBid: 9n },
        { at: new Date('2026-11-04T00:15:00Z'), floorPrice: 12n, bestBid: null },
        { at: new Date('2026-11-04T00:30:00Z'), floorPrice: 14n, bestBid: 13n },
      ],
      priceStep: 0n,
      saleFeeBps: 0n,
      sales: [],
    },
  },
});

describe('recordPriceHistory', () => {
  test('samples the floor every 15 minutes and derives the bid from the day spread', async () => {
    const { api, queries } = fakeApi();

    const recorded = await recordPriceHistory({
      api,
      slugs: ['boredapeyachtclub'],
      days: 1,
      now: NOW,
    });

    const { samples, ...market } = recorded.collections.boredapeyachtclub!;
    expect(samples).toHaveLength(97);
    expect(samples[0]).toEqual({
      at: new Date('2026-11-04T12:00:00Z'),
      floorPrice: parseEther('22'),
      bestBid: parseEther('19.8'),
    });
    expect(samples.at(-1)!.at).toEqual(new Date('2026-11-05T12:00:00Z'));
    expect(market).toEqual({
      collectionId: 7,
      contractAddress: MARKET.contractData.contractAddress as never,
      seaportConduitKey: '0x00',
      royalties: MARKET.royalties as never,
      priceStep: 1000n,
      saleFeeBps: 50n,
      sales: [{ at: new Date('2026-11-05T09:00:00Z'), price: 21n, tookAsk: true }],
    });
    expect(recorded.ethUsdPrice).toBe(3200.5);
    expect(queries.filter((query) => query.includes('floorPriceAt'))).toHaveLength(3);
  });

  test.each([
    ['carries the last day with a bid over a day without one', ['2026-11-04'], 19.8, 19.8],
    ['records no bid before the first day with one', ['2026-11-05'], null, 19.8],
  ])('%s', async (_case, bidDays, firstBid, lastBid) => {
    const { api } = fakeApi(bidDays);

    const recorded = await recordPriceHistory({
      api,
      slugs: ['boredapeyachtclub'],
      days: 1,
      now: NOW,
    });

    const { samples } = recorded.collections.boredapeyachtclub!;
    expect(samples[0]!.bestBid).toBe(firstBid === null ? null : parseEther(String(firstBid)));
    expect(samples.at(-1)!.bestBid).toBe(parseEther(String(lastBid)));
  });

  test('round-trips through its JSON file', async () => {
    const { api } = fakeApi();
    const recorded = await recordPriceHistory({
      api,
      slugs: ['boredapeyachtclub'],
      days: 1,
      now: NOW,
    });

    expect(parsePriceHistory(serializePriceHistory(recorded))).toEqual(recorded);
  });
});

describe('PriceReplay', () => {
  const at = (minutes: number) => () => new Date(+NOW + minutes * 60_000);

  test.each([
    ['starts at the first sample', 0, 10n, 9n],
    ['holds a sample until the next', 14, 10n, 9n],
    ['has no bid where none was recorded', 15, 12n, null],
    ['reaches the last sample', 30, 14n, 13n],
    ['starts over after the last', 45, 10n, 9n],
  ])('%s', async (_case, minutes, floorPrice, bestBid) => {
    const replay = new PriceReplay(history(), 1, at(minutes));

    const market = await replay.collectionMarket({ slug: 'boredapeyachtclub' });

    expect(market.floorPrice).toBe(floorPrice);
    expect(market.highestBid?.price ?? null).toBe(bestBid);
  });

  test('runs its clock `speed` times faster', () => {
    expect(new PriceReplay(history(), 30, at(1)).replayTime()).toEqual(
      new Date('2026-11-04T00:30:00Z'),
    );
  });

  test('lists the best bid and the floor as competing orders', async () => {
    const replay = new PriceReplay(history(), 1, at(30));

    const [bids, asks, unknown] = await Promise.all([
      replay.orders({ side: 'BID', collections: [7] }),
      replay.orders({ side: 'ASK', collections: [7] }),
      replay.orders({ side: 'BID', collections: [8] }),
    ]);

    expect(bids.orders.map((order) => [order.price, order.currencyAddress])).toEqual([[13n, WETH]]);
    expect(asks.orders.map((order) => [order.price, order.isAsk])).toEqual([[14n, true]]);
    expect(unknown.orders).toEqual([]);
  });

  test('holds ETH at the recorded USD price', async () => {
    expect(await new PriceReplay(history(), 1).currencyUsdPrice()).toBe(3000);
  });

  test('refuses a collection it did not record', async () => {
    await expect(
      new PriceReplay(history(), 1).collectionMarket({ slug: 'argonauts' }),
    ).rejects.toThrow('invalid collection argonauts');
  });
});

describe('priceApiFrom', () => {
  const FORK = { MARKET_MAKER_CHAIN_ID: '31337', MARKET_MAKER_RPC_URL: 'http://fork.test' };

  test('reads nothing else when unset', async () => {
    expect(await priceApiFrom({})).toBeUndefined();
  });

  test('reads a live API', async () => {
    expect(await priceApiFrom({ MARKET_MAKER_PRICE_API_URL: 'https://api.test' })).toBeInstanceOf(
      GondiApi,
    );
  });

  test('replays a recorded file over a live API', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'market-maker-')), 'history.json');
    await writeFile(path, serializePriceHistory(history()));

    const priceApi = await priceApiFrom({
      ...FORK,
      MARKET_MAKER_PRICE_REPLAY_FILE: path,
      MARKET_MAKER_PRICE_API_URL: 'https://api.test',
    });

    expect(priceApi).toBeInstanceOf(PriceReplay);
  });

  test('rejects a speed that is not positive', async () => {
    await expect(
      priceApiFrom({
        ...FORK,
        MARKET_MAKER_PRICE_REPLAY_FILE: '/x',
        MARKET_MAKER_PRICE_REPLAY_SPEED: '0',
      }),
    ).rejects.toThrow('MARKET_MAKER_PRICE_REPLAY_SPEED');
  });

  test('refuses to replay on mainnet', async () => {
    await expect(priceApiFrom({ MARKET_MAKER_PRICE_REPLAY_FILE: '/x' })).rejects.toThrow(
      'runs only on a fork',
    );
  });
});
