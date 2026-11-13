import { describe, expect, test } from 'bun:test';

import { wrapAmount } from '../src/engine/wrap';
import { eth } from './fakeMarket';

describe('wrapAmount', () => {
  test.each([
    { case: 'the shortfall, when the spare ETH covers it', eth: '5', weth: '1', wrap: '2' },
    { case: 'all the spare ETH, when it falls short', eth: '1.05', weth: '1', wrap: '1' },
    { case: 'nothing, when WETH covers the target', eth: '5', weth: '3', wrap: '0' },
    { case: 'nothing, when WETH is over the target', eth: '5', weth: '4', wrap: '0' },
    { case: 'nothing, when no ETH is over the reserve', eth: '0.05', weth: '0', wrap: '0' },
    { case: 'nothing, when ETH is under the reserve', eth: '0.01', weth: '0', wrap: '0' },
    { case: 'nothing under 0.01 ETH', eth: '0.059', weth: '0', wrap: '0' },
    { case: '0.01 ETH, the least it wraps', eth: '0.06', weth: '0', wrap: '0.01' },
  ])('wraps $case', ({ eth: ethBalance, weth, wrap }) => {
    expect(
      wrapAmount({ eth: eth(ethBalance), weth: eth(weth), target: eth('3'), keepEth: eth('0.05') }),
    ).toBe(eth(wrap));
  });
});
