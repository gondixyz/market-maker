import { describe, expect, test } from 'bun:test';

import { type CollectionMarket, GondiApi, type OrdersFilter } from '../src/gondi/api';
import { activeListingIds, cancelListings } from '../src/gondi/listings';

const MAKER = '0x0000000000000000000000000000000000000001';

/** A GONDI listing as the API serves it, before `GondiApi` parses it. */
const listing = (id: number, marketPlace = 'MarketPlace.Native') => ({
  __typename: 'SingleNFTOrder',
  id: String(id),
  price: '1',
  steppedPrice: null,
  currencyAddress: '0x0000000000000000000000000000000000000000',
  maker: MAKER,
  isAsk: true,
  status: 'OrderStatus.Active',
  startTime: '2030-01-01T00:00:00Z',
  expiration: '2030-01-02T00:00:00Z',
  executions: 0,
  maxExecutions: 1,
  cancelsOffChain: false,
  marketPlace,
  nft: { id: String(id), tokenId: String(id) },
});

/**
 * The API with the listings it serves, in pages of `pageSize` behind a real `GondiApi`, recording
 * the variables of each orders query.
 */
const fakeApi = (listings: ReturnType<typeof listing>[], pageSize = 50) => {
  const variables: Record<string, unknown>[] = [];
  const post = async (_url: string | URL | Request, init?: RequestInit) => {
    const query = JSON.parse(init?.body as string) as { variables: Record<string, unknown> };
    variables.push(query.variables);
    const start = Number(query.variables.after ?? 0);
    const end = start + pageSize;
    return Response.json({
      data: {
        result: {
          edges: listings.slice(start, end).map((node) => ({ node })),
          pageInfo: { hasNextPage: end < listings.length, endCursor: String(end) },
        },
      },
    });
  };
  const api = new GondiApi('https://api.test', post as typeof fetch);
  return {
    variables,
    collectionMarket: async ({ slug }: { slug: string }) =>
      ({ collectionId: slug === 'pudgypenguins' ? 7 : 8 }) as CollectionMarket,
    allOrders: (filter: Omit<OrdersFilter, 'after'>) => api.allOrders(filter),
  };
};

describe('activeListingIds', () => {
  test("reads every page of the wallet's active GONDI listings on the collections", async () => {
    const api = fakeApi([listing(1), listing(2, 'MarketPlace.OpenSea'), listing(3)], 2);

    const ids = await activeListingIds(api, MAKER, ['pudgypenguins', 'azuki']);

    expect({ ids, variables: api.variables }).toMatchObject({
      ids: [1, 3],
      variables: [
        { side: 'ASK', collectionIds: [7, 8], maker: [MAKER], statuses: ['Active'] },
        { after: '2' },
      ],
    });
  });

  test('asks nothing when no strategy lists', async () => {
    const api = fakeApi([listing(1)]);

    expect(await activeListingIds(api, MAKER, [])).toEqual([]);
    expect(api.variables).toEqual([]);
  });
});

describe('cancelListings', () => {
  test('cancels on-chain, 50 a call, and waits for each transaction', async () => {
    const calls: { orderIds: number[]; onChain?: boolean }[] = [];
    const mined: string[] = [];
    const gondi = {
      cancelOrders: async (call: { orderIds: number[]; onChain?: boolean }) => {
        calls.push(call);
        const txHash = `0x${calls.length}` as const;
        return {
          offChainOrderIds: [],
          transactions: [{ txHash, waitTxInBlock: async () => mined.push(txHash) as never }],
        };
      },
    };

    const hashes = await cancelListings(
      gondi,
      Array.from({ length: 51 }, (_each, index) => index),
    );

    expect({
      sizes: calls.map((call) => [call.orderIds.length, call.onChain]),
      hashes,
      mined,
    }).toEqual({
      sizes: [
        [50, true],
        [1, true],
      ],
      hashes: ['0x1', '0x2'],
      mined: ['0x1', '0x2'],
    });
  });
});
