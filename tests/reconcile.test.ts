import { describe, expect, test } from 'bun:test';

import { reconcile, type ReconcileInput } from '../src/engine/reconcile';
import { bidOf, eth, snapshotOf, taskOf } from './fakeMarket';

const NOW = new Date('2030-01-01T00:00:00Z');

const decide = (overrides: Partial<ReconcileInput> = {}) =>
  reconcile({
    task: taskOf(),
    snapshot: snapshotOf(),
    now: NOW,
    referenceFloor: eth('10'),
    exposureAvailable: eth('100'),
    lossLimitReached: false,
    ...overrides,
  });

describe('reconcile', () => {
  test('places the target bid when the task has none', () => {
    expect(decide()).toEqual({ type: 'place', price: eth('8.01'), quantity: 1, cancel: [] });
  });

  test('keeps a bid already at the target and far from expiry', () => {
    const bid = bidOf();
    expect(decide({ snapshot: snapshotOf({ ownBids: [bid] }) })).toEqual({
      type: 'keep',
      bid,
      cancel: [],
    });
  });

  test('replaces a bid once a competitor outbids it', () => {
    const bid = bidOf();
    const snapshot = snapshotOf({ bestCompetingBid: eth('8.5'), ownBids: [bid] });
    expect(decide({ snapshot })).toEqual({
      type: 'place',
      price: eth('8.51'),
      quantity: 1,
      cancel: [bid],
    });
  });

  test('refreshes a bid close to its expiry', () => {
    const bid = bidOf({ expiration: new Date(NOW.getTime() + 60_000) });
    expect(decide({ snapshot: snapshotOf({ ownBids: [bid] }) })).toEqual({
      type: 'place',
      price: eth('8.01'),
      quantity: 1,
      cancel: [bid],
    });
  });

  test('keeps the newest bid and withdraws older duplicates', () => {
    const older = bidOf({ id: '1' });
    const newest = bidOf({ id: '2', placedAt: new Date('2029-12-31T23:59:00Z') });
    expect(decide({ snapshot: snapshotOf({ ownBids: [older, newest] }) })).toEqual({
      type: 'keep',
      bid: newest,
      cancel: [older],
    });
  });

  test('tells the newest bid by when it was placed, not by its id', () => {
    const older = bidOf({ id: '0xff', placedAt: new Date('2029-12-31T23:00:00Z') });
    const newest = bidOf({ id: '0x01', placedAt: new Date('2029-12-31T23:59:00Z') });
    expect(decide({ snapshot: snapshotOf({ ownBids: [older, newest] }) })).toEqual({
      type: 'keep',
      bid: newest,
      cancel: [older],
    });
  });

  test('halts and withdraws the active bids once one fills', () => {
    const filled = bidOf({ id: '1', active: false, executions: 1 });
    const active = bidOf({ id: '2' });
    expect(decide({ snapshot: snapshotOf({ ownBids: [filled, active] }) })).toEqual({
      type: 'halt',
      reason: 'filled',
      cancel: [active],
    });
  });

  test('keeps bidding for what a partly filled bid has left to buy', () => {
    const task = taskOf({ quantity: 3 });
    const bid = bidOf({ maxExecutions: 3, executions: 1 });
    expect(decide({ task, snapshot: snapshotOf({ ownBids: [bid] }) })).toEqual({
      type: 'keep',
      bid,
      cancel: [],
    });
  });

  test('replaces a partly filled bid at a new price for only what is left to buy', () => {
    const task = taskOf({ quantity: 3 });
    const bid = bidOf({ maxExecutions: 3, executions: 1 });
    const snapshot = snapshotOf({ bestCompetingBid: eth('8.5'), ownBids: [bid] });
    expect(decide({ task, snapshot })).toEqual({
      type: 'place',
      price: eth('8.51'),
      quantity: 2,
      cancel: [bid],
    });
  });

  test('halts once its bids have bought the whole quantity', () => {
    const task = taskOf({ quantity: 2 });
    const ownBids = [
      bidOf({ id: '1', active: false, maxExecutions: 2, executions: 1 }),
      bidOf({ id: '2', active: false, maxExecutions: 1, executions: 1 }),
    ];
    expect(decide({ task, snapshot: snapshotOf({ ownBids }) })).toMatchObject({
      type: 'halt',
      reason: 'filled',
    });
  });

  describe('with maxItems', () => {
    const task = taskOf({ quantity: 2, maxItems: 3 });

    test('keeps bidding after a fill, for what the wallet may still hold', () => {
      const filled = bidOf({ id: '1', active: false, maxExecutions: 2, executions: 2 });
      expect(decide({ task, snapshot: snapshotOf({ ownBids: [filled], held: 2 }) })).toEqual({
        type: 'place',
        price: eth('8.01'),
        quantity: 1,
        cancel: [],
      });
    });

    test('withdraws its bid while the wallet holds maxItems', () => {
      const bid = bidOf({ maxExecutions: 2 });
      expect(decide({ task, snapshot: snapshotOf({ ownBids: [bid], held: 3 }) })).toEqual({
        type: 'wait',
        reason: 'maxItemsHeld',
        cancel: [bid],
      });
    });

    test('bids again once an item leaves the wallet', () => {
      expect(decide({ task, snapshot: snapshotOf({ held: 2 }) })).toMatchObject({
        type: 'place',
        quantity: 1,
      });
    });

    test('commits only what it may still buy against the balance', () => {
      expect(decide({ task, snapshot: snapshotOf({ held: 2, balance: eth('8.01') }) }).type).toBe(
        'place',
      );
    });
  });

  describe('with maxHeldValue', () => {
    test.each([
      ['bids for every item the cap leaves room for', { maxHeldValue: '20' }, 0, 2],
      ['counts held items at the floor', { maxHeldValue: '20' }, 1, 1],
      ['caps a quantity under maxItems by value', { maxHeldValue: '20', maxItems: 5 }, 0, 2],
      ['caps a quantity under value by maxItems', { maxHeldValue: '40', maxItems: 2 }, 0, 2],
      ['lets maxItems bind after fills', { maxHeldValue: '40', maxItems: 2 }, 1, 1],
    ])('%s', (_case, overrides, held, quantity) => {
      const task = taskOf({ quantity: 5, ...overrides });
      expect(decide({ task, snapshot: snapshotOf({ held }) })).toMatchObject({
        type: 'place',
        price: eth('8.01'),
        quantity,
      });
    });

    test('keeps bidding after a fill instead of halting', () => {
      const task = taskOf({ maxHeldValue: '20' });
      const filled = bidOf({ id: '1', active: false, executions: 1 });
      expect(decide({ task, snapshot: snapshotOf({ ownBids: [filled], held: 1 }) })).toEqual({
        type: 'place',
        price: eth('8.01'),
        quantity: 1,
        cancel: [],
      });
    });

    test('withdraws its bid once the next item would take the holding past the cap', () => {
      const task = taskOf({ maxHeldValue: '18' });
      const bid = bidOf();
      expect(decide({ task, snapshot: snapshotOf({ ownBids: [bid], held: 1 }) })).toEqual({
        type: 'wait',
        reason: 'maxHeldValue',
        cancel: [bid],
      });
    });

    test('waits for a floor to value the items it holds', () => {
      const task = taskOf({ maxHeldValue: '20' });
      expect(decide({ task, snapshot: snapshotOf({ floorPrice: null, held: 1 }) })).toMatchObject({
        type: 'wait',
        reason: 'noPrice',
      });
    });

    test('needs no floor while it holds nothing', () => {
      const task = taskOf({ maxHeldValue: '20' });
      expect(decide({ task, snapshot: snapshotOf({ floorPrice: null }) })).toMatchObject({
        type: 'place',
        quantity: 1,
      });
    });
  });

  test('halts when the floor moves past the threshold, in either direction', () => {
    const task = taskOf({ haltOnFloorMovePercent: 10 });
    expect(decide({ task, snapshot: snapshotOf({ floorPrice: eth('11') }) }).type).toBe('place');
    expect(decide({ task, snapshot: snapshotOf({ floorPrice: eth('11.01') }) })).toMatchObject({
      type: 'halt',
      reason: 'floorMoved',
    });
    expect(decide({ task, snapshot: snapshotOf({ floorPrice: eth('8.99') }) })).toMatchObject({
      type: 'halt',
      reason: 'floorMoved',
    });
  });

  test.each([
    ['insufficientBalance', { snapshot: snapshotOf({ balance: eth('8') }) }],
    ['insufficientAllowance', { snapshot: snapshotOf({ allowance: eth('8') }) }],
    ['exposureLimit', { exposureAvailable: eth('8') }],
  ] as const)('waits on %s and withdraws what it cannot back', (reason, overrides) => {
    const bid = bidOf();
    const snapshot = {
      ...snapshotOf({ ownBids: [bid] }),
      ...('snapshot' in overrides ? { ...overrides.snapshot, ownBids: [bid] } : {}),
    };
    expect(decide({ ...overrides, snapshot })).toEqual({ type: 'wait', reason, cancel: [bid] });
  });

  test('commits price times quantity against the balance', () => {
    const task = taskOf({ quantity: 3 });
    expect(decide({ task, snapshot: snapshotOf({ balance: eth('24') }) })).toMatchObject({
      type: 'wait',
      reason: 'insufficientBalance',
    });
  });
});

describe('reconcile at a loss cap', () => {
  test('withdraws its bid and waits', () => {
    const bid = bidOf();
    expect(decide({ snapshot: snapshotOf({ ownBids: [bid] }), lossLimitReached: true })).toEqual({
      type: 'wait',
      reason: 'lossLimit',
      cancel: [bid],
    });
  });

  test('still halts a task that bought its quantity', () => {
    const bid = bidOf({ executions: 1, active: false });
    expect(decide({ snapshot: snapshotOf({ ownBids: [bid] }), lossLimitReached: true })).toEqual({
      type: 'halt',
      reason: 'filled',
      cancel: [],
    });
  });
});

describe('reconcile on a crossed book', () => {
  test('withdraws its bid while the floor is under the best competing bid', () => {
    const bid = bidOf();
    const snapshot = snapshotOf({
      floorPrice: eth('7'),
      bestCompetingBid: eth('8'),
      ownBids: [bid],
    });
    expect(decide({ snapshot })).toEqual({ type: 'wait', reason: 'crossedBook', cancel: [bid] });
  });

  test('waits rather than halting on a floor move when the floor is under the best bid', () => {
    const task = taskOf({ haltOnFloorMovePercent: 20 });
    const snapshot = snapshotOf({ floorPrice: 6n, bestCompetingBid: eth('8') });
    expect(decide({ task, snapshot })).toEqual({
      type: 'wait',
      reason: 'crossedBook',
      cancel: [],
    });
  });

  test.each([
    [
      'a floor equal to the best bid',
      snapshotOf({ floorPrice: eth('8'), bestCompetingBid: eth('8') }),
    ],
    ['no best bid', snapshotOf({ floorPrice: eth('7'), bestCompetingBid: null })],
    ['no floor', snapshotOf({ floorPrice: null, bestCompetingBid: eth('8') })],
  ])('bids as usual with %s', (_case, snapshot) => {
    expect(decide({ snapshot }).type).toBe('place');
  });
});

describe('reconcile with a bid the marketplace will not cancel yet', () => {
  const recent = bidOf({ id: 'recent', cancellableFrom: new Date(NOW.getTime() + 60_000) });

  test('keeps the bid rather than placing a second one beside it at the new price', () => {
    const snapshot = snapshotOf({ bestCompetingBid: eth('8.5'), ownBids: [recent] });
    expect(decide({ snapshot })).toEqual({ type: 'keep', bid: recent, cancel: [] });
  });

  test('withdraws the older duplicates it can and leaves the rest to a later round', () => {
    const cancellable = bidOf({ id: 'old', placedAt: new Date('2029-12-31T23:00:00Z') });
    const locked = bidOf({
      id: 'locked',
      placedAt: new Date('2029-12-31T23:58:00Z'),
      cancellableFrom: new Date(NOW.getTime() + 30_000),
    });
    const newest = { ...recent, placedAt: new Date('2029-12-31T23:59:00Z') };
    expect(decide({ snapshot: snapshotOf({ ownBids: [cancellable, locked, newest] }) })).toEqual({
      type: 'keep',
      bid: newest,
      cancel: [cancellable],
    });
  });

  test('waits without cancelling it, and cancels it once the marketplace allows', () => {
    const snapshot = snapshotOf({ ownBids: [recent] });
    expect(decide({ snapshot, lossLimitReached: true })).toEqual({
      type: 'wait',
      reason: 'lossLimit',
      cancel: [],
    });
    expect(
      decide({ snapshot, lossLimitReached: true, now: new Date(NOW.getTime() + 60_000) }),
    ).toEqual({ type: 'wait', reason: 'lossLimit', cancel: [recent] });
  });

  test('replaces it as usual once it can be cancelled', () => {
    const snapshot = snapshotOf({ bestCompetingBid: eth('8.5'), ownBids: [recent] });
    expect(decide({ snapshot, now: new Date(NOW.getTime() + 60_000) })).toEqual({
      type: 'place',
      price: eth('8.51'),
      quantity: 1,
      cancel: [recent],
    });
  });
});
