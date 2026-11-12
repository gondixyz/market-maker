import { describe, expect, test } from 'bun:test';

import type { Fill, SaleTerms } from '../src/engine/market';
import { dayStart, ledgerOf, lossReport, pnlOf, weekStart } from '../src/engine/pnl';
import { eth } from './fakeMarket';

/** A Wednesday: its week started on Monday 2030-01-07. */
const NOW = new Date('2030-01-09T12:00:00Z');
const LIMITS = { dailyUsd: 3_000, weeklyUsd: 10_000, since: new Date('2030-01-01T00:00:00Z') };
const TERMS = new Map<string, SaleTerms>([
  ['pudgypenguins', { floorPrice: eth('10'), feeBps: 500n }],
]);

const buy = (timestamp: string, price: string, tokenId = 1n): Fill => ({
  slug: 'pudgypenguins',
  tokenId,
  side: 'buy',
  price: eth(price),
  timestamp: new Date(timestamp),
});
const sell = (timestamp: string, price: string, tokenId = 1n): Fill => ({
  ...buy(timestamp, price, tokenId),
  side: 'sell',
});

const reportOf = (fills: Fill[], { now = NOW, terms = TERMS } = {}) =>
  lossReport({
    ledger: ledgerOf(fills, LIMITS.since),
    terms,
    ethUsd: 2_000,
    now,
    limits: LIMITS,
  });

describe('lossReport', () => {
  test.each([
    [
      'a buy with no sale, held above the floor net of fees',
      [buy('2030-01-09T10:00:00Z', '10.5')],
      2_000,
      2_000,
    ],
    [
      'a buy and a sale on the same day, the sale net of fees',
      [buy('2030-01-09T08:00:00Z', '10'), sell('2030-01-09T10:00:00Z', '10')],
      1_000,
      1_000,
    ],
    [
      "a sale this week of last week's buy, outside today",
      [buy('2030-01-05T08:00:00Z', '10'), sell('2030-01-08T10:00:00Z', '10')],
      0,
      1_000,
    ],
    [
      'the same token bought twice, each sale costed with the buy before it',
      [
        buy('2030-01-08T08:00:00Z', '10'),
        sell('2030-01-08T10:00:00Z', '10'),
        buy('2030-01-09T08:00:00Z', '10.5'),
      ],
      2_000,
      3_000,
    ],
    [
      'a fill before since, whose item has no cost in the ledger',
      [buy('2029-12-30T08:00:00Z', '15'), sell('2030-01-09T10:00:00Z', '10')],
      0,
      0,
    ],
    [
      'a held item worth more than it cost, whose paper gain offsets no realized loss',
      [
        buy('2030-01-09T08:00:00Z', '10'),
        sell('2030-01-09T10:00:00Z', '9', 1n),
        buy('2030-01-09T11:00:00Z', '5', 2n),
      ],
      2_900,
      2_900,
    ],
    [
      'a gain, which is no loss',
      [buy('2030-01-09T08:00:00Z', '8'), sell('2030-01-09T10:00:00Z', '12')],
      0,
      0,
    ],
  ])('%s', (_case, fills, dailyLossUsd, weeklyLossUsd) => {
    expect(reportOf(fills)).toEqual({
      status: 'measured',
      dailyLossUsd,
      weeklyLossUsd,
      reached: false,
    });
  });

  test('is reached once either window reaches its cap', () => {
    expect(reportOf([buy('2030-01-09T10:00:00Z', '11')])).toMatchObject({
      dailyLossUsd: 3_000,
      reached: true,
    });
  });

  test('values an item held at the floor at what selling it there would lose', () => {
    const held = reportOf([buy('2030-01-09T08:00:00Z', '11')]);
    const sold = reportOf([buy('2030-01-09T08:00:00Z', '11'), sell('2030-01-09T10:00:00Z', '10')]);
    expect(held).toEqual(sold);
  });

  test('cannot be measured while a held item has no floor', () => {
    const terms = new Map([['pudgypenguins', { floorPrice: null, feeBps: 500n }]]);
    expect(reportOf([buy('2030-01-09T10:00:00Z', '10')], { terms })).toEqual({
      status: 'unmeasured',
      reason: 'no floor for pudgypenguins',
    });
  });

  test("leaves Sunday's sale out of the week that starts at 00:00 UTC on Monday", () => {
    const fills = [buy('2030-01-06T08:00:00Z', '10'), sell('2030-01-06T23:59:59Z', '5')];
    expect(reportOf(fills, { now: new Date('2030-01-07T00:00:00Z') })).toMatchObject({
      weeklyLossUsd: 0,
    });
  });
});

describe('pnlOf', () => {
  test('counts a paper gain and every sale since `since`, not only this week', () => {
    const fills = [buy('2030-01-02T00:00:00Z', '8'), sell('2030-01-03T00:00:00Z', '10')];
    const ledger = ledgerOf([...fills, buy('2030-01-09T00:00:00Z', '9', 2n)], LIMITS.since);

    expect(pnlOf(ledger, TERMS)).toEqual([
      { slug: 'pudgypenguins', realized: eth('1.5'), unrealized: eth('0.5') },
    ]);
  });

  test('leaves the unrealized P&L unknown while an item is held with no floor', () => {
    const ledger = ledgerOf([buy('2030-01-09T00:00:00Z', '9')], LIMITS.since);
    const terms = new Map([['pudgypenguins', { floorPrice: null, feeBps: 500n }]]);

    expect(pnlOf(ledger, terms)).toEqual([
      { slug: 'pudgypenguins', realized: 0n, unrealized: null },
    ]);
  });
});

describe('weekStart', () => {
  test.each([
    ['2030-01-06T23:59:59Z', '2029-12-31T00:00:00Z'],
    ['2030-01-07T00:00:00Z', '2030-01-07T00:00:00Z'],
    ['2030-01-13T23:59:59Z', '2030-01-07T00:00:00Z'],
  ])('puts %s in the ISO week of %s', (now, start) => {
    expect(weekStart(new Date(now))).toEqual(new Date(start));
  });
});

describe('dayStart', () => {
  test('is 00:00 UTC of the day', () => {
    expect(dayStart(new Date('2030-01-09T23:59:59Z'))).toEqual(new Date('2030-01-09T00:00:00Z'));
  });
});
