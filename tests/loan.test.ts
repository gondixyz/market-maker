import { describe, expect, test } from 'bun:test';

import {
  decideLoanOffer,
  type DecideLoanOfferInput,
  loanPrincipal,
  type LoanWaitReason,
} from '../src/engine/loan';
import { eth, listingOf, loanOfferOf } from './fakeMarket';

const NOW = new Date('2030-01-01T00:00:00Z');
const THIRTY_DAYS = 30n * 86_400n;
const TERMS = {
  principalPercent: 70,
  aprPercent: 10,
  originationFeePercent: 0.5,
  durationDays: 30,
  expirationMinutes: 10,
};

const decide = (overrides: Partial<DecideLoanOfferInput> = {}) =>
  decideLoanOffer({
    terms: TERMS,
    minPrice: eth('9'),
    gondiListings: [listingOf({ price: eth('10') })],
    offers: [],
    balance: eth('100'),
    allowance: eth('100'),
    refreshMarginMs: 120_000,
    now: NOW,
    ...overrides,
  });

const terms = (principal: string, fee: string) => ({
  principal: eth(principal),
  aprBps: 1_000n,
  durationSeconds: THIRTY_DAYS,
  fee: eth(fee),
});

describe('loanPrincipal', () => {
  test.each([
    ['a share of the listing price', eth('10'), eth('7')],
    ['rounded down onto 0.01', eth('0.4159'), eth('0.29')],
    ['nothing when it rounds to zero', eth('0.01'), null],
    ['at most minPrice, the least the item can sell for', eth('20'), eth('9')],
  ])('%s', (_name, price, principal) => {
    expect(loanPrincipal(price, 70, eth('9'))).toBe(principal);
  });
});

describe('decideLoanOffer', () => {
  test('offers a loan of principalPercent of the cheapest live listing', () => {
    const gondiListings = [
      listingOf({ id: 1, price: eth('12') }),
      listingOf({ id: 2, price: eth('10') }),
      listingOf({ id: 3, price: eth('8'), active: false }),
    ];
    expect(decide({ gondiListings })).toEqual({
      type: 'place',
      terms: terms('7', '0.035'),
      hide: [],
    });
  });

  test('never lends more than minPrice, which a bidExit sale can take the item for', () => {
    const terms = { ...TERMS, principalPercent: 95 };
    expect(decide({ terms })).toEqual({
      type: 'place',
      terms: {
        principal: eth('9'),
        aprBps: 1_000n,
        durationSeconds: THIRTY_DAYS,
        fee: eth('0.045'),
      },
      hide: [],
    });
  });

  test('keeps an offer already at the terms and hides any other visible one', () => {
    const keep = loanOfferOf({ id: '0xloan:2' });
    const stale = loanOfferOf({ id: '0xloan:1', principal: eth('7.7') });
    expect(decide({ offers: [stale, keep] })).toEqual({ type: 'offer', keep, hide: [stale] });
  });

  test('replaces an offer near expiry, hiding it', () => {
    const offer = loanOfferOf({ expiration: new Date(NOW.getTime() + 60_000) });
    expect(decide({ offers: [offer] })).toEqual({
      type: 'place',
      terms: terms('7', '0.035'),
      hide: [offer],
    });
  });

  test('reprices with the listing, leaving hidden and expired offers alone', () => {
    const visible = loanOfferOf({ id: '0xloan:3' });
    const hidden = loanOfferOf({ id: '0xloan:2', hidden: true });
    const expired = loanOfferOf({ id: '0xloan:1', expiration: NOW });
    const gondiListings = [listingOf({ price: eth('9') })];
    expect(decide({ gondiListings, offers: [expired, hidden, visible] })).toEqual({
      type: 'place',
      terms: terms('6.3', '0.0315'),
      hide: [visible],
    });
  });

  test.each([
    ['notListed', { gondiListings: [] }],
    ['notListed', { gondiListings: [listingOf({ price: eth('0.01') })] }],
    ['insufficientBalance', { balance: eth('6.99') }],
    ['insufficientAllowance', { allowance: eth('6.99') }],
  ] satisfies [LoanWaitReason, Partial<DecideLoanOfferInput>][])(
    'waits on %s, hiding the visible offer',
    (reason, overrides) => {
      const visible = loanOfferOf({ principal: eth('5') });
      expect(decide({ ...overrides, offers: [visible] })).toEqual({
        type: 'wait',
        reason,
        hide: [visible],
      });
    },
  );
});
