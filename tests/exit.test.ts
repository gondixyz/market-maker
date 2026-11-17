import { describe, expect, test } from 'bun:test';

import { decideExit, EXIT_GAS_UNITS, type ExitHoldReason, resalePrice } from '../src/engine/exit';
import { eth, listingTaskJson, tasksFileOf } from './fakeMarket';

const NOW = new Date('2030-01-02T12:00:00Z');
const HOUR = 60 * 60_000;
const GWEI = 10n ** 9n;

const LOSS_LIMITS = { dailyUsd: 400, weeklyUsd: 1_200, since: '2030-01-01T00:00:00Z' };

const [listing] = tasksFileOf([listingTaskJson({ tokenId: undefined, bidExit: {} })], {
  lossLimits: LOSS_LIMITS,
}).tasks;
const exit = listing.kind === 'listing' ? listing.bidExit! : undefined!;

/** An OpenSea offer that pays the seller `netPrice`. */
const offerOf = (netPrice: bigint) => ({ id: '0xoffer', venue: 'opensea' as const, netPrice });

/** A Pudgy bought at 2.30 ETH `hoursAgo` hours before `NOW`. */
const positionOf = (hoursAgo: number) => ({
  slug: 'pudgypenguins',
  tokenId: 6501n,
  cost: eth('2.3'),
  boughtAt: new Date(NOW.getTime() - hoursAgo * HOUR),
});

const decide = (overrides: Partial<Parameters<typeof decideExit>[0]> = {}) =>
  decideExit({
    exit,
    minPrice: eth('1.8'),
    position: positionOf(1),
    offer: offerOf(eth('2.35')),
    gasPrice: 0n,
    pendingTransaction: false,
    ownTopBid: null,
    bidsFull: true,
    soldToday: 0,
    now: NOW,
    ...overrides,
  });

describe('bidExit', () => {
  test('needs lossLimits, which say what each item cost', () => {
    expect(() => tasksFileOf([listingTaskJson({ tokenId: undefined, bidExit: {} })])).toThrow(
      'bidExit needs lossLimits',
    );
  });

  test('sells from the inventory only', () => {
    expect(() =>
      tasksFileOf([listingTaskJson({ bidExit: {} })], { lossLimits: LOSS_LIMITS }),
    ).toThrow('bidExit sells from the inventory');
  });
});

describe('decideExit', () => {
  test('defaults to a 1% stop loss after 6 hours, 2 sales a day, under 30 gwei', () => {
    expect(exit).toEqual({ afterHours: 6, maxLossPercent: 1, maxPerDay: 2, maxGasGwei: 30 });
  });

  test.each([
    ['an offer that pays at least the cost, at once', {}, 'profit', eth('2.3')],
    [
      'an offer within the stop loss once held long enough',
      { offer: offerOf(eth('2.28')), position: positionOf(6) },
      'stopLoss',
      eth('2.277'),
    ],
    [
      'an offer within the stop loss, never under minPrice',
      {
        offer: offerOf(eth('2.28')),
        position: positionOf(6),
        minPrice: eth('2.279'),
      },
      'stopLoss',
      eth('2.279'),
    ],
  ])('sells into %s', (_name, overrides, reason, minProceeds) => {
    expect(decide(overrides)).toMatchObject({ type: 'sell', reason, minProceeds });
  });

  test.each([
    ['no offer', { offer: null }, 'noOffer'],
    ['an item with no buy in the ledger', { position: undefined }, 'unknownCost'],
    ['a day that sold its limit', { soldToday: 2 }, 'dailyLimit'],
    ['an unmined transaction', { pendingTransaction: true }, 'pendingTransaction'],
    ['gas above the ceiling', { gasPrice: 31n * GWEI }, 'gasTooHigh'],
    [
      'an offer under minPrice',
      { offer: offerOf(eth('1.7')), position: positionOf(24) },
      'belowMinPrice',
    ],
    [
      'a loss before afterHours',
      { offer: offerOf(eth('2.28')), position: positionOf(5.9) },
      'belowCost',
    ],
    ['an own bid at or above the proceeds', { ownTopBid: eth('2.35') }, 'ownBidHigher'],
    [
      'a loss while the collection’s bids can still buy',
      { offer: offerOf(eth('2.28')), position: positionOf(24), bidsFull: false },
      'stillBidding',
    ],
    [
      'a loss over maxLossPercent',
      { offer: offerOf(eth('2.2')), position: positionOf(24) },
      'lossTooLarge',
    ],
  ])('holds on %s', (_name, overrides, reason) => {
    expect(decide(overrides)).toEqual({ type: 'hold', reason: reason as ExitHoldReason });
  });

  test('takes a profit while the collection’s bids can still buy', () => {
    expect(decide({ bidsFull: false })).toMatchObject({ type: 'sell', reason: 'profit' });
  });

  test('sells over an own bid under the proceeds', () => {
    expect(decide({ ownTopBid: eth('2.3') })).toMatchObject({
      type: 'sell',
      reason: 'profit',
    });
  });

  test('counts the gas against the proceeds', () => {
    const gasPrice = 20n * GWEI;
    const atCost = offerOf(eth('2.3') + gasPrice * EXIT_GAS_UNITS);

    expect(decide({ gasPrice, offer: atCost })).toMatchObject({ type: 'sell', reason: 'profit' });
    expect(decide({ gasPrice, offer: { ...atCost, netPrice: atCost.netPrice - 1n } })).toEqual({
      type: 'hold',
      reason: 'belowCost',
    });
  });
});

describe('resalePrice', () => {
  const price = (overrides: Partial<Parameters<typeof resalePrice>[0]> = {}) =>
    resalePrice({
      offer: offerOf(eth('2.4')),
      gasPrice: 0n,
      maxGasGwei: 30,
      marginPercent: 2,
      floorPrice: eth('3'),
      maxPrice: eth('5'),
      priceStep: eth('0.01'),
      ...overrides,
    });

  test.each([
    ['makes the margin on the price, rounded down onto the step', {}, eth('2.35')],
    ['takes the sale’s gas out first', { gasPrice: 20n * GWEI }, eth('2.34')],
    ['stays one step under the floor', { floorPrice: eth('2.3') }, eth('2.29')],
    ['stays within maxPrice', { maxPrice: eth('2') }, eth('2')],
    ['needs no floor to price from', { floorPrice: null }, eth('2.35')],
    ['has no price without an offer', { offer: null }, null],
    ['has no price while gas is above bidExit’s cap', { gasPrice: 31n * GWEI }, null],
    [
      'has no price when the gas takes the whole offer',
      { offer: offerOf(eth('0.001')), gasPrice: 20n * GWEI },
      null,
    ],
  ] as const)('%s', (_name, overrides, expected) => {
    expect(price(overrides)).toBe(expected);
  });

  test('makes at least the margin once the item is sold into the offer', () => {
    const paid = price({ gasPrice: 20n * GWEI })!;
    const proceeds = eth('2.4') - 20n * GWEI * EXIT_GAS_UNITS;
    expect(proceeds * 100n >= paid * 102n).toBe(true);
  });
});
