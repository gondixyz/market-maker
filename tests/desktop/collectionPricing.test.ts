import { describe, expect, mock, test } from 'bun:test';
import type { Address } from 'viem';

import { collectionPricing } from '../../src/desktop/main/collectionPricing';
import type { Trait } from '../../src/engine/market';
import type { ApiOrder, CollectionMarket, OrdersFilter } from '../../src/gondi/api';
import { OPENSEA_PRICE_STEP } from '../../src/opensea/market';

const bidAt = (price: bigint) => ({ price }) as ApiOrder;

const apiWith = ({ floorPrice = 612n as bigint | null, bids = [] as ApiOrder[] } = {}) => ({
  collectionMarket: mock(async () => ({ collectionId: 7, floorPrice }) as CollectionMarket),
  priceStep: mock(async (_collectionId: number) => 10_000n),
  orders: mock(async (_filter: OrdersFilter) => ({ orders: bids, nextCursor: null })),
  traitMarket: mock(async (_collectionId: number, _trait: Trait, _currencies: Address[]) => ({
    traitId: 41,
    floorPrice: 900n as bigint | null,
  })),
});

const TRAIT = { type: 'Background', value: 'Blue' };

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

  test.each([
    ['a collection bid above every trait bid', [bidAt(500n)], [bidAt(400n)], 500n],
    ['a trait bid above the collection bids', [bidAt(300n)], [bidAt(450n), bidAt(420n)], 450n],
    ['trait bids only', [], [bidAt(420n)], 420n],
  ])(
    "reads a trait's floor and the top bid of its bids and the collection's: %s",
    async (_case, collectionBids, traitBids, topBid) => {
      const api = apiWith();
      api.orders.mockImplementation(async (filter: OrdersFilter) => ({
        orders: filter.traits ? traitBids : collectionBids,
        nextCursor: null,
      }));

      expect(await collectionPricing(api, 'decagon', 'gondi', TRAIT)).toEqual({
        priceStep: 10_000n,
        floor: 900n,
        topBid,
      });
      expect(api.traitMarket.mock.calls[0].slice(0, 2)).toEqual([7, TRAIT]);
      expect(api.orders.mock.calls.map(([filter]) => filter)).toContainEqual(
        expect.objectContaining({ traits: [41], orderTypes: ['TRAIT'] }),
      );
    },
  );
});
