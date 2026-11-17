import { describe, expect, test } from 'bun:test';

import type { MirrorListing } from '../src/engine/market';
import { decideMirror, type DecideMirrorInput, mirrorPrice } from '../src/engine/mirror';
import { eth, listingOf } from './fakeMarket';

const NOW = new Date('2030-01-01T00:00:00Z');
const MINUTE = 60_000;

const mirrorOf = (overrides: Partial<MirrorListing> = {}): MirrorListing => ({
  id: '0xmirror',
  tokenId: 1n,
  price: eth('10.3'),
  expiration: new Date(NOW.getTime() + 50 * MINUTE),
  ...overrides,
});

const decide = (overrides: Partial<DecideMirrorInput> = {}) =>
  decideMirror({
    markupPercent: 3,
    gondiListings: [listingOf({ price: eth('10') })],
    mirrors: [],
    priceStep: eth('0.0001'),
    refreshMarginMs: 6 * MINUTE,
    now: NOW,
    ...overrides,
  });

describe('mirrorPrice', () => {
  test.each([
    ['3% over a round price', eth('10'), 3, eth('10.3')],
    ['rounds up onto the step', eth('2.1234'), 3, eth('2.1872')],
    ['a fractional markup', eth('1'), 2.5, eth('1.025')],
  ])('%s', (_name, price, markupPercent, expected) => {
    expect(mirrorPrice(price, markupPercent, eth('0.0001'))).toBe(expected);
  });
});

describe('decideMirror', () => {
  test('lists the item above its GONDI listing when OpenSea has none', () => {
    expect(decide()).toEqual({ place: eth('10.3'), cancel: [] });
  });

  test('keeps a mirror at the price that is not close to expiring', () => {
    expect(decide({ mirrors: [mirrorOf()] })).toEqual({ place: null, cancel: [] });
  });

  test('follows the cheapest live GONDI listing, ignoring expired ones', () => {
    const gondiListings = [
      listingOf({ price: eth('9'), expiration: new Date(NOW.getTime() - MINUTE) }),
      listingOf({ price: eth('10') }),
      listingOf({ price: eth('11') }),
    ];
    expect(decide({ gondiListings }).place).toBe(eth('10.3'));
  });

  test('replaces a mirror at another price and cancels it once OpenSea takes it', () => {
    const stale = mirrorOf({ price: eth('10.5') });
    expect(decide({ mirrors: [stale] })).toEqual({ place: eth('10.3'), cancel: [stale] });
  });

  test('leaves up a stale mirror OpenSea does not cancel yet', () => {
    const stale = mirrorOf({
      price: eth('10.5'),
      cancellableFrom: new Date(NOW.getTime() + MINUTE),
    });
    expect(decide({ mirrors: [stale] })).toEqual({ place: eth('10.3'), cancel: [] });
  });

  test('places again a mirror close to expiring', () => {
    const expiring = mirrorOf({ expiration: new Date(NOW.getTime() + 5 * MINUTE) });
    expect(decide({ mirrors: [expiring] })).toEqual({ place: eth('10.3'), cancel: [expiring] });
  });

  test('cancels the duplicates of a mirror it keeps', () => {
    const kept = mirrorOf({ id: '0xkept' });
    const duplicate = mirrorOf({ id: '0xduplicate', price: eth('10.4') });
    expect(decide({ mirrors: [kept, duplicate] })).toEqual({ place: null, cancel: [duplicate] });
  });

  test('cancels every mirror without a live GONDI listing, and ignores expired ones', () => {
    const live = mirrorOf();
    const expired = mirrorOf({ id: '0xexpired', expiration: new Date(NOW.getTime() - MINUTE) });
    expect(decide({ gondiListings: [], mirrors: [live, expired] })).toEqual({
      place: null,
      cancel: [live],
    });
    expect(decide({ gondiListings: [listingOf({ active: false })], mirrors: [live] })).toEqual({
      place: null,
      cancel: [live],
    });
  });
});
