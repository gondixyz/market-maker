import { describe, expect, test } from 'bun:test';
import { parseEther, parseUnits } from 'viem';

import { swapMinimumOut } from '../src/gondi/swap';

describe('swapMinimumOut', () => {
  test.each([
    { case: 'the fair amount with no slippage', usdc: '4000', ethUsd: 2000, slippage: 0, out: '2' },
    { case: '1% under the fair amount', usdc: '4000', ethUsd: 2000, slippage: 1, out: '1.98' },
    { case: 'a fractional price', usdc: '1813', ethUsd: 1813, slippage: 0.5, out: '0.995' },
    { case: 'cents', usdc: '0.01', ethUsd: 1000, slippage: 0, out: '0.00001' },
  ])('is $case', ({ usdc, ethUsd, slippage, out }) => {
    expect(swapMinimumOut(parseUnits(usdc, 6), ethUsd, slippage)).toBe(parseEther(out));
  });
});
