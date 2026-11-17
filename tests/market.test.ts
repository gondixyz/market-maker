import { describe, expect, test } from 'bun:test';
import type { Gondi } from 'gondi';
import { zeroAddress } from 'viem';

import type { BidScope, ExitOffer } from '../src/engine/market';
import type { ApiOrder, GondiApi, HeldNft, OrdersFilter } from '../src/gondi/api';
import { bidLevels, GondiMarket, MULTI_SOURCE_LOAN, SEAPORT, WETH } from '../src/gondi/market';
import { bidOf, eth } from './fakeMarket';

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
  marketPlaceAddress: '0x0000000000000000000000000000000000000002',
  originalId: `0x${id}`,
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
  /** The other wallets' collection bids. */
  competing: ApiOrder[] = [];
  /** The other wallets' bids on the trait. */
  competingOnTrait: ApiOrder[] = [];
  closedPagesRead = 0;
  competingReads: OrdersFilter[] = [];
  ownReads: OrdersFilter[] = [];
  /** The trait every `traitMarket` call answers: its id on this deployment and its floor. */
  trait = { traitId: 42, floorPrice: 3n as bigint | null };
  traitReads: unknown[][] = [];
  heldItems: HeldNft[] = [];
  heldReads: unknown[] = [];

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

  async saleFeeBps() {
    return 250n;
  }

  async nftId() {
    return 42;
  }

  async traitMarket(...args: unknown[]) {
    this.traitReads.push(args);
    return this.trait;
  }

  async heldNfts(filter: unknown) {
    this.heldReads.push(filter);
    return this.heldItems;
  }

  async orders(filter: OrdersFilter) {
    if (filter.makers) this.ownReads.push(filter);
    if (filter.excludeMakers) {
      this.competingReads.push(filter);
      const book = filter.traits ? this.competingOnTrait : this.competing;
      const start = Number(filter.after ?? 0);
      const end = start + (filter.limit ?? book.length);
      return {
        orders: book.slice(start, end),
        nextCursor: end < book.length ? String(end) : null,
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

/** A `GondiMarket` on `api`, whose wallet holds `balance` items of every collection on-chain. */
const marketOn = (api: StubApi, priceApi?: StubApi, balance = 0n) =>
  new GondiMarket(
    { ...gondi, bcClient: { readContract: async () => balance } } as unknown as Gondi,
    api as unknown as GondiApi,
    priceApi as unknown as GondiApi | undefined,
  );
const scope: BidScope = { kind: 'collection', slug: 'pudgypenguins', venue: 'gondi' };
const BLUE = { type: 'Background', value: 'Blue' };
const traitScope: BidScope = { kind: 'trait', trait: BLUE, slug: 'pudgypenguins', venue: 'gondi' };

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

  test('reads its own bids as native WETH bids, so the API reads only its own orders', async () => {
    const api = new StubApi();

    await marketOn(api).snapshot(scope, new Date());

    expect(
      api.ownReads.map(({ marketplaces, currencies, statuses }) => ({
        marketplaces,
        currencies,
        active: statuses?.includes('Active'),
      })),
    ).toEqual([
      { marketplaces: ['NATIVE'], currencies: [WETH], active: true },
      { marketplaces: ['NATIVE'], currencies: [WETH], active: false },
    ]);
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

describe('GondiMarket trait bids', () => {
  test("reads the trait's book, floor and held items, and its own bids on the trait", async () => {
    const api = new StubApi(7, 100n);
    api.competingOnTrait = [bid(3, 1, { price: 2n })];
    api.heldItems = [
      { tokenId: 1n, traits: [BLUE] },
      { tokenId: 2n, traits: [BLUE] },
      { tokenId: 3n, traits: [{ type: 'Background', value: 'Red' }] },
    ];

    const snapshot = await marketOn(api, undefined, 3n).snapshot(traitScope, new Date());

    expect([snapshot.floorPrice, snapshot.bestCompetingBid, snapshot.held]).toEqual([3n, 2n, 2]);
    expect(api.traitReads).toEqual([[7, BLUE, [zeroAddress, WETH]]]);
    expect(
      api.competingReads.map(({ traits, collections, orderTypes }) => ({
        traits,
        collections,
        orderTypes,
      })),
    ).toEqual([
      { traits: [42], collections: undefined, orderTypes: ['TRAIT'] },
      { traits: undefined, collections: [7], orderTypes: ['COLLECTION'] },
    ]);
    expect(api.ownReads.every((filter) => filter.traits?.[0] === 42 && !filter.collections)).toBe(
      true,
    );
    expect(api.heldReads).toEqual([{ slug: 'pudgypenguins', owner: gondi.account.address }]);
  });

  test.each([
    ['a collection bid above every bid on the trait', [5n, 4n], [6n], [6n, 5n, 4n]],
    ['bids on the trait above the collection bids', [9n, 8n], [7n], [9n, 8n, 7n]],
    ['one level when both books bid the same price', [6n], [6n, 3n], [6n, 3n]],
    ['the collection bids alone', [], [4n], [4n]],
  ] as [string, bigint[], bigint[], bigint[]][])(
    'competes with the collection bids too: %s',
    async (_case, onTrait, onCollection, levels) => {
      const api = new StubApi();
      api.competingOnTrait = onTrait.map((price, index) => bid(100 + index, 1, { price }));
      api.competing = onCollection.map((price, index) => bid(200 + index, 1, { price }));

      const snapshot = await marketOn(api).snapshot({ ...traitScope, levels: 3 }, new Date());

      expect([snapshot.bestCompetingBid, snapshot.competingBidLevels]).toEqual([levels[0], levels]);
    },
  );

  test('counts an item the owners index does not show yet as one with the trait', async () => {
    const api = new StubApi(7, 100n);
    api.heldItems = [{ tokenId: 1n, traits: [{ type: 'Background', value: 'Red' }] }];

    const snapshot = await marketOn(api, undefined, 2n).snapshot(traitScope, new Date());

    expect(snapshot.held).toBe(1);
  });

  test('resolves the trait on each deployment when prices come from another', async () => {
    const api = new StubApi(7);
    api.trait = { traitId: 42, floorPrice: 100n };
    const priceApi = new StubApi(1_234);
    priceApi.trait = { traitId: 9_000, floorPrice: 4n };

    const snapshot = await marketOn(api, priceApi).snapshot(traitScope, new Date());

    expect(snapshot.floorPrice).toBe(4n);
    expect(priceApi.competingReads.map((filter) => filter.traits ?? filter.collections)).toEqual([
      [9_000],
      [1_234],
    ]);
    expect(api.ownReads.every((filter) => filter.traits?.[0] === 42)).toBe(true);
  });

  test('keeps the closed bids of a collection bid and a trait bid on it apart', async () => {
    const api = new StubApi();
    const since = new Date(Date.now() - 10 * MINUTE);
    const market = marketOn(api);

    await market.snapshot(scope, since);
    await market.snapshot(traitScope, since);
    await market.snapshot(scope, since);

    expect(
      api.ownReads.filter((filter) => !filter.statuses?.includes('Active')).map((f) => f.traits),
    ).toEqual([undefined, [42], undefined]);
  });

  test('places a trait bid on the trait id, without a collection id', async () => {
    const madeOrders: object[] = [];
    const market = new GondiMarket(
      {
        ...gondi,
        makeOrder: async (order: object) => {
          madeOrders.push(order);
          return { id: 43n };
        },
      } as unknown as Gondi,
      new StubApi() as unknown as GondiApi,
    );
    await market.snapshot(traitScope, new Date());

    await market.placeBid({
      scope: traitScope,
      price: 1n,
      quantity: 2,
      expiration: new Date(Date.now() + 60 * MINUTE),
    });

    expect(madeOrders[0]).toMatchObject({ traitIds: [42], maxExecutions: 2n });
    expect(madeOrders[0]).not.toHaveProperty('collectionId');
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

describe('GondiMarket bid exit', () => {
  const offer: ExitOffer = { id: '9', venue: 'gondi', netPrice: eth('2.34') };
  const sale = { scope: { slug: 'pudgypenguins', tokenId: 1n }, offer, minProceeds: eth('2.3') };

  /** A market on `api` whose wallet records each transaction it sends, at `gasPrice` per unit. */
  const sellingMarket = (api: StubApi, gasPrice: bigint) => {
    const sent: unknown[] = [];
    const wallet = {
      ...gondi,
      account: { address: '0x0000000000000000000000000000000000000001' },
      isApprovedNFTForAll: async () => true,
      apiClient: { getSaleCalldata: async () => ({ saleCalldata: '0xfeed' }) },
      bcClient: {
        readContract: async () => 0n,
        estimateGas: async () => 200_000n,
        getGasPrice: async () => gasPrice,
        waitForTransactionReceipt: async () => ({ status: 'success' }),
      },
      wallet: {
        sendTransaction: async (transaction: unknown) => {
          sent.push(transaction);
          return '0xhash';
        },
      },
    };
    return {
      market: new GondiMarket(wallet as unknown as Gondi, api as unknown as GondiApi),
      sent,
    };
  };

  test("takes the best live GONDI bid of another wallet, net of GONDI's fee", async () => {
    const api = new StubApi();
    api.competing = [
      bid(1, 1, { price: eth('3'), marketPlace: 'MarketPlace.OpenSea' }),
      bid(2, 1, { price: eth('2.9'), expiration: new Date(Date.now() - MINUTE) }),
      bid(3, 1, { price: eth('2.4') }),
      bid(4, 1, { price: eth('2.2') }),
    ];

    expect(await marketOn(api).exitOffer('pudgypenguins')).toEqual({
      id: '3',
      venue: 'gondi',
      netPrice: eth('2.34'),
    });
  });

  test('has no offer without a GONDI bid of another wallet', async () => {
    expect(await marketOn(new StubApi()).exitOffer('pudgypenguins')).toBeNull();
  });

  test('sends the sale to Seaport with its gas limit and fee capped', async () => {
    const api = new StubApi();
    const { market, sent } = sellingMarket(api, 10n ** 9n);
    await market.listingMarket('pudgypenguins');

    await market.sellToOffer(sale);

    expect(sent).toMatchObject([
      { to: SEAPORT, data: '0xfeed', gas: 240_000n, maxFeePerGas: 1_200_000_000n },
    ]);
  });

  test('sends nothing when the capped gas could take the sale under minProceeds', async () => {
    const api = new StubApi();
    const { market, sent } = sellingMarket(api, 200n * 10n ** 9n);
    await market.listingMarket('pudgypenguins');

    await expect(market.sellToOffer(sale)).rejects.toThrow('under the');
    expect(sent).toEqual([]);
  });
});

describe('GondiMarket loans', () => {
  test("reads every page of the wallet's open single-item WETH offers on the collection, hidden ones too", async () => {
    const reads: unknown[] = [];
    const sdkOffer = (overrides: object) => ({
      contractAddress: MULTI_SOURCE_LOAN,
      offerId: 3n,
      nftCollateralTokenId: 3950n,
      principalAddress: WETH,
      principalAmount: eth('7'),
      aprBps: 1_000n,
      duration: 2_592_000n,
      expirationTime: 1_893_456_600n,
      hidden: true,
      ...overrides,
    });
    const market = new GondiMarket(
      {
        ...gondi,
        currencyBalance: async () => eth('20'),
        currencyAllowance: async ({ to }: { to: string }) =>
          to === MULTI_SOURCE_LOAN ? eth('15') : 0n,
        offers: async (props: { cursor?: string }) => {
          reads.push(props);
          return props.cursor === undefined
            ? { offers: [sdkOffer({})], hasNextPage: true, cursor: 'page-2' }
            : {
                offers: [sdkOffer({ offerId: 4n, principalAddress: zeroAddress })],
                hasNextPage: false,
              };
        },
      } as unknown as Gondi,
      new StubApi() as unknown as GondiApi,
    );

    expect(await market.loanBook('pudgypenguins')).toEqual({
      offers: [
        {
          id: `${MULTI_SOURCE_LOAN}:3`,
          tokenId: 3950n,
          principal: eth('7'),
          aprBps: 1_000n,
          durationSeconds: 2_592_000n,
          expiration: new Date(1_893_456_600_000),
          hidden: true,
        },
      ],
      balance: eth('20'),
      allowance: eth('15'),
    });
    expect(reads).toMatchObject([
      {
        cursor: undefined,
        filterBy: {
          lenders: ['0x0000000000000000000000000000000000000001'],
          collection: 7,
          onlySingleNftOffers: true,
        },
      },
      { cursor: 'page-2' },
    ]);
  });

  test('signs a one-loan offer on the item for the loan contract it reads the allowance of, and hides it there', async () => {
    const made: { offer: object; contract: string }[] = [];
    const hidden: { ids: bigint[]; contractAddress: string }[] = [];
    const market = new GondiMarket(
      {
        ...gondi,
        _makeSingleNftOffer: async (input: object, contract: string) => {
          made.push({ offer: input, contract });
          return { offerId: 9n, contractAddress: MULTI_SOURCE_LOAN };
        },
        hideOffers: async (hide: { ids: bigint[]; contractAddress: string }) => {
          hidden.push(hide);
        },
      } as unknown as Gondi,
      new StubApi() as unknown as GondiApi,
    );
    const expiration = new Date('2030-01-01T00:10:00Z');

    const placed = await market.placeLoanOffer({
      scope: { slug: 'pudgypenguins', tokenId: 3950n },
      principal: eth('6.99'),
      aprBps: 1_000n,
      durationSeconds: 2_592_000n,
      fee: eth('0.017475'),
      expiration,
    });
    await market.hideLoanOffers([placed]);

    expect([placed.id, placed.tokenId]).toEqual([`${MULTI_SOURCE_LOAN}:9`, 3950n]);
    expect([made, hidden]).toEqual([
      [
        {
          offer: {
            nftId: 42,
            principalAddress: WETH,
            principalAmount: eth('6.99'),
            capacity: 0n,
            fee: eth('0.017475'),
            aprBps: 1_000n,
            duration: 2_592_000n,
            expirationTime: BigInt(expiration.getTime() / 1_000),
            requiresLiquidation: false,
            maxSeniorRepayment: 0n,
          },
          contract: MULTI_SOURCE_LOAN,
        },
      ],
      [{ ids: [9n], contractAddress: MULTI_SOURCE_LOAN }],
    ]);
  });
});
