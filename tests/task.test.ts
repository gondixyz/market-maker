import { describe, expect, test } from 'bun:test';

import { marginWarnings } from '../src/engine/task';
import { eth, listingTaskJson, listingTaskOf, taskOf, tasksFileOf } from './fakeMarket';

describe('parseTasksFile', () => {
  test('reads ETH amounts into wei and fills the defaults', () => {
    expect(taskOf()).toMatchObject({
      minPrice: eth('5'),
      maxPrice: eth('9'),
      quantity: 1,
      expirationMinutes: 60,
      pricing: { mode: 'outbid', steps: 1 },
      venue: 'gondi',
    });
  });

  test.each([
    ['a minimum above the maximum', { minPrice: '10' }],
    ['an amount that is not ETH', { maxPrice: '9e18' }],
    ['an expiration under 10 minutes', { expirationMinutes: 9 }],
    ['an unknown pricing mode', { pricing: { mode: 'random' } }],
    ['a maxItems of zero', { maxItems: 0 }],
    ['a ladder of more than 10 offers', { ladder: { offers: 11, spacing: '0.01' } }],
    ['a ladder without a spacing', { ladder: { offers: 3 } }],
    ['a ladder spacing of zero', { ladder: { offers: 3, spacing: '0' } }],
    [
      'an outbid by both steps and a percentage',
      { pricing: { mode: 'outbid', steps: 1, percent: 1 } },
    ],
    [
      'a floor rule by both steps and a percentage',
      { pricing: { mode: 'floor', steps: 1, percent: 90 } },
    ],
    ['a floor rule with neither steps nor a percentage', { pricing: { mode: 'floor' } }],
    ['a floor rule of zero steps', { pricing: { mode: 'floor', steps: 0 } }],
    ['an outbid by a percentage of zero', { pricing: { mode: 'outbid', percent: 0 } }],
    ['a maxFloorPercent above 100', { maxFloorPercent: 101 }],
    ['a maxHeldValue that is not ETH', { maxHeldValue: 30 }],
    ['an OpenSea bid without maxItems', { venue: 'opensea' }],
    ['an unknown venue', { venue: 'blur', maxItems: 1 }],
    ['a trait bid without its trait', { kind: 'traitBid' }],
    [
      'a trait bid with an empty value',
      { kind: 'traitBid', trait: { type: 'Background', value: '' } },
    ],
    [
      'a trait bid on OpenSea',
      {
        kind: 'traitBid',
        trait: { type: 'Background', value: 'Blue' },
        venue: 'opensea',
        maxItems: 1,
      },
    ],
  ])('rejects %s', (_case, overrides) => {
    expect(() => taskOf(overrides)).toThrow();
  });

  test('reads an outbid by a percentage, a floor cap and a held value cap', () => {
    expect(
      taskOf({
        pricing: { mode: 'outbid', percent: 0.5 },
        maxFloorPercent: 95,
        maxHeldValue: '30',
      }),
    ).toMatchObject({
      pricing: { mode: 'outbid', percent: 0.5 },
      maxFloorPercent: 95,
      maxHeldValue: eth('30'),
    });
  });

  test('reads a bid at a competing level on either venue, and bids on GONDI by default', () => {
    expect(
      taskOf({ venue: 'opensea', pricing: { mode: 'level', level: 5 }, maxItems: 1 }),
    ).toMatchObject({ venue: 'opensea', pricing: { mode: 'level', level: 5 } });
    expect(taskOf({ pricing: { mode: 'level', level: 5 } })).toMatchObject({
      venue: 'gondi',
      pricing: { mode: 'level', level: 5 },
    });
    expect(taskOf().venue).toBe('gondi');
  });

  test('reads a trait bid on GONDI with the trait as named', () => {
    expect(
      taskOf({ kind: 'traitBid', trait: { type: 'Background', value: 'Blue' } }),
    ).toMatchObject({
      kind: 'traitBid',
      trait: { type: 'Background', value: 'Blue' },
      venue: 'gondi',
      quantity: 1,
    });
  });

  test('rejects an unknown kind', () => {
    expect(() => taskOf({ kind: 'traitBid', traitId: 3 })).toThrow();
  });

  test('rejects duplicate task ids', () => {
    const task = {
      id: 'same',
      kind: 'collectionBid',
      collection: 'pudgypenguins',
      pricing: { mode: 'outbid' },
      minPrice: '1',
      maxPrice: '2',
    };
    expect(() => tasksFileOf([task, task])).toThrow('task ids must be unique');
  });
});

describe('parseTasksFile ladder', () => {
  test('reads the spacing into wei', () => {
    expect(taskOf({ ladder: { offers: 5, spacing: '0.02' } }).ladder).toEqual({
      offers: 5,
      spacing: eth('0.02'),
    });
  });

  test('leaves a task without one alone', () => {
    expect(taskOf().ladder).toBeUndefined();
  });
});

describe('parseTasksFile lossLimits', () => {
  test('reads the caps and the date the ledger starts', () => {
    expect(
      tasksFileOf([], {
        lossLimits: { dailyUsd: 3_000, weeklyUsd: 10_000, since: '2030-01-01T00:00:00Z' },
      }).lossLimits,
    ).toEqual({ dailyUsd: 3_000, weeklyUsd: 10_000, since: new Date('2030-01-01T00:00:00Z') });
  });

  test.each([
    ['a cap of zero', { dailyUsd: 0, weeklyUsd: 10_000, since: '2030-01-01T00:00:00Z' }],
    ['a missing since', { dailyUsd: 3_000, weeklyUsd: 10_000 }],
    ['a since that is not a date', { dailyUsd: 3_000, weeklyUsd: 10_000, since: 'monday' }],
  ])('rejects %s', (_case, lossLimits) => {
    expect(() => tasksFileOf([], { lossLimits })).toThrow();
  });
});

describe('parseTasksFile wrapEth', () => {
  test('reads the gas reserve into wei', () => {
    expect(tasksFileOf([], { wrapEth: { keepEth: '0.05' } }).wrapEth).toEqual({
      keepEth: eth('0.05'),
    });
  });

  test('rejects a gas reserve of zero', () => {
    expect(() => tasksFileOf([], { wrapEth: { keepEth: '0' } })).toThrow(
      'keepEth is the ETH kept for gas',
    );
  });
});

describe('parseTasksFile resaleBid', () => {
  const lossLimits = { dailyUsd: 400, weeklyUsd: 1_200, since: '2030-01-01T00:00:00Z' };
  const bid = {
    id: 'pudgy-buy',
    kind: 'collectionBid',
    collection: 'pudgypenguins',
    pricing: { mode: 'outbid' },
    minPrice: '5',
    maxPrice: '9',
    maxItems: 1,
    resaleBid: {},
  };
  const exit = listingTaskJson({ tokenId: undefined, bidExit: {} });

  test('reads the margin, 2% by default, and the resale limit into wei', () => {
    const file = tasksFileOf([bid, exit], { lossLimits, resaleLimit: '1' });
    expect(file.resaleLimit).toBe(eth('1'));
    expect(file.tasks[0]).toMatchObject({ resaleBid: { marginPercent: 2 } });
  });

  test.each([
    ['without resaleLimit', [bid, exit], {}, 'resaleBid needs resaleLimit'],
    [
      'without a bidExit on its collection',
      [bid],
      { resaleLimit: '1' },
      'needs a listing with bidExit',
    ],
  ] as const)('rejects a resaleBid %s', (_case, tasks, overrides, message) => {
    expect(() => tasksFileOf([...tasks], { lossLimits, ...overrides })).toThrow(message);
  });
});

describe('parseTasksFile listings', () => {
  test('reads the token id into a bigint and fills the defaults', () => {
    expect(listingTaskOf()).toMatchObject({
      tokenId: 3950n,
      minPrice: eth('9'),
      maxPrice: eth('12'),
      expirationMinutes: 5,
      pricing: { mode: 'undercut', amount: eth('0.01') },
    });
  });

  test('reads a listing without a token id as one for every item the wallet holds', () => {
    expect(listingTaskOf({ tokenId: undefined }).tokenId).toBeUndefined();
  });

  test('marks an OpenSea listing up 3% for an hour by default', () => {
    expect(listingTaskOf({ tokenId: undefined, openSeaListing: {} }).openSeaListing).toEqual({
      markupPercent: 3,
      expirationMinutes: 60,
    });
  });

  test('lends 90% of the listing price at 1% APR and a 0.25% fee for 3 days by default, offers lasting 10 minutes', () => {
    expect(listingTaskOf({ tokenId: undefined, loanOffer: {} }).loanOffer).toEqual({
      principalPercent: 90,
      aprPercent: 1,
      originationFeePercent: 0.25,
      durationDays: 3,
      expirationMinutes: 10,
    });
  });

  test.each([3, 7, 45, 60])('takes a loan of %i days, which GONDI offers', (durationDays) => {
    expect(
      listingTaskOf({ tokenId: undefined, loanOffer: { durationDays } }).loanOffer,
    ).toMatchObject({
      durationDays,
    });
  });

  test.each([
    ['a token id that is not a number', { tokenId: '#3950' }],
    ['a minimum above the maximum', { minPrice: '13' }],
    ['a minimum of 0, which could list the item for free', { minPrice: '0' }],
    ['an undercut without an amount', { pricing: { mode: 'undercut' } }],
    ['an undercut of 0 ETH', { pricing: { mode: 'undercut', amount: '0' } }],
    ['a bid pricing mode', { pricing: { mode: 'outbid' } }],
    ['an expiration under 5 minutes', { expirationMinutes: 4 }],
    ['an OpenSea listing of one token id', { openSeaListing: {} }],
    ['an OpenSea markup of 0', { tokenId: undefined, openSeaListing: { markupPercent: 0 } }],
    [
      'an OpenSea listing under 15 minutes',
      { tokenId: undefined, openSeaListing: { expirationMinutes: 10 } },
    ],
    ['a loan offer on one token id', { loanOffer: {} }],
    ['a loan of 0% of the price', { tokenId: undefined, loanOffer: { principalPercent: 0 } }],
    [
      'a loan of over 100% of the price',
      { tokenId: undefined, loanOffer: { principalPercent: 101 } },
    ],
    ['a loan offer under 10 minutes', { tokenId: undefined, loanOffer: { expirationMinutes: 9 } }],
    [
      'a loan of 2 days, which GONDI does not offer',
      { tokenId: undefined, loanOffer: { durationDays: 2 } },
    ],
    ['a loan fee over 10%', { tokenId: undefined, loanOffer: { originationFeePercent: 11 } }],
    ['a decay of 0%', { decay: { percent: 0, everyHours: 6 } }],
    ['a decay over 100%', { decay: { percent: 101, everyHours: 6 } }],
    ['a decay every 0 hours', { decay: { percent: 5, everyHours: 0 } }],
  ])('rejects %s', (_case, overrides) => {
    expect(() => listingTaskOf(overrides)).toThrow();
  });

  test('asks for the amount of an undercut that has none', () => {
    expect(() => listingTaskOf({ pricing: { mode: 'undercut' } })).toThrow(
      'expected an amount in ETH such as',
    );
  });

  test('refuses an undercut still counting steps, saying it takes an amount now', () => {
    expect(() =>
      listingTaskOf({ pricing: { mode: 'undercut', steps: 1, amount: '0.01' } }),
    ).toThrow('undercut now takes an amount in ETH, not steps');
  });
});

describe('marginWarnings', () => {
  const bid = (maxPrice: string) => ({
    id: 'buy',
    kind: 'collectionBid',
    collection: 'pudgypenguins',
    pricing: { mode: 'outbid' },
    minPrice: '1',
    maxPrice,
  });

  test('warns when a listing may sell at or under what a bid on its collection may pay', () => {
    const file = tasksFileOf([bid('9'), listingTaskJson({ minPrice: '9' })]);
    expect(marginWarnings(file)).toEqual([
      'listing pudgy-3950 may sell at 9 ETH, no more than bid buy may pay (9 ETH)',
    ]);
  });

  test.each([
    ['a listing that keeps a margin', [bid('8.5'), listingTaskJson({ minPrice: '9' })]],
    [
      'a bid on another collection',
      [{ ...bid('10'), collection: 'azuki' }, listingTaskJson({ minPrice: '9' })],
    ],
  ])('stays quiet for %s', (_case, tasks) => {
    expect(marginWarnings(tasksFileOf(tasks))).toEqual([]);
  });
});
