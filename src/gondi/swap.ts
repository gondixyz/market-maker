import type { Gondi } from 'gondi';
import { type Address, erc20Abi, formatEther, formatUnits, parseAbi, parseGwei } from 'viem';

import { percentOf } from '../engine/basisPoints';
import { withGasHeadroom } from '../engine/gas';
import { WETH } from './market';

/** Circle's USDC on Ethereum mainnet, 6 decimals. */
export const USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
export const USDC_DECIMALS = 6;
/** Uniswap's SwapRouter02 on Ethereum mainnet. */
const SWAP_ROUTER: Address = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
/** Uniswap's QuoterV2 on Ethereum mainnet. */
const QUOTER: Address = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
/** The USDC/WETH pool's fee tier: 0.05%, the deepest USDC/WETH pool. */
const POOL_FEE = 500;

const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
const swapRouterAbi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);

/**
 * The least WETH, in wei, a swap of `usdc` (in USDC's 6-decimal units) may return: what GONDI's
 * ETH price says it is worth, less `maxSlippagePercent`. It comes from GONDI's price, not the
 * pool's quote, so a pool moved against the swap cannot lower it.
 */
export const swapMinimumOut = (usdc: bigint, ethUsd: number, maxSlippagePercent: number) => {
  const ethUsdMicros = BigInt(Math.round(ethUsd * 1e6));
  const fairWei = (usdc * 10n ** 18n) / ethUsdMicros;
  return percentOf(fairWei, 100 - maxSlippagePercent);
};

export type SwapOptions = {
  /** USDC's 6-decimal units to swap. */
  usdc: bigint;
  /** ETH's USD price the minimum out is measured against. */
  ethUsd: number;
  maxSlippagePercent: number;
  /** No swap while gas costs more than this, in gwei. */
  maxGasGwei: number;
  /** Send the swap; without it only the quote is printed. */
  send: boolean;
  log: (line: string) => void;
};

/**
 * Swaps the wallet's USDC into WETH on Uniswap's 0.05% USDC/WETH pool, or only quotes it unless
 * `send`. It refuses when the wallet holds less USDC, when the quote is under `swapMinimumOut`,
 * or when gas is over `maxGasGwei`, and the swap itself reverts if it would return less than that
 * minimum. It approves the router for exactly `usdc` first when the allowance is short.
 *
 * IMPLEMENTATION NOTE: QuoterV2's `quoteExactInputSingle` is not a view function: it runs the
 * swap and reverts with the result, so it is read with `simulateContract`
 * (https://docs.uniswap.org/contracts/v3/reference/periphery/lens/QuoterV2). SwapRouter02's
 * `exactInputSingle` takes no deadline and reverts when the output is under `amountOutMinimum`
 * (https://docs.uniswap.org/contracts/v3/reference/periphery/interfaces/ISwapRouter); the
 * addresses are Uniswap's Ethereum deployments
 * (https://docs.uniswap.org/contracts/v3/reference/deployments/ethereum-deployments). viem's
 * `writeContract` and `waitForTransactionReceipt` send and wait for each transaction
 * (https://viem.sh/docs/contract/writeContract).
 */
export const swapUsdcForWeth = async (gondi: Gondi, options: SwapOptions) => {
  const { usdc, ethUsd, maxSlippagePercent, maxGasGwei, send, log } = options;
  const account = gondi.account.address;
  const balance = await gondi.bcClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account],
  });
  if (balance < usdc) {
    throw new Error(`${account} holds only ${formatUnits(balance, USDC_DECIMALS)} USDC`);
  }
  const {
    result: [quoted],
  } = await gondi.bcClient.simulateContract({
    address: QUOTER,
    abi: quoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: USDC, tokenOut: WETH, amountIn: usdc, fee: POOL_FEE, sqrtPriceLimitX96: 0n }],
  });
  const minimumOut = swapMinimumOut(usdc, ethUsd, maxSlippagePercent);
  const amount = formatUnits(usdc, USDC_DECIMALS);
  log(
    `${amount} USDC quotes ${formatEther(quoted)} WETH on Uniswap; the swap needs at least ` +
      `${formatEther(minimumOut)} WETH (ETH at $${ethUsd}, ${maxSlippagePercent}% slippage)`,
  );
  if (quoted < minimumOut) throw new Error('the quote is under the minimum: not swapping');
  const gasPrice = await gondi.bcClient.getGasPrice();
  if (gasPrice > parseGwei(String(maxGasGwei))) {
    throw new Error(`gas is ${formatUnits(gasPrice, 9)} gwei, over ${maxGasGwei}: not swapping`);
  }
  if (!send) {
    log('dry run: add send to swap');
    return;
  }
  const maxFeePerGas = withGasHeadroom(gasPrice);
  const allowance = await gondi.bcClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account, SWAP_ROUTER],
  });
  if (allowance < usdc) {
    const approval = await gondi.wallet.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'approve',
      args: [SWAP_ROUTER, usdc],
      maxFeePerGas,
    });
    const approved = await gondi.bcClient.waitForTransactionReceipt({ hash: approval });
    if (approved.status !== 'success') throw new Error(`approving USDC reverted in ${approval}`);
  }
  const hash = await gondi.wallet.writeContract({
    address: SWAP_ROUTER,
    abi: swapRouterAbi,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: USDC,
        tokenOut: WETH,
        fee: POOL_FEE,
        recipient: account,
        amountIn: usdc,
        amountOutMinimum: minimumOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
    maxFeePerGas,
  });
  const receipt = await gondi.bcClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`the swap reverted in ${hash}`);
  log(`swapped ${amount} USDC into WETH in ${hash}`);
};
