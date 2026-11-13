import { Gondi } from 'gondi';
import {
  type Address,
  type Chain,
  createWalletClient,
  http,
  isAddressEqual,
  type LocalAccount,
} from 'viem';

import { type Venue, VENUES } from '../engine/market';
import { OPENSEA_CONDUIT } from '../opensea/market';
import type { GondiApi } from './api';
import { approvalOperator, SEAPORT, WETH } from './market';

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

/** How much WETH each venue's spender may spend from the client's wallet, in wei. */
export const wethAllowances = async (gondi: Gondi) => {
  const amounts = await Promise.all(
    VENUES.map((venue) =>
      gondi.currencyAllowance({ tokenAddress: WETH, to: WETH_SPENDER[venue].address }),
    ),
  );
  return Object.fromEntries(VENUES.map((venue, index) => [venue, amounts[index]])) as Record<
    Venue,
    bigint
  >;
};

/** An approval sent but not yet mined: `waitMined` resolves once it is, and rejects if it reverts. */
export type SentApproval = { transactionHash: string; waitMined: () => Promise<void> };

/**
 * Sends the approval that lets `venue`'s WETH spender spend `amount` WETH from the client's
 * wallet, the one transaction that venue's bids need, and resolves as soon as it is broadcast.
 * Only ever called on an explicit user action.
 */
export const sendWethApproval = async (
  gondi: Gondi,
  amount: bigint,
  venue: Venue,
): Promise<SentApproval> => {
  const approval = await gondi.approveToken({
    tokenAddress: WETH,
    amount,
    to: WETH_SPENDER[venue].address,
  });
  return {
    transactionHash: approval.txHash,
    waitMined: async () => {
      await approval.waitTxInBlock();
    },
  };
};

/** Sends the approval of `sendWethApproval` and resolves with its hash once it is mined. */
export const approveWeth = async (gondi: Gondi, amount: bigint, venue: Venue) => {
  const approval = await sendWethApproval(gondi, amount, venue);
  await approval.waitMined();
  return approval.transactionHash;
};

/** Which contract may move a collection's items for its listings, and whether it already may. */
export type CollectionApproval = { contractAddress: Address; operator: Address; approved: boolean };

/**
 * The operator the wallet approves so the `slug` collection's items can be listed on GONDI, as
 * `approvalOperator` resolves it from the collection's Seaport conduit key, and whether the
 * client's wallet has approved it already.
 */
export const collectionApproval = async (
  gondi: Gondi,
  api: Pick<GondiApi, 'collectionMarket'>,
  slug: string,
): Promise<CollectionApproval> => {
  const { contractAddress, seaportConduitKey } = await api.collectionMarket({ slug });
  const operator = await approvalOperator(gondi, seaportConduitKey);
  const approved = await gondi.isApprovedNFTForAll({
    nftAddress: contractAddress,
    standard: 'ERC721',
    to: operator,
  });
  return { contractAddress, operator, approved };
};

/** The name a confirmation shows for a collection's operator: Seaport, OpenSea's conduit, or its address. */
export const operatorName = (operator: Address) =>
  isAddressEqual(operator, SEAPORT)
    ? 'Seaport'
    : isAddressEqual(operator, OPENSEA_CONDUIT)
      ? "OpenSea's conduit"
      : `the Seaport conduit ${operator}`;

/**
 * Sends the approval that lets the operator move every item of the collection from the client's
 * wallet, the one transaction its listings need, and resolves as soon as it is broadcast. Only
 * ever called on an explicit user action.
 */
export const sendCollectionApproval = async (
  gondi: Gondi,
  { contractAddress, operator }: Pick<CollectionApproval, 'contractAddress' | 'operator'>,
): Promise<SentApproval> => {
  const approval = await gondi.approveNFTForAll({
    nftAddress: contractAddress,
    standard: 'ERC721',
    to: operator,
  });
  return {
    transactionHash: approval.txHash,
    waitMined: async () => {
      await approval.waitTxInBlock();
    },
  };
};

/** Sends the approval of `sendCollectionApproval` and resolves with its hash once it is mined. */
export const approveCollection = async (
  gondi: Gondi,
  approval: Pick<CollectionApproval, 'contractAddress' | 'operator'>,
) => {
  const sent = await sendCollectionApproval(gondi, approval);
  await sent.waitMined();
  return sent.transactionHash;
};
