import { describe, expect, mock, test } from 'bun:test';
import type { Address } from 'viem';

import { GondiApi } from '../src/gondi/api';

const respond = (body: object, status = 200) =>
  mock(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const LAST_PAGE = { hasNextPage: false, endCursor: null };

const ORDER = {
  __typename: 'CollectionOrder',
  id: '16042916907',
  price: '2180000000000000000',
  currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  maker: '0xd6143d48757835897d20cf7837d17ef80b42b44d',
  isAsk: false,
  status: 'OrderStatus.Active',
  startTime: '2026-11-03T18:40:47+00:00',
  expiration: '2026-11-04T06:40:47+00:00',
  executions: 0,
  maxExecutions: 1,
  cancelsOffChain: false,
  marketPlace: 'MarketPlace.OpenSea',
  marketPlaceAddress: '0x0000000000000068f116a894984e2db1123eb395',
  originalId: '0x8c6a3a0f3c4f0e4b7c2a1f9d6e5b4a3928171615141312111009080706050403',
  collectionId: 2173,
};

describe('GondiApi', () => {
  test("reads every page of a collection's sales, with the side each took", async () => {
    const page = (hasNextPage: boolean) =>
      new Response(
        JSON.stringify({
          data: {
            sales: {
              edges: [
                {
                  node: {
                    price: '5590000000000000000',
                    timestamp: '2026-11-02T16:52:23+00:00',
                    originatedFromAsk: false,
                  },
                },
              ],
              pageInfo: { hasNextPage, endCursor: 'MQ==' },
            },
          },
        }),
      );
    const post = mock().mockResolvedValueOnce(page(true)).mockResolvedValueOnce(page(false));

    const sales = await new GondiApi(
      'https://api.test',
      post as unknown as typeof fetch,
    ).collectionSales({
      collectionId: 2155,
      currencies: ['0x0000000000000000000000000000000000000000'],
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-11-02T00:00:00Z'),
    });

    expect(sales).toEqual([
      {
        price: 5590000000000000000n,
        timestamp: new Date('2026-11-02T16:52:23Z'),
        originatedFromAsk: false,
      },
      {
        price: 5590000000000000000n,
        timestamp: new Date('2026-11-02T16:52:23Z'),
        originatedFromAsk: false,
      },
    ]);
    expect(JSON.parse(post.mock.calls[1][1].body).variables).toEqual({
      collectionIds: [2155],
      currencyAddresses: ['0x0000000000000000000000000000000000000000'],
      fromTimestamp: 1793491200,
      toTimestamp: 1793577600,
      after: 'MQ==',
    });
  });

  test('leaves out a sale whose side the API does not know', async () => {
    const node = (originatedFromAsk: boolean | null) => ({
      price: '5590000000000000000',
      timestamp: '2026-10-25T16:52:23+00:00',
      originatedFromAsk,
    });
    const post = respond({
      data: {
        sales: {
          edges: [{ node: node(null) }, { node: node(true) }],
          pageInfo: LAST_PAGE,
        },
      },
    });

    const sales = await new GondiApi('https://api.test', post).collectionSales({
      collectionId: 2155,
      currencies: ['0x0000000000000000000000000000000000000000'],
      from: new Date('2026-10-23T00:00:00Z'),
      to: new Date('2026-10-26T00:00:00Z'),
    });

    expect(sales.map((sale) => sale.originatedFromAsk)).toEqual([true]);
  });

  test('reads a floor under a gwei in the history as no floor at that moment', async () => {
    const statistics = { f0: 6.35, f1: 6e-18, f2: 0, f3: null };
    const post = respond({ data: { collection: { statistics } } });
    const times = ['10:00', '10:15', '10:30', '10:45'].map(
      (time) => new Date(`2026-10-27T${time}:00Z`),
    );

    const floors = await new GondiApi('https://api.test', post).floorPricesAt({
      slug: 'boredapeyachtclub',
      timestamps: times,
    });

    expect(floors).toEqual([6.35, null, null, null]);
  });

  test('parses orders into exact types', async () => {
    const api = new GondiApi(
      'https://api.test',
      respond({ data: { result: { edges: [{ node: ORDER }], pageInfo: LAST_PAGE } } }),
    );

    const { orders, nextCursor } = await api.orders({ side: 'BID', collections: [2173] });

    expect(nextCursor).toBeNull();

    expect(orders).toEqual([
      {
        ...ORDER,
        id: 16042916907,
        price: 2180000000000000000n,
        startTime: new Date('2026-11-03T18:40:47Z'),
        expiration: new Date('2026-11-04T06:40:47Z'),
      },
    ] as never);
  });

  test('asks for active orders scoped to the filter unless told otherwise', async () => {
    const post = respond({ data: { result: { edges: [], pageInfo: LAST_PAGE } } });

    await new GondiApi('https://api.test', post).orders({
      side: 'ASK',
      nfts: [{ collectionId: 1, nftId: 2 }],
    });

    const [, init] = (post as unknown as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string).variables).toMatchObject({
      side: 'ASK',
      nfts: [{ collectionId: 1, nftId: 2 }],
      statuses: ['Active'],
      matchMode: 'ALL',
      first: 20,
    });
  });

  test('sends the marketplaces the filter names', async () => {
    const post = respond({ data: { result: { edges: [], pageInfo: LAST_PAGE } } });

    await new GondiApi('https://api.test', post).orders({ side: 'BID', marketplaces: ['NATIVE'] });

    const [, init] = (post as unknown as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string);
    expect(body.query).toContain('marketplaces: $marketplaces');
    expect(body.variables).toMatchObject({ marketplaces: ['NATIVE'] });
  });

  test('reads a collection market with a null floor', async () => {
    const api = new GondiApi(
      'https://api.test',
      respond({
        data: {
          collection: {
            id: '2173',
            seaportConduitKey: '0x00',
            contractData: { contractAddress: '0xbd3531da5cf5857e7cfaa92426877b022e612cf8' },
            royalties: [],
            statistics: { minAskPrice: null },
          },
        },
      }),
    );

    expect(await api.collectionMarket({ slug: 'pudgypenguins' })).toMatchObject({
      collectionId: 2173,
      floorPrice: null,
    });
  });

  test('pages through the token ids an owner holds in a collection', async () => {
    const page = (tokenIds: string[], hasNextPage: boolean) =>
      new Response(
        JSON.stringify({
          data: {
            nfts: {
              edges: tokenIds.map((tokenId) => ({ node: { tokenId, traits: [] } })),
              pageInfo: { hasNextPage, endCursor: tokenIds.at(-1) },
            },
          },
        }),
      );
    const post = mock()
      .mockResolvedValueOnce(page(['8128', '6580'], true))
      .mockResolvedValueOnce(page(['3950'], false));

    const items = await new GondiApi('https://api.test', post as unknown as typeof fetch).heldNfts({
      slug: 'pudgypenguins',
      owner: '0x59f3eb596b0af6ebb197362c5f191a9abadd4f7b',
    });

    expect(items.map((item) => item.tokenId)).toEqual([8128n, 6580n, 3950n]);
    expect(JSON.parse(post.mock.calls[1][1].body).variables).toMatchObject({
      slug: 'pudgypenguins',
      owner: '0x59f3eb596b0af6ebb197362c5f191a9abadd4f7b',
      after: '6580',
    });
  });

  test('reads the traits of the items an owner holds as type and value', async () => {
    const api = new GondiApi(
      'https://api.test',
      respond({
        data: {
          nfts: {
            edges: [{ node: { tokenId: '1', traits: [{ key: 'Background', value: 'Blue' }] } }],
            pageInfo: LAST_PAGE,
          },
        },
      }),
    );

    expect(
      await api.heldNfts({
        slug: 'pudgypenguins',
        owner: '0x59f3eb596b0af6ebb197362c5f191a9abadd4f7b',
      }),
    ).toEqual([{ tokenId: 1n, traits: [{ type: 'Background', value: 'Blue' }] }]);
  });

  describe('traitMarket', () => {
    const ETH = '0x0000000000000000000000000000000000000000';
    const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const CURRENCIES: Address[] = [ETH, WETH];
    const BLUE = { type: 'Background', value: 'Blue' };
    const value = (
      id: string,
      key: string,
      valueName: string,
      floor: number | null,
      currency = ETH,
    ) => ({
      node: {
        id,
        key,
        value: valueName,
        statistics: {
          floorPrice: floor === null ? null : { amount: floor, currency: { address: currency } },
        },
      },
    });
    const traitsApi = (...edges: object[]) =>
      new GondiApi(
        'https://api.test',
        respond({ data: { values: { edges, pageInfo: LAST_PAGE } } }),
      );

    test('picks the exact value the search returns, with its floor in wei', async () => {
      const api = traitsApi(
        value('1', 'Background', 'Blue Sky', 3),
        value('12276798', 'Background', 'Blue', 2.414),
      );

      expect(await api.traitMarket(2_173, BLUE, CURRENCIES)).toEqual({
        traitId: 12_276_798,
        floorPrice: 2_414_000_000_000_000_000n,
      });
    });

    test('reads no floor for a trait nobody lists', async () => {
      const api = traitsApi(value('5', 'Background', 'Blue', null));

      expect((await api.traitMarket(2_173, BLUE, CURRENCIES)).floorPrice).toBeNull();
    });

    test('reads no floor when the cheapest listing is in another currency', async () => {
      const api = traitsApi(value('5', 'Background', 'Blue', 7_000, USDC));

      expect((await api.traitMarket(2_173, BLUE, CURRENCIES)).floorPrice).toBeNull();
    });

    test('throws for a trait the collection does not have', async () => {
      const api = traitsApi(value('1', 'Background', 'Blue Sky', 3));

      await expect(api.traitMarket(2_173, BLUE, CURRENCIES)).rejects.toThrow(
        'unknown trait Background: Blue',
      );
    });
  });

  test("reads a collection's traits as type and value", async () => {
    const api = new GondiApi(
      'https://api.test',
      respond({
        data: {
          values: {
            edges: [{ node: { key: 'Background', value: 'Blue' } }],
            pageInfo: LAST_PAGE,
          },
        },
      }),
    );

    expect(await api.collectionTraits(2_173)).toEqual([{ type: 'Background', value: 'Blue' }]);
  });

  test("pages through a user's sales since a moment, read in Unix seconds", async () => {
    const SALE = {
      price: '634000000000000000',
      currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      sender: '0x51cc553bc43c6836e6331c3b9650fbd3474f9eb3',
      receiver: '0xe9d93cfb3d9e2b2c9af8a80888a0e93cc4ddb397',
      timestamp: '2026-11-04T20:27:23+00:00',
      nft: { tokenId: '7918', collection: { slug: 'argonauts' } },
    } as const;
    const page = (hasNextPage: boolean) =>
      new Response(
        JSON.stringify({
          data: {
            sales: { edges: [{ node: SALE }], pageInfo: { hasNextPage, endCursor: 'MQ==' } },
          },
        }),
      );
    const post = mock().mockResolvedValueOnce(page(true)).mockResolvedValueOnce(page(false));

    const sales = await new GondiApi('https://api.test', post as unknown as typeof fetch).sales({
      user: SALE.sender,
      from: new Date('2026-11-01T00:00:00Z'),
    });

    expect(sales).toHaveLength(2);
    expect(sales[0]).toMatchObject({
      price: 634000000000000000n,
      timestamp: new Date('2026-11-04T20:27:23Z'),
      nft: { tokenId: 7918n, collection: { slug: 'argonauts' } },
    });
    expect(JSON.parse(post.mock.calls[1][1].body).variables).toEqual({
      users: [SALE.sender],
      fromTimestamp: 1793491200,
      after: 'MQ==',
    });
  });

  test("reads GONDI's sale fee as the SALE platform fees, summed in basis points", async () => {
    const post = respond({ data: { fees: [{ bps: '50' }, { bps: '25' }] } });

    expect(await new GondiApi('https://api.test', post).saleFeeBps(2173)).toBe(75n);
    const [, init] = (post as unknown as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(init.body as string).toContain('operation: SALE');
  });

  test('refuses a currency without a USD rate', async () => {
    const api = new GondiApi(
      'https://api.test',
      respond({ data: { currency: { currentUsdcPrice: null } } }),
    );

    await expect(
      api.currencyUsdPrice('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
    ).rejects.toThrow();
  });

  test.each([
    [
      { name: 'mauro', profilePictureUrl: 'https://img.test/p.png' },
      'mauro',
      'https://img.test/p.png',
    ],
    [{ name: '', profilePictureUrl: null }, null, null],
  ])('reads a wallet profile %p', async (profile, name, pictureUrl) => {
    const api = new GondiApi('https://api.test', respond({ data: { profiles: [profile] } }));

    expect(await api.profile('0x3c5F7A1B9e2D4c6A8b0E1f3D5c7B9a2E4d6F8a1C')).toEqual({
      name,
      pictureUrl,
    });
  });

  test('reads the top collections a page at a time up to the limit', async () => {
    const node = (slug: string, wrappers: string[] = []) => ({
      node: {
        slug,
        name: slug === 'b' ? null : slug.toUpperCase(),
        image: { cacheUrl: `https://cdn.test/${slug}` },
        wrapperCollections: wrappers.map((wrapper) => ({ slug: wrapper })),
      },
    });
    const pages = [
      {
        edges: [node('a', ['wrapped-a']), node('b')],
        pageInfo: { hasNextPage: true, endCursor: 'c1' },
      },
      { edges: [node('c'), node('d')], pageInfo: { hasNextPage: true, endCursor: 'c2' } },
    ];
    const post = mock(
      async () => new Response(JSON.stringify({ data: { result: pages.shift() } })),
    );
    const api = new GondiApi('https://api.test', post as unknown as typeof fetch);

    expect(await api.topCollections(3)).toEqual([
      { slug: 'a', name: 'A', imageUrl: 'https://cdn.test/a', wrapped: true },
      { slug: 'b', name: 'b', imageUrl: 'https://cdn.test/b', wrapped: false },
      { slug: 'c', name: 'C', imageUrl: 'https://cdn.test/c', wrapped: false },
    ]);
    const second = JSON.parse(
      (post.mock.calls[1] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(second.variables).toEqual({ first: 1, after: 'c1', searchTerm: null });
  });

  test('narrows the top collections to a search term', async () => {
    const post = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: { result: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          }),
        ),
    );
    const api = new GondiApi('https://api.test', post as unknown as typeof fetch);

    await api.topCollections(30, 'pudgy');

    const body = JSON.parse(
      (post.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.variables).toEqual({ first: 30, after: null, searchTerm: 'pudgy' });
  });

  test('throws for an unknown collection', async () => {
    const api = new GondiApi('https://api.test', respond({ data: { collection: null } }));

    await expect(api.collectionMarket({ slug: 'nope' })).rejects.toThrow('invalid collection nope');
  });

  test('surfaces GraphQL errors and failed responses', async () => {
    const withErrors = new GondiApi('https://api.test', respond({ errors: [{ message: 'boom' }] }));
    const unavailable = new GondiApi('https://api.test', respond({}, 502));

    await expect(withErrors.priceStep(1)).rejects.toThrow('boom');
    await expect(unavailable.priceStep(1)).rejects.toThrow('GONDI API answered 502');
  });
});
