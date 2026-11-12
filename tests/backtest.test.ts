import { describe, expect, test } from 'bun:test';
import { parseEther, zeroAddress } from 'viem';

import { BacktestMarket, type FillModel, runBacktest } from '../src/gondi/backtest';
import type { PriceHistory, RecordedSale } from '../src/gondi/replay';
import { tasksFileOf } from './fakeMarket';

const eth = (amount: string) => parseEther(amount);
const START = new Date('2026-11-02T00:00:00Z');
const at = (minutes: number) => new Date(+START + minutes * 60_000);

/** An hour of a collection whose floor is 10 ETH and best bid 9 ETH, with the given sales. */
const historyOf = (sales: RecordedSale[] = []): PriceHistory => ({
  recordedAt: at(60),
  ethUsdPrice: 2_000,
  collections: {
    pudgypenguins: {
      collectionId: 7,
      contractAddress: zeroAddress,
      seaportConduitKey: '0x00',
      royalties: [],
      samples: [0, 15, 30, 45, 60].map((minutes) => ({
        at: at(minutes),
        floorPrice: eth('10'),
        bestBid: eth('9'),
      })),
      priceStep: eth('0.01'),
      saleFeeBps: 50n,
      sales,
    },
  },
});

const bidTask = {
  id: 'pudgy-buy',
  kind: 'collectionBid',
  collection: 'pudgypenguins',
  pricing: { mode: 'outbid', percent: 0.5 },
  minPrice: '1',
  maxPrice: '20',
  maxFloorPercent: 98,
  maxHeldValue: '30',
};
const listingTask = {
  id: 'pudgy-sell',
  kind: 'listing',
  collection: 'pudgypenguins',
  pricing: { mode: 'floor', percent: 99.5 },
  minPrice: '1',
  maxPrice: '20',
  expirationMinutes: 15,
};

/** A market holding one live bid at 9.05 ETH, the bot's outbid of the 9 ETH best bid. */
const marketWithBid = async (fillModel: FillModel) => {
  const market = new BacktestMarket(historyOf(), fillModel);
  await market.placeBid({
    scope: { kind: 'collection', slug: 'pudgypenguins', venue: 'gondi' },
    price: eth('9.05'),
    quantity: 1,
    expiration: at(60),
  });
  return market;
};

describe('BacktestMarket.fillWith', () => {
  test.each([
    ['strict: a seller who took a lower bid takes ours', 'strict', '9', eth('9.05')],
    ['strict: one who took a higher bid does not', 'strict', '9.5', null],
    [
      'loose: one who took a bid near the floor takes ours, at the higher price',
      'loose',
      '9.5',
      eth('9.5'),
    ],
    ['loose: one who took an offer on a rare item does not', 'loose', '12', null],
    ['either: a sale far under the floor is noise', 'strict', '0.1', null],
  ] as const)('%s', async (_case, fillModel, price, paid) => {
    const market = await marketWithBid(fillModel);

    market.fillWith({ slug: 'pudgypenguins', at: at(5), price: eth(price), tookAsk: false });

    const fills = await market.fills(START);
    expect(fills.map((fill) => fill.price)).toEqual(paid === null ? [] : [paid]);
  });

  test.each([
    ['a floor buy at or above our listing takes it', 'strict', '9.95', '10', true],
    ['a buy under our listing does not', 'strict', '9.95', '9.9', false],
    ['strict: a buy 5% over the floor was a chosen item', 'strict', '9.95', '10.5', false],
    ['loose: a buy 5% over the floor takes ours', 'loose', '9.95', '10.5', true],
    ['either: a buy of a chosen item far above the floor does not', 'loose', '9.95', '15', false],
    [
      'strict: a listing 5% under the floor catches a buyer 5% over it',
      'strict',
      '9.5',
      '10.5',
      true,
    ],
    ['strict: but not one 8% over it', 'strict', '9.5', '10.8', false],
    ['loose: one 14% over it', 'loose', '9.5', '11.4', true],
  ] as const)('%s', async (_case, fillModel, listingPrice, salePrice, sold) => {
    const market = await marketWithBid(fillModel);
    market.fillWith({ slug: 'pudgypenguins', at: at(1), price: eth('9'), tookAsk: false });
    const [tokenId] = await market.heldItems('pudgypenguins');
    await market.placeListing({
      scope: { slug: 'pudgypenguins', tokenId: tokenId! },
      price: eth(listingPrice),
      expiration: at(60),
    });

    market.fillWith({ slug: 'pudgypenguins', at: at(5), price: eth(salePrice), tookAsk: true });

    expect(await market.heldItems('pudgypenguins')).toEqual(sold ? [] : [tokenId!]);
  });

  test('reports the recorded best bid to listings', async () => {
    const market = new BacktestMarket(historyOf(), 'strict');

    expect((await market.listingMarket('pudgypenguins')).bestCompetingBid).toBe(eth('9'));
  });

  test('an expired bid fills nothing', async () => {
    const market = await marketWithBid('strict');

    market.fillWith({ slug: 'pudgypenguins', at: at(61), price: eth('9'), tookAsk: false });

    expect(await market.fills(START)).toEqual([]);
  });
});

describe('runBacktest', () => {
  test('buys from a seller, lists at the floor and sells to a buyer', async () => {
    const pushed: Date[] = [];
    const result = await runBacktest({
      history: historyOf([
        { at: at(7), price: eth('9'), tookAsk: false },
        { at: at(20), price: eth('10'), tookAsk: true },
      ]),
      file: tasksFileOf([bidTask, listingTask], {
        lossLimits: { dailyUsd: 3_000, weeklyUsd: 10_000, since: '2030-01-01T00:00:00Z' },
      }),
      fillModel: 'strict',
      onRound: (_report, moment) => {
        pushed.push(moment);
      },
    });

    expect(result.fills.map(({ side, price }) => [side, price])).toEqual([
      ['buy', eth('9.05')],
      ['sell', eth('9.95')],
    ]);
    const [pnl] = result.report.pnl!.collections;
    expect(pnl).toEqual({
      slug: 'pudgypenguins',
      realized: eth('9.95') - (eth('9.95') * 50n) / 10_000n - eth('9.05'),
      unrealized: 0n,
    });
    const atTheFloor = eth('10') - (eth('10') * 50n) / 10_000n - eth('9.05');
    expect(result.worstDrawdown).toBe(atTheFloor - pnl!.realized);
    expect(pushed[0]).toEqual(START);
    expect(pushed).toContainEqual(at(7));
    expect(pushed.at(-1)).toEqual(at(60));
  });
});
