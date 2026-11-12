import { describe, expect, test } from 'bun:test';
import type { Gondi } from 'gondi';

import type { BidScope } from '../src/engine/market';
import type { ApiOrder, GondiApi, OrdersFilter } from '../src/gondi/api';
import { bidLevels, GondiMarket } from '../src/gondi/market';
import { bidOf } from './fakeMarket';

const MINUTE = 60_000;
const PAGE = 50;

const bid = (id: number, minutesAgo: number, overrides: Partial<ApiOrder> = {}): ApiOrder => ({
  __typename: 'CollectionOrder',
  id,
  price: 1n,
  steppedPrice: null,
  currencyAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  maker: '0x0000000000000000000000000000000000000001',
  isAsk: false,
  status: 'OrderStatus.Cancelled',
  startTime: new Date(Date.now() - minutesAgo * MINUTE),
  expiration: new Date(Date.now() + 60 * MINUTE),
  executions: 0,
  maxExecutions: 1,
  cancelsOffChain: true,
  marketPlace: 'MarketPlace.Native',
  collectionId: 7,
  ...overrides,
});

/**
 * A `GondiApi` holding the wallet's own bids, which pages its closed ones newest first and counts
 * every closed-bid page it serves.
 */
class StubApi {
  active: ApiOrder[] = [];
  closed: ApiOrder[] = [];
  competing: ApiOrder[] = [];
  closedPagesRead = 0;
  competingReads: OrdersFilter[] = [];

  constructor(
    private readonly collectionId = 7,
    private readonly floorPrice: bigint | null = null,
  ) {}

  async collectionMarket() {
    return {
      collectionId: this.collectionId,
      contractAddress: '0x0000000000000000000000000000000000000002',
      seaportConduitKey: `0x${'0'.repeat(64)}`,
      floorPrice: this.floorPrice,
      royalties: [],
    };
  }

  async priceStep() {
    return 1n;
  }

  async orders(filter: OrdersFilter) {
    if (filter.excludeMakers) {
      this.competingReads.push(filter);
      const start = Number(filter.after ?? 0);
      const end = start + (filter.limit ?? this.competing.length);
      return {
        orders: this.competing.slice(start, end),
        nextCursor: end < this.competing.length ? String(end) : null,
      };
    }
    if (filter.statuses?.includes('Active')) return { orders: this.active, nextCursor: null };
    this.closedPagesRead += 1;
    const newestFirst = this.closed.toSorted(
      (left, right) => right.startTime.getTime() - left.startTime.getTime(),
    );
    const start = Number(filter.after ?? 0);
    const end = start + (filter.limit ?? PAGE);
    return {
      orders: newestFirst.slice(start, end),
      nextCursor: end < newestFirst.length ? String(end) : null,
    };
  }
}

const gondi = {
  account: { address: '0x0000000000000000000000000000000000000001' },
  bcClient: { readContract: async () => 0n },
  currencyBalance: async () => 0n,
  currencyAllowance: async () => 0n,
} as unknown as Gondi;

const marketOn = (api: StubApi, priceApi?: StubApi) =>
  new GondiMarket(gondi, api as unknown as GondiApi, priceApi as unknown as GondiApi | undefined);
const scope = { slug: 'pudgypenguins' } as never;

describe('GondiMarket', () => {
  test('reads closed bids in full once, then only those that can have closed since', async () => {
    const api = new StubApi();
    const since = new Date(Date.now() - 10_000 * MINUTE);
    api.closed = [
      bid(1, 9_000, { executions: 1, status: 'OrderStatus.Executed' }),
      ...Array.from({ length: 2 * PAGE }, (_, index) => bid(100 + index, 5_000 - index)),
    ];
    api.active = [bid(2, 8_000)];
    const market = marketOn(api);

    const first = await market.snapshot(scope, since);
    const firstPages = api.closedPagesRead;
    api.active = [];
    api.closed.push(bid(2, 8_000, { executions: 1 }));
    const second = await market.snapshot(scope, since);

    expect(firstPages).toBe(3);
    expect(api.closedPagesRead - firstPages).toBe(3);
    expect(first.ownBids.map((own) => own.id)).toEqual(['2', '1']);
    expect(second.ownBids.map((own) => own.id)).toEqual(['1', '2']);

    const third = await market.snapshot(scope, since);

    expect(api.closedPagesRead - firstPages).toBe(4);
    expect(third.ownBids.map((own) => own.id)).toEqual(['1', '2']);
  });

  test('an adopted bid placed before the run does not hold the read back', async () => {
    const api = new StubApi();
    const since = new Date(Date.now() - 10 * MINUTE);
    api.closed = Array.from({ length: 2 * PAGE }, (_, index) => bid(100 + index, 9 - index / 20));
    api.active = [bid(3, 60)];
    const market = marketOn(api);

    await market.snapshot(scope, since);
    const firstPages = api.closedPagesRead;
    api.active = [];
    api.closed.push(bid(3, 60));
    await market.snapshot(scope, since);
    await market.snapshot(scope, since);

    expect(api.closedPagesRead - firstPages).toBe(2);
  });

  test('reads prices from the price API and the own bids from the main one', async () => {
    const api = new StubApi(7, 100n);
    api.active = [bid(2, 1, { status: 'OrderStatus.Active' })];
    api.competing = [bid(3, 1, { price: 50n })];
    const priceApi = new StubApi(1_234, 6n);
    priceApi.competing = [bid(4, 1, { price: 5n })];

    const snapshot = await marketOn(api, priceApi).snapshot(scope, new Date());

    expect(snapshot.floorPrice).toBe(6n);
    expect(snapshot.bestCompetingBid).toBe(5n);
    expect(snapshot.ownBids.map((own) => own.id)).toEqual(['2']);
    expect(api.competingReads).toEqual([]);
    expect(priceApi.competingReads.map((filter) => filter.collections)).toEqual([[1_234]]);
  });
});

describe('bidLevels', () => {
  test.each([
    ['no orders', [], []],
    ['one level per distinct price, best first', [9n, 7n, 9n, 8n], [9n, 8n, 7n]],
    ['the stepped price where the API steps it', [9n, [10n, 8n]], [9n, 8n]],
  ] as [string, (bigint | [bigint, bigint])[], bigint[]][])('%s', (_case, prices, levels) => {
    const orders = prices.map((price, index) =>
      Array.isArray(price)
        ? bid(index, 1, { price: price[0], steppedPrice: price[1] })
        : bid(index, 1, { price }),
    );

    expect(bidLevels(orders)).toEqual(levels);
  });
});

describe('GondiMarket competing bid levels', () => {
  const levelsScope = (levels: number): BidScope => ({
    kind: 'collection',
    slug: 'pudgypenguins',
    venue: 'gondi',
    levels,
  });
  const book = (prices: bigint[]) => prices.map((price, index) => bid(500 + index, 1, { price }));

  test('reads one order for the best bid alone', async () => {
    const api = new StubApi();
    api.competing = book([9n, 8n, 7n]);

    const snapshot = await marketOn(api).snapshot(scope, new Date());

    expect([snapshot.bestCompetingBid, snapshot.competingBidLevels]).toEqual([9n, [9n]]);
    expect(api.competingReads.map((filter) => filter.limit)).toEqual([1]);
  });

  test('pages the book until it holds the levels the scope asks for', async () => {
    const api = new StubApi();
    api.competing = book([...Array(30).fill(9n), 8n, 8n, 7n, 6n, ...Array(20).fill(5n)]);

    const snapshot = await marketOn(api).snapshot(levelsScope(3), new Date());

    expect([snapshot.bestCompetingBid, snapshot.competingBidLevels]).toEqual([9n, [9n, 8n, 7n]]);
    expect(api.competingReads.map((filter) => filter.after)).toEqual([undefined, '20']);
  });

  test('returns fewer levels when the book ends first, or after its page cap', async () => {
    const shallow = new StubApi();
    shallow.competing = book([9n, 8n]);
    const deep = new StubApi();
    deep.competing = book(Array(1_000).fill(9n));

    const fromShallow = await marketOn(shallow).snapshot(levelsScope(5), new Date());
    const fromDeep = await marketOn(deep).snapshot(levelsScope(2), new Date());

    expect(fromShallow.competingBidLevels).toEqual([9n, 8n]);
    expect(fromDeep.competingBidLevels).toEqual([9n]);
    expect(deep.competingReads).toHaveLength(25);
  });
});

describe('GondiMarket bids', () => {
  test('signs the start time placedAt reports and cancels by the numeric order id', async () => {
    const madeOrders: { startTime: bigint }[] = [];
    const cancelledOrderIds: number[][] = [];
    const market = new GondiMarket(
      {
        ...gondi,
        makeOrder: async (order: { startTime: bigint }) => {
          madeOrders.push(order);
          return { id: 42n };
        },
        cancelOrders: async ({ orderIds }: { orderIds: number[] }) => {
          cancelledOrderIds.push(orderIds);
        },
      } as unknown as Gondi,
      new StubApi() as unknown as GondiApi,
    );
    await market.snapshot(scope, new Date());

    const placed = await market.placeBid({
      scope,
      price: 1n,
      quantity: 1,
      expiration: new Date(Date.now() + 60 * MINUTE),
    });
    await market.cancelBids([bidOf({ id: '42' })]);

    expect(placed.id).toBe('42');
    expect(placed.placedAt.getTime() / 1_000).toBe(Number(madeOrders[0]?.startTime));
    expect(cancelledOrderIds).toEqual([[42]]);
  });
});

describe('GondiMarket.listingMarket', () => {
  test('reads the best competing bid from the price API, beside the cheapest ask', async () => {
    const api = new StubApi();
    const priceApi = new StubApi(1_234);
    priceApi.competing = [bid(4, 1, { price: 5n, steppedPrice: 5n })];
    const market = new GondiMarket(
      { ...gondi, isApprovedNFTForAll: async () => true } as unknown as Gondi,
      api as unknown as GondiApi,
      priceApi as unknown as GondiApi,
    );

    const book = await market.listingMarket('pudgypenguins');

    expect(book.bestCompetingBid).toBe(5n);
    expect(priceApi.competingReads.map((filter) => filter.side).sort()).toEqual(['ASK', 'BID']);
  });
});
