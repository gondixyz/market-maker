import { describe, expect, test } from 'bun:test';

import { targetBidPrice } from '../src/engine/pricing';
import { OPENSEA_PRICE_STEP } from '../src/opensea/market';
import { eth, snapshotOf, taskOf } from './fakeMarket';

describe('targetBidPrice', () => {
  test('outbids the best competing bid by the configured steps', () => {
    const task = taskOf({ pricing: { mode: 'outbid', steps: 2 } });
    expect(targetBidPrice(task, snapshotOf({ bestCompetingBid: eth('8') }))).toBe(eth('8.02'));
  });

  test('bids the minimum when nobody else bids', () => {
    expect(targetBidPrice(taskOf(), snapshotOf({ bestCompetingBid: null }))).toBe(eth('5'));
  });

  test('stops at the maximum instead of following the competition up', () => {
    expect(targetBidPrice(taskOf(), snapshotOf({ bestCompetingBid: eth('12') }))).toBe(eth('9'));
  });

  test('bids a share of the floor, rounded down onto the step', () => {
    const task = taskOf({ pricing: { mode: 'floor', percent: 77.77 } });
    expect(targetBidPrice(task, snapshotOf({ floorPrice: eth('10') }))).toBe(eth('7.77'));
    expect(targetBidPrice(task, snapshotOf({ floorPrice: eth('10.009') }))).toBe(eth('7.78'));
  });

  test('bids the price steps under the floor, never the floor itself', () => {
    const oneStep = taskOf({ pricing: { mode: 'floor', steps: 1 }, maxPrice: '20' });
    const threeSteps = taskOf({ pricing: { mode: 'floor', steps: 3 }, maxPrice: '20' });
    expect(targetBidPrice(oneStep, snapshotOf({ floorPrice: eth('10') }))).toBe(eth('9.99'));
    expect(targetBidPrice(oneStep, snapshotOf({ floorPrice: eth('10.009') }))).toBe(eth('10'));
    expect(targetBidPrice(threeSteps, snapshotOf({ floorPrice: eth('10') }))).toBe(eth('9.97'));
  });

  test('holds a bid under the floor within the price limits', () => {
    const task = taskOf({ pricing: { mode: 'floor', steps: 1 } });
    expect(targetBidPrice(task, snapshotOf({ floorPrice: eth('10') }))).toBe(eth('9'));
    expect(targetBidPrice(task, snapshotOf({ floorPrice: null }))).toBeNull();
  });

  test('has no price for a floor rule without a floor', () => {
    const task = taskOf({ pricing: { mode: 'floor', percent: 90 } });
    expect(targetBidPrice(task, snapshotOf({ floorPrice: null }))).toBeNull();
  });

  test('raises a fixed price below the minimum to the first step at or above it', () => {
    const task = taskOf({ pricing: { mode: 'fixed', price: '1' }, minPrice: '5.005' });
    expect(targetBidPrice(task, snapshotOf())).toBe(eth('5.01'));
  });

  test('has no price when no step lies within the limits', () => {
    const task = taskOf({
      pricing: { mode: 'fixed', price: '5' },
      minPrice: '5.001',
      maxPrice: '5.009',
    });
    expect(targetBidPrice(task, snapshotOf())).toBeNull();
  });

  test('leaves prices unrounded when the marketplace has no step', () => {
    const task = taskOf({ pricing: { mode: 'fixed', price: '6.123' } });
    expect(targetBidPrice(task, snapshotOf({ priceStep: 0n }))).toBe(eth('6.123'));
  });

  test('outbids by steps on OpenSea instead of tying the best offer', () => {
    const task = taskOf({
      venue: 'opensea',
      pricing: { mode: 'outbid', steps: 1 },
      maxItems: 1,
    });
    const snapshot = snapshotOf({ priceStep: OPENSEA_PRICE_STEP, bestCompetingBid: eth('5.5') });
    expect(targetBidPrice(task, snapshot)).toBe(eth('5.5') + 1n);
  });

  describe('joining a competing level', () => {
    const task = taskOf({
      venue: 'opensea',
      pricing: { mode: 'level', level: 3 },
      maxItems: 1,
      minPrice: '1',
    });
    const levels = [eth('8.5'), eth('8.2'), eth('7.9'), eth('7')];

    test('bids the price of that level', () => {
      const snapshot = snapshotOf({ priceStep: OPENSEA_PRICE_STEP, competingBidLevels: levels });
      expect(targetBidPrice(task, snapshot)).toBe(eth('7.9'));
    });

    test('has no price with fewer levels than it names', () => {
      const snapshot = snapshotOf({
        priceStep: OPENSEA_PRICE_STEP,
        competingBidLevels: levels.slice(0, 2),
      });
      expect(targetBidPrice(task, snapshot)).toBeNull();
    });

    test('has no price from a market that does not read the levels', () => {
      expect(targetBidPrice(task, snapshotOf({ priceStep: OPENSEA_PRICE_STEP }))).toBeNull();
    });

    test('stays at the minimum when the level sits under it', () => {
      const snapshot = snapshotOf({
        priceStep: OPENSEA_PRICE_STEP,
        competingBidLevels: [eth('2'), eth('1'), eth('0.5')],
      });
      expect(targetBidPrice(task, snapshot)).toBe(eth('1'));
    });
  });

  describe('outbidding by a percentage', () => {
    const task = taskOf({ pricing: { mode: 'outbid', percent: 0.5 }, maxPrice: '20' });

    test.each([
      ['lands on a step', '8', '8.04'],
      ['rounds up onto the step', '8.1', '8.15'],
    ])('%s', (_case, bestCompetingBid, expected) => {
      const snapshot = snapshotOf({ bestCompetingBid: eth(bestCompetingBid) });
      expect(targetBidPrice({ ...task, minPrice: 0n }, snapshot)).toBe(eth(expected));
    });

    test('stays a step above the best bid when the share rounds to nothing', () => {
      const tiny = taskOf({ pricing: { mode: 'outbid', percent: 0.001 } });
      expect(targetBidPrice(tiny, snapshotOf())).toBe(eth('8.01'));
    });

    test('bids the minimum when nobody else bids', () => {
      expect(targetBidPrice(task, snapshotOf({ bestCompetingBid: null }))).toBe(eth('5'));
    });
  });

  describe('with maxFloorPercent', () => {
    const task = taskOf({ pricing: { mode: 'outbid', percent: 0.5 }, maxFloorPercent: 80 });

    test.each([
      ['the floor share when it is under maxPrice', { floorPrice: eth('10') }, '8'],
      [
        'maxPrice when it is under the floor share',
        { floorPrice: eth('20'), bestCompetingBid: eth('12') },
        '9',
      ],
      ['the rule price when both caps are above it', { bestCompetingBid: eth('7') }, '7.04'],
      ['the floor share rounded down onto the step', { floorPrice: eth('10.005') }, '8'],
    ])('bids %s', (_case, overrides, expected) => {
      expect(targetBidPrice(task, snapshotOf(overrides))).toBe(eth(expected));
    });

    test('does not bid without a floor', () => {
      expect(targetBidPrice(task, snapshotOf({ floorPrice: null }))).toBeNull();
    });

    test('does not bid when the floor share is under minPrice', () => {
      expect(targetBidPrice(task, snapshotOf({ floorPrice: eth('6') }))).toBeNull();
    });
  });
});
