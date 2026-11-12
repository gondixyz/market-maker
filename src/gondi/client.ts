import { Gondi } from 'gondi';
import { type Address, type Chain, createWalletClient, http, type LocalAccount } from 'viem';

import type { Venue } from '../engine/market';
import { OPENSEA_CONDUIT } from '../opensea/market';
import { SEAPORT, WETH } from './market';

/** The contract each venue's bids pay WETH through, which the wallet lets spend it, and its name. */
export const WETH_SPENDER: Record<Venue, { address: Address; name: string }> = {
  gondi: { address: SEAPORT, name: 'Seaport' },
  opensea: { address: OPENSEA_CONDUIT, name: "OpenSea's conduit" },
};

/** A GONDI client that signs as `account` on `chain`, through `rpcUrl` or viem's public default. */
export const gondiFor = (account: LocalAccount, chain: Chain, rpcUrl?: string) =>
  new Gondi({ wallet: createWalletClient({ account, chain, transport: http(rpcUrl) }) });

/** The client's wallet's ETH and WETH balances, in wei. */
export const walletBalances = async (gondi: Gondi) => {
  const [eth, weth] = await Promise.all([
    gondi.bcClient.getBalance({ address: gondi.account.address }),
    gondi.currencyBalance({ tokenAddress: WETH }),
  ]);
  return { eth, weth };
};

/**
 * Lets `venue`'s WETH spender spend `amount` WETH from the client's wallet, the one transaction
 * that venue's bids need, and resolves with its hash once it is mined. Only ever called on an
 * explicit user action.
 */
export const approveWeth = async (gondi: Gondi, amount: bigint, venue: Venue) => {
  const approval = await gondi.approveToken({
    tokenAddress: WETH,
    amount,
    to: WETH_SPENDER[venue].address,
  });
  await approval.waitTxInBlock();
  return approval.txHash;
};
