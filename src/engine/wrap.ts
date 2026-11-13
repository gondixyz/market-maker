import { parseEther } from 'viem';

/** The least ETH the bot wraps at once: under it, the transaction's gas outweighs the WETH it adds. */
export const MIN_WRAP = parseEther('0.01');

/**
 * How much of the wallet's ETH to wrap into WETH so it holds `target` WETH, the most its bids may
 * commit, while keeping `keepEth` ETH for gas: all the ETH over that reserve when it falls short,
 * and `0n` when WETH already covers the target or the wrap would be under `MIN_WRAP`.
 */
export const wrapAmount = ({
  eth,
  weth,
  target,
  keepEth,
}: {
  eth: bigint;
  weth: bigint;
  target: bigint;
  keepEth: bigint;
}) => {
  const spare = eth - keepEth;
  const shortfall = target - weth;
  const amount = spare < shortfall ? spare : shortfall;
  return amount >= MIN_WRAP ? amount : 0n;
};
