import type { Gondi } from 'gondi';
import type { Address } from 'viem';

import type { GondiApi } from './api';

const NATIVE_MARKETPLACE = 'MarketPlace.Native';
const PAGE = 50;
/** The most orders `gondi.cancelOrders` takes in one call. */
const MAX_CANCELS_PER_CALL = 50;

/**
 * The ids of every active GONDI listing `maker` has on the collections of `slugs`, read a page at
 * a time. Listings on other marketplaces are left out: the bot only lists on GONDI.
 */
export const activeListingIds = async (
  api: Pick<GondiApi, 'collectionMarket' | 'allOrders'>,
  maker: Address,
  slugs: string[],
): Promise<number[]> => {
  if (slugs.length === 0) return [];
  const collections = await Promise.all(slugs.map((slug) => api.collectionMarket({ slug })));
  const orders = await api.allOrders({
    side: 'ASK',
    collections: collections.map((collection) => collection.collectionId),
    orderTypes: ['SINGLE_NFT'],
    makers: [maker],
    statuses: ['Active'],
    limit: PAGE,
  });
  return orders
    .filter((order) => order.marketPlace === NATIVE_MARKETPLACE)
    .map((order) => order.id);
};

/**
 * Cancels the listings `orderIds` names on-chain, the only way a listing cancels, and resolves with
 * each transaction's hash once it is mined. Only ever called on an explicit, confirmed user action.
 *
 * IMPLEMENTATION NOTE: `gondi.cancelOrders({ orderIds, onChain: true })` asks the API for the
 * Seaport cancel calldata of at most 50 orders and sends one transaction per marketplace, returning
 * each as `{ txHash, waitTxInBlock }` (https://github.com/gondixyz/gondi-js, `Gondi.cancelOrders`).
 */
export const cancelListings = async (
  gondi: Pick<Gondi, 'cancelOrders'>,
  orderIds: number[],
): Promise<string[]> => {
  const hashes: string[] = [];
  for (let start = 0; start < orderIds.length; start += MAX_CANCELS_PER_CALL) {
    const { transactions } = await gondi.cancelOrders({
      orderIds: orderIds.slice(start, start + MAX_CANCELS_PER_CALL),
      onChain: true,
    });
    for (const transaction of transactions) {
      await transaction.waitTxInBlock();
      hashes.push(transaction.txHash);
    }
  }
  return hashes;
};
