import { describe, expect, test } from 'bun:test';

import { aboveBy, belowBy, nextReference } from '../src/engine/reference';
import { eth } from './fakeMarket';

const NOW = new Date('2030-01-01T00:00:00Z');
const hoursLater = (hours: number) => new Date(NOW.getTime() + hours * 60 * 60_000);

describe('nextReference', () => {
  test.each([
    ['starts at the first sample', undefined, 0, '10'],
    ['moves half way to the sample after one half-life', 24, 24, '11'],
    ['moves three quarters of the way after two half-lives', 24, 48, '11.5'],
    ['stays put for a sample read no later than the last one', 24, 0, '10'],
  ])('%s', (_case, halfLife, hours, price) => {
    const previous = halfLife === undefined ? undefined : { price: eth('10'), at: NOW };
    const sample = halfLife === undefined ? eth('10') : eth('12');
    expect(nextReference(previous, sample, hoursLater(hours), 24).price).toBe(eth(price));
  });
});

describe('belowBy and aboveBy', () => {
  test('take a percent off or add one, rounding the addition up', () => {
    expect(belowBy(eth('10'), 2)).toBe(eth('9.8'));
    expect(aboveBy(eth('10'), 1)).toBe(eth('10.1'));
    expect(aboveBy(3n, 1)).toBe(4n);
  });
});
