import { describe, expect, test } from 'bun:test';

import {
  decideInventoryItem,
  decideListing,
  type DecideListingInput,
  targetListingPrice,
} from '../src/engine/listing';
import { eth, listingOf, listingSnapshotOf, listingTaskOf } from './fakeMarket';

const NOW = new Date('2030-01-01T00:00:00Z');

const decide = (overrides: Partial<DecideListingInput> = {}) =>
  decideListing({
    task: listingTaskOf(),
    snapshot: listingSnapshotOf(),
    now: NOW,
    pollSeconds: 15,
    listedSince: NOW,
    ...overrides,
  });

describe('targetListingPrice', () => {
  test('undercuts the cheapest competing listing by the configured amount', () => {
    const task = listingTaskOf({ pricing: { mode: 'undercut', amount: '0.03' } });
    expect(targetListingPrice(task, listingSnapshotOf(), NOW, NOW)).toBe(eth('9.97'));
  });

  test('lists at the minimum when the undercut lands under it', () => {
    const task = listingTaskOf({ pricing: { mode: 'undercut', amount: '5' } });
    expect(targetListingPrice(task, listingSnapshotOf(), NOW, NOW)).toBe(eth('9'));
  });

  test('lists at the maximum when nothing else is listed', () => {
    const snapshot = listingSnapshotOf({ lowestCompetingAsk: null });
    expect(targetListingPrice(listingTaskOf(), snapshot, NOW, NOW)).toBe(eth('12'));
  });

  test('never goes under the minimum to follow the competition down', () => {
    const snapshot = listingSnapshotOf({ lowestCompetingAsk: eth('5') });
    expect(targetListingPrice(listingTaskOf(), snapshot, NOW, NOW)).toBe(eth('9'));
  });

  test('lists a share of the cheapest competing listing, unrounded', () => {
    const task = listingTaskOf({ pricing: { mode: 'floor', percent: 105.5 } });
    expect(targetListingPrice(task, listingSnapshotOf(), NOW, NOW)).toBe(eth('10.55'));
  });

  test('has no price for a floor rule when nothing else is listed', () => {
    const task = listingTaskOf({ pricing: { mode: 'floor', percent: 100 } });
    expect(
      targetListingPrice(task, listingSnapshotOf({ lowestCompetingAsk: null }), NOW, NOW),
    ).toBeNull();
  });

  test('caps a fixed price at the maximum', () => {
    const task = listingTaskOf({ pricing: { mode: 'fixed', price: '20' } });
    expect(targetListingPrice(task, listingSnapshotOf(), NOW, NOW)).toBe(eth('12'));
  });
});

describe('decay', () => {
  const HOUR_MS = 60 * 60_000;
  const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * HOUR_MS);
  const task = listingTaskOf({
    pricing: { mode: 'fixed', price: '20' },
    minPrice: '6',
    maxPrice: '12',
    decay: { percent: 10, everyHours: 6 },
  });

  test.each([
    ['the cap at first', 0, '12'],
    ['the cap until a full step has passed', 5.9, '12'],
    ['one step lower after one step', 6, '10.8'],
    ['two steps lower after two steps', 13, '9.6'],
    ['the minimum once the steps would go under it', 30, '6'],
    ['the minimum once the steps take the whole price', 1_000, '6'],
  ])('lists at %s', (_case, hours, price) => {
    expect(targetListingPrice(task, listingSnapshotOf(), hoursAgo(hours), NOW)).toBe(eth(price));
  });

  test('lowers a market price by the same share', () => {
    const floorTask = listingTaskOf({
      pricing: { mode: 'floor', percent: 110 },
      decay: { percent: 5, everyHours: 1 },
    });
    expect(targetListingPrice(floorTask, listingSnapshotOf(), hoursAgo(2), NOW)).toBe(eth('9.9'));
  });

  test('lists again lower once a step passes, leaving the live listing to expire', () => {
    const live = listingOf({ price: eth('12') });
    expect(
      decide({
        task,
        snapshot: listingSnapshotOf({ ownListings: [live] }),
        listedSince: hoursAgo(6),
      }),
    ).toEqual({ type: 'place', price: eth('10.8') });
  });
});

describe('decideListing', () => {
  test('lists when the item has no live listing', () => {
    expect(decide()).toEqual({ type: 'place', price: eth('9.99') });
  });

  test('keeps a live listing already at the target and far from expiry', () => {
    const listing = listingOf();
    expect(decide({ snapshot: listingSnapshotOf({ ownListings: [listing] }) })).toEqual({
      type: 'keep',
      listing,
    });
  });

  test('lists again, lower, once a competitor undercuts it', () => {
    const snapshot = listingSnapshotOf({
      lowestCompetingAsk: eth('9.5'),
      ownListings: [listingOf()],
    });
    expect(decide({ snapshot })).toEqual({ type: 'place', price: eth('9.49') });
  });

  test('waits for an on-chain cancel rather than list above a live cheaper listing', () => {
    const snapshot = listingSnapshotOf({
      lowestCompetingAsk: eth('11'),
      ownListings: [listingOf()],
    });
    expect(decide({ snapshot })).toEqual({
      type: 'wait',
      reason: 'needsOnChainCancel',
      listing: listingOf(),
    });
  });

  test('lists again when the live listing expired, though the API still says Active', () => {
    const expired = listingOf({ expiration: new Date(NOW.getTime() - 60_000) });
    const snapshot = listingSnapshotOf({ lowestCompetingAsk: eth('11'), ownListings: [expired] });
    expect(decide({ snapshot })).toEqual({ type: 'place', price: eth('10.99') });
  });

  test('judges against the cheapest live listing, ignoring dominated older ones', () => {
    const older = listingOf({ id: 1, price: eth('10.5') });
    const cheapest = listingOf({ id: 2, price: eth('9.99') });
    const snapshot = listingSnapshotOf({ ownListings: [older, cheapest] });
    expect(decide({ snapshot })).toEqual({ type: 'keep', listing: cheapest });
  });

  test('lists again at the same price when the live listing nears expiry', () => {
    const listing = listingOf({ expiration: new Date(NOW.getTime() + 60_000) });
    expect(decide({ snapshot: listingSnapshotOf({ ownListings: [listing] }) })).toEqual({
      type: 'place',
      price: eth('9.99'),
    });
  });

  test.each([
    ['keeps a 5-minute listing with 150s left at the default poll interval', 15, 'keep'],
    ['lists again with 150s left when the next round is 180s away', 180, 'place'],
  ] as const)('%s', (_name, pollSeconds, type) => {
    const task = listingTaskOf({ expirationMinutes: 5 });
    const listing = listingOf({ expiration: new Date(NOW.getTime() + 150_000) });
    const snapshot = listingSnapshotOf({ ownListings: [listing] });
    expect(decide({ task, snapshot, pollSeconds }).type).toBe(type);
  });

  test('halts once a listing fills', () => {
    const filled = listingOf({ active: false, executions: 1 });
    expect(decide({ snapshot: listingSnapshotOf({ ownListings: [filled] }) })).toEqual({
      type: 'halt',
      reason: 'filled',
    });
  });

  test.each([
    ['notOwned', { owned: false }],
    ['notApproved', { approved: false }],
    ['noPrice', { lowestCompetingAsk: null }],
  ] as const)('waits on %s', (reason, overrides) => {
    const task = listingTaskOf({ pricing: { mode: 'floor', percent: 100 } });
    expect(decide({ task, snapshot: listingSnapshotOf(overrides) })).toEqual({
      type: 'wait',
      reason,
    });
  });
});

describe('decideInventoryItem', () => {
  const task = listingTaskOf({ tokenId: undefined });
  const decideItem = (overrides: Partial<DecideListingInput> = {}) =>
    decideInventoryItem({
      task,
      snapshot: listingSnapshotOf(),
      now: NOW,
      pollSeconds: 15,
      listedSince: NOW,
      ...overrides,
    });

  test('skips an item the wallet no longer holds', () => {
    expect(decideItem({ snapshot: listingSnapshotOf({ owned: false }) })).toBeNull();
  });

  test('lists again an item that sold before and came back, rather than halting', () => {
    const sold = listingOf({ executions: 1, active: false });
    expect(decideItem({ snapshot: listingSnapshotOf({ ownListings: [sold] }) })).toEqual({
      type: 'place',
      price: eth('9.99'),
    });
  });

  test('decides a held item as a single listing would', () => {
    const live = listingOf();
    expect(decideItem({ snapshot: listingSnapshotOf({ ownListings: [live] }) })).toEqual({
      type: 'keep',
      listing: live,
    });
  });
});

describe('a crossed book', () => {
  const book = (lowestCompetingAsk: string, bestCompetingBid: string | null) =>
    listingSnapshotOf({
      lowestCompetingAsk: eth(lowestCompetingAsk),
      bestCompetingBid: bestCompetingBid === null ? null : eth(bestCompetingBid),
    });

  test('posts no listing while the cheapest ask is under the best bid', () => {
    expect(decide({ snapshot: book('0.000000000000000006', '4.9') })).toEqual({
      type: 'wait',
      reason: 'crossedBook',
    });
  });

  test('does not keep a live listing it would price from a crossed book', () => {
    const snapshot = { ...book('9', '9.5'), ownListings: [listingOf({ price: eth('9.99') })] };
    expect(decide({ snapshot })).toEqual({ type: 'wait', reason: 'crossedBook' });
  });

  test.each([
    ['an ask equal to the best bid', book('9.5', '9.5')],
    ['no best bid', book('9.5', null)],
  ])('lists as usual with %s', (_case, snapshot) => {
    expect(decide({ snapshot }).type).toBe('place');
  });

  test('holds an inventory item back the same way', () => {
    const task = listingTaskOf({ tokenId: undefined });
    const decision = decideInventoryItem({
      task,
      snapshot: book('1', '4.9'),
      now: NOW,
      pollSeconds: 15,
      listedSince: NOW,
    });
    expect(decision).toEqual({ type: 'wait', reason: 'crossedBook' });
  });
});
