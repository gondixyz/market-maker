import { describe, expect, mock, test } from 'bun:test';

import { collectionPricing } from '../../src/desktop/main/collectionPricing';
import type { ApiOrder, CollectionMarket, OrdersFilter } from '../../src/gondi/api';
import { OPENSEA_PRICE_STEP } from '../../src/opensea/market';

const bidAt = (price: bigint) => ({ price }) as ApiOrder;

const apiWith = ({ floorPrice = 612n as bigint | null, bids = [] as ApiOrder[] } = {}) => ({
  collectionMarket: mock(async () => ({ collectionId: 7, floorPrice }) as CollectionMarket),
  priceStep: mock(async (_collectionId: number) => 10_000n),
  orders: mock(async (_filter: OrdersFilter) => ({ orders: bids, nextCursor: null })),
});

describe('collectionPricing', () => {
  test("reads GONDI's step, the floor and the highest collection bid of the page", async () => {
    const api = apiWith({ bids: [bidAt(100n), bidAt(300n), bidAt(200n)] });

    expect(await collectionPricing(api, 'decagon', 'gondi')).toEqual({
      priceStep: 10_000n,
      floor: 612n,
      topBid: 300n,
    });
    expect(api.priceStep).toHaveBeenCalledWith(7);
    expect(api.orders.mock.calls[0][0]).toMatchObject({
      side: 'BID',
      collections: [7],
      orderTypes: ['COLLECTION'],
    });
  });

  test("uses OpenSea's step for an OpenSea bid without asking GONDI for one", async () => {
    const api = apiWith();

    expect((await collectionPricing(api, 'decagon', 'opensea')).priceStep).toBe(OPENSEA_PRICE_STEP);
    expect(api.priceStep).not.toHaveBeenCalled();
  });

  test('has no floor or top bid for a collection nobody lists or bids on', async () => {
    const api = apiWith({ floorPrice: null });

    expect(await collectionPricing(api, 'decagon', 'gondi')).toMatchObject({
      floor: null,
      topBid: null,
    });
  });

  test('still reads the step and the floor when the bids cannot be read', async () => {
    const api = apiWith();
    api.orders.mockImplementationOnce(async () => {
      throw new Error('rate limited');
    });

    expect(await collectionPricing(api, 'decagon', 'gondi')).toEqual({
      priceStep: 10_000n,
      floor: 612n,
      topBid: undefined,
    });
  });
});
