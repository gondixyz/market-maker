import type { Address, Hex } from 'viem';
import { z } from 'zod';

const DEFAULT_API_URL = 'https://api2.gondi.xyz/lending/graphql';

export type OrderSide = 'BID' | 'ASK';
export type OrderType = 'COLLECTION' | 'TRAIT' | 'MULTIPLE_TRAIT' | 'SET_BID' | 'SINGLE_NFT';
export type OrderStatus = 'Active' | 'Executed' | 'Cancelled' | 'Expired' | 'Inactive';
export type OrderSort = { field: 'PRICE' | 'CREATED_DATE'; order: 'ASC' | 'DESC' };

export type OrdersFilter = {
  side: OrderSide;
  collections?: number[];
  traits?: number[];
  nfts?: { collectionId: number; nftId: number }[];
  makers?: Address[];
  excludeMakers?: Address[];
  currencies?: Address[];
  /** Defaults to active orders only. */
  statuses?: OrderStatus[];
  /** `ANY` lists every bid an item of `collections` can fill; `ALL`, the default, those scoped to it. */
  matchMode?: 'ALL' | 'ANY';
  orderTypes?: OrderType[];
  sortBy?: OrderSort[];
  limit?: number;
  /** The `nextCursor` of the previous page, to read the page after it. */
  after?: string;
};

const address = z.string().transform((value) => value as Address);
const amount = z.string().transform((value) => BigInt(value));
const date = z.string().transform((value) => new Date(value));

const order = z.object({
  __typename: z.string(),
  id: z.string().transform(Number),
  price: amount,
  steppedPrice: amount.nullable(),
  currencyAddress: address,
  maker: address,
  isAsk: z.boolean(),
  status: z.string(),
  startTime: date,
  expiration: date,
  executions: z.number(),
  maxExecutions: z.number(),
  cancelsOffChain: z.boolean(),
  marketPlace: z.string(),
  nft: z.object({ id: z.string().transform(Number), tokenId: amount }).optional(),
  collectionId: z.number().optional(),
});

const ORDER_FIELDS = `
  __typename id price steppedPrice currencyAddress maker isAsk status startTime expiration
  executions maxExecutions cancelsOffChain marketPlace
  ... on SingleNFTOrder { nft { id tokenId } }
  ... on CollectionOrder { collectionId }
  ... on TraitOrder { collectionId }
  ... on MultipleTraitOrder { collectionId }
  ... on SetBidOrder { collectionId }`;

const ORDERS_QUERY = `query orders($side: OrderSide, $collectionIds: [Int!], $traitIds: [Int!],
  $nfts: [OrderForNft!], $maker: [Address!], $excludeMaker: [Address!], $currencyAddresses: [Address!],
  $statuses: [OrderStatusType!], $matchMode: OrderMatchMode!, $orderTypes: [CollectionOrderType!],
  $sortBy: [OrderSortInput!], $first: Int, $after: String) {
  result: listOrdersV2(side: $side, collectionIds: $collectionIds, traitIds: $traitIds, nfts: $nfts,
    maker: $maker, excludeMaker: $excludeMaker, currencyAddresses: $currencyAddresses,
    statuses: $statuses, matchMode: $matchMode, orderTypes: $orderTypes, sortBy: $sortBy,
    first: $first, after: $after) {
    edges { node { ${ORDER_FIELDS} } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const COLLECTION_MARKET_QUERY = `query collectionMarket($slug: String!, $currencyAddresses: [Address!]) {
  collection: getCollectionBySlug(slug: $slug) {
    id seaportConduitKey contractData { contractAddress }
    royalties { beneficiary percentage required }
    statistics {
      minAskPrice(currencyAddresses: $currencyAddresses) { amount }
      highestApplicableBid { ${ORDER_FIELDS} }
    }
  }
}`;

const PRICE_STEP_QUERY = `query priceStep($collectionId: Int!) {
  steps: getCollectionOfferSteps(collectionId: $collectionId) { wethStep }
}`;

const NFT_ID_QUERY = `query nftId($slug: String!, $tokenId: BigInt!) {
  nft: getNftBySlugAndTokenId(slug: $slug, tokenId: $tokenId) { id }
}`;

const HELD_NFTS_QUERY = `query heldNfts($slug: String!, $owner: Address!, $after: String) {
  nfts: listNfts(slugs: [$slug], ownersFilter: { owners: [$owner], withInWallet: true },
    first: 100, after: $after) {
    edges { node { tokenId } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const SALES_QUERY = `query sales($users: [Address!], $fromTimestamp: Int, $after: String) {
  sales: listSales(users: $users, fromTimestamp: $fromTimestamp, after: $after, first: 100,
    sortBy: [{ field: TIMESTAMP, order: ASC }]) {
    edges { node { price currencyAddress sender receiver timestamp
      nft { tokenId collection { slug } } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const COLLECTION_SALES_QUERY = `query collectionSales($collectionIds: [Int!], $currencyAddresses: [Address!],
  $fromTimestamp: Int, $toTimestamp: Int, $after: String) {
  sales: listSales(collections: $collectionIds, currencyAddresses: $currencyAddresses,
    fromTimestamp: $fromTimestamp, toTimestamp: $toTimestamp, after: $after, first: 100,
    sortBy: [{ field: TIMESTAMP, order: ASC }]) {
    edges { node { price timestamp originatedFromAsk } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const CURRENCY_USD_PRICE_QUERY = `query currencyUsdPrice($address: Address!) {
  currency: getCurrency(address: $address) { currentUsdcPrice }
}`;

const TOP_COLLECTIONS_QUERY = `query topCollections($first: Int!, $after: String,
  $searchTerm: String) {
  result: listCollections(searchTerm: $searchTerm, standards: [ERC721], blockchains: [ETHEREUM],
    wrappers: false,
    excludeGondiUserVault: true, sortBy: [{ field: TOTAL_VOLUME_7D, order: DESC }],
    first: $first, after: $after) {
    edges { node { slug name image { cacheUrl } wrapperCollections { slug } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const PROFILE_QUERY = `query profile($wallet: Address!) {
  profiles: listProfiles(walletAddresses: [$wallet]) { name profilePictureUrl }
}`;

const SALE_FEES_QUERY = `query saleFees($collectionId: Int!) {
  fees: listPlatformFees(blockchain: ETHEREUM, collectionId: $collectionId, operation: SALE) { bps }
}`;

const DAILY_PRICE_HISTORY_QUERY = `query dailyPriceHistory($slug: String!, $from: DateTime!,
  $to: DateTime!) {
  collection: getCollectionBySlug(slug: $slug) {
    statistics {
      floorPriceHistory(fromDate: $from, toDate: $to) { timestamp value }
      topBidHistory(fromDate: $from, toDate: $to) { timestamp value }
    }
  }
}`;

/** One `floorPriceAt` per timestamp, aliased `f0`, `f1`, … since a field takes one argument set. */
const floorPricesQuery = (timestamps: Date[]) => `query floorPrices($slug: String!) {
  collection: getCollectionBySlug(slug: $slug) {
    statistics {
      ${timestamps.map((timestamp, index) => `f${index}: floorPriceAt(timestamp: "${timestamp.toISOString()}")`).join('\n      ')}
    }
  }
}`;

const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
/** A GraphQL connection of `node`s: one page of them and the cursor of the page after it. */
const connection = <Node extends z.ZodType>(node: Node) =>
  z.object({ edges: z.array(z.object({ node })), pageInfo });
type Connection<Node> = { edges: { node: Node }[]; pageInfo: z.infer<typeof pageInfo> };

const ordersResult = z.object({ result: connection(order) });

const collectionMarketResult = z.object({
  collection: z
    .object({
      id: z.string().transform(Number),
      seaportConduitKey: z.string().transform((value) => value as Hex),
      contractData: z.object({ contractAddress: address }),
      royalties: z.array(
        z.object({ beneficiary: address, percentage: z.number(), required: z.boolean() }),
      ),
      statistics: z.object({
        minAskPrice: z.object({ amount }).nullable(),
        highestApplicableBid: order.nullable(),
      }),
    })
    .nullable(),
});

const heldNftsResult = z.object({ nfts: connection(z.object({ tokenId: amount })) });
const sale = z.object({
  price: amount,
  currencyAddress: address,
  sender: address,
  receiver: address,
  timestamp: date,
  nft: z.object({ tokenId: amount, collection: z.object({ slug: z.string() }) }),
});
const salesResult = z.object({ sales: connection(sale) });
const collectionSale = z.object({ price: amount, timestamp: date, originatedFromAsk: z.boolean() });
const collectionSalesResult = z.object({
  sales: connection(collectionSale.extend({ originatedFromAsk: z.boolean().nullable() })),
});
const currencyUsdPriceResult = z.object({
  currency: z.object({ currentUsdcPrice: z.number().positive() }),
});
const statHistory = z.array(z.object({ timestamp: date, value: z.number() }));
const dailyPriceHistoryResult = z.object({
  collection: z
    .object({
      statistics: z.object({ floorPriceHistory: statHistory, topBidHistory: statHistory }),
    })
    .nullable(),
});
/** The least a floor in the history can be and still be a price, in ETH: one gwei. */
const LEAST_HISTORICAL_FLOOR = 1e-9;

/**
 * A floor in the history, in ETH. One under a gwei is not the market but a gap or dust: the API
 * reports BAYC's floor at 2026-10-27T10:15Z as 6e-18 ETH, from trades of a few wei that morning,
 * between floors of 6.35 and 6.33. It reads as no floor at that moment.
 */
const historicalFloor = z
  .number()
  .nullable()
  .transform((value) => (value === null || value < LEAST_HISTORICAL_FLOOR ? null : value));
const floorPricesResult = z.object({
  collection: z.object({ statistics: z.record(z.string(), historicalFloor) }).nullable(),
});
const topCollectionsResult = z.object({
  result: connection(
    z.object({
      slug: z.string(),
      name: z.string().nullable(),
      image: z.object({ cacheUrl: z.string().nullable() }).nullable(),
      wrapperCollections: z.array(z.object({ slug: z.string() })),
    }),
  ),
});
export type TopCollection = {
  slug: string;
  name: string;
  /** The CDN base of the collection's image; `<imageUrl>/size_128x128.webp` is a WebP thumbnail. */
  imageUrl: string | null;
  /** Whether other contracts wrap its items, such as CryptoPunks' wrapped punks. */
  wrapped: boolean;
};
const profileResult = z.object({
  profiles: z.array(
    z.object({ name: z.string().nullable(), profilePictureUrl: z.string().nullable() }),
  ),
});
const saleFeesResult = z.object({ fees: z.array(z.object({ bps: amount })) });
const priceStepResult = z.object({ steps: z.object({ wethStep: amount }) });
const nftIdResult = z.object({ nft: z.object({ id: z.string().transform(Number) }).nullable() });

export type ApiOrder = z.output<typeof order>;
export type StatPoint = z.output<typeof statHistory>[number];
export type ApiSale = z.output<typeof sale>;
export type CollectionSale = z.output<typeof collectionSale>;
export type CollectionMarket = {
  collectionId: number;
  contractAddress: Address;
  seaportConduitKey: Hex;
  /** The cheapest active listing in the requested currencies, or `null` when nothing is listed. */
  floorPrice: bigint | null;
  highestBid: ApiOrder | null;
  royalties: { beneficiary: Address; percentage: number; required: boolean }[];
};

/** The reads a market maker prices from, which a stand-in such as `PriceReplay` can serve. */
export type PriceApi = Pick<GondiApi, 'collectionMarket' | 'orders' | 'currencyUsdPrice'>;

/**
 * Reads the market from GONDI's public lending API: the order book, a collection's floor, highest
 * bid, royalties, contract and price step, and an item's GONDI id. Reads need no sign-in, so they
 * never go through the SDK's session; the SDK is used only to sign, publish and cancel.
 *
 * IMPLEMENTATION NOTE: every read is a GraphQL POST to `<apiUrl>` with `{ query, variables }`, and
 * the response's `data` is parsed here into exact types, failing loudly on a shape it does not
 * expect. `BigInt` and `DateTime` scalars arrive as strings; `status` as `OrderStatus.<Name>` and
 * `marketPlace` as `MarketPlace.<Name>`. `listOrdersV2` needs `orderTypes` to list asks scoped to a
 * collection, and lists both an item's own and its collection-level bids under `nfts`.
 *
 * Checked against the production API: `listSales(users:)` lists the sales where a user is the
 * `sender` (seller) or the `receiver` (buyer), takes `fromTimestamp` and `toTimestamp` in Unix
 * seconds and returns at most 20 sales a page whatever `first` asks; a sale's `originatedFromAsk`
 * is true when the buyer took a listing and false when the seller accepted a bid; `getCurrency(WETH).currentUsdcPrice` is ETH's USD
 * price, a float, `null` without a rate; `listPlatformFees(operation: SALE)` is the fee the API
 * adds to every GONDI ask that is not stealth, `[{ bps: "50" }]` on Ethereum.
 * `CollectionStatistics.floorPriceAt(timestamp)` is the last floor sample at or before it, in ETH
 * as a float, normalized across the collection's wrap family; `floorPriceHistory` and
 * `topBidHistory(fromDate, toDate)` keep only each UTC day's last sample, `{ timestamp, value }` in
 * ETH with the timestamp at the day's midnight. The schema
 * is the one the `gondi` SDK is generated from (https://github.com/gondixyz/gondi-js, file
 * `src/generated/graphql/lending-schema.graphql`).
 */
export class GondiApi {
  constructor(
    private readonly apiUrl: string = process.env.GONDI_API_URL ?? DEFAULT_API_URL,
    private readonly post: typeof fetch = fetch,
  ) {}

  /**
   * One page of orders matching `filter`, active ones unless `statuses` says otherwise, and the
   * cursor of the page after it (`null` on the last page).
   */
  async orders(filter: OrdersFilter): Promise<{ orders: ApiOrder[]; nextCursor: string | null }> {
    const result = await this.ordersConnection(filter);
    return {
      orders: result.edges.map((edge) => edge.node),
      nextCursor: result.pageInfo.hasNextPage ? result.pageInfo.endCursor : null,
    };
  }

  /**
   * Every order matching `filter`, active ones unless `statuses` says otherwise, read `limit` at a
   * time.
   */
  async allOrders(filter: Omit<OrdersFilter, 'after'>): Promise<ApiOrder[]> {
    return this.allPages((after) =>
      this.ordersConnection({ ...filter, after: after ?? undefined }),
    );
  }

  /**
   * What pricing and placing an order on a collection needs, looked up by slug (the lookup the API
   * answers fastest). Throws for an unknown slug.
   */
  async collectionMarket({
    slug,
    currencies,
  }: {
    slug: string;
    currencies?: Address[];
  }): Promise<CollectionMarket> {
    const { collection } = collectionMarketResult.parse(
      await this.query(COLLECTION_MARKET_QUERY, { slug, currencyAddresses: currencies }),
    );
    if (!collection) throw new Error(`invalid collection ${slug}`);
    return {
      collectionId: collection.id,
      contractAddress: collection.contractData.contractAddress,
      seaportConduitKey: collection.seaportConduitKey,
      floorPrice: collection.statistics.minAskPrice?.amount ?? null,
      highestBid: collection.statistics.highestApplicableBid,
      royalties: collection.royalties,
    };
  }

  /** The price grid WETH bids on the collection must sit on; `0n` when it has none. */
  async priceStep(collectionId: number): Promise<bigint> {
    return priceStepResult.parse(await this.query(PRICE_STEP_QUERY, { collectionId })).steps
      .wethStep;
  }

  /** An item's GONDI id. Throws for an item GONDI does not know. */
  async nftId({ slug, tokenId }: { slug: string; tokenId: bigint }): Promise<number> {
    const { nft } = nftIdResult.parse(
      await this.query(NFT_ID_QUERY, { slug, tokenId: tokenId.toString() }),
    );
    if (!nft) throw new Error(`invalid nft ${slug} #${tokenId}`);
    return nft.id;
  }

  /**
   * The token ids of the collection's items `owner` holds in its wallet (not lent, vaulted or
   * stashed), every page of them. The owners index trails a transfer by up to a minute.
   */
  async heldNfts({ slug, owner }: { slug: string; owner: Address }): Promise<bigint[]> {
    const nfts = await this.allPages(
      async (after) =>
        heldNftsResult.parse(await this.query(HELD_NFTS_QUERY, { slug, owner, after })).nfts,
    );
    return nfts.map((nft) => nft.tokenId);
  }

  /**
   * Every sale since `from` where `user` bought or sold, oldest first, on any marketplace GONDI
   * indexes: `sender` is the seller and `receiver` the buyer.
   */
  async sales({ user, from }: { user: Address; from: Date }): Promise<ApiSale[]> {
    return this.allPages(
      async (after) =>
        salesResult.parse(
          await this.query(SALES_QUERY, {
            users: [user],
            fromTimestamp: Math.floor(from.getTime() / 1_000),
            after,
          }),
        ).sales,
    );
  }

  /**
   * Every sale of the collection's items from `from` to `to` paid in `currencies`, oldest first, on
   * any marketplace GONDI indexes, with whether the buyer took a listing or the seller a bid; a sale
   * the API reports neither way (`originatedFromAsk: null`, seen on older sales) is left out.
   */
  async collectionSales({
    collectionId,
    currencies,
    from,
    to,
  }: {
    collectionId: number;
    currencies: Address[];
    from: Date;
    to: Date;
  }): Promise<CollectionSale[]> {
    const sales = await this.allPages(
      async (after) =>
        collectionSalesResult.parse(
          await this.query(COLLECTION_SALES_QUERY, {
            collectionIds: [collectionId],
            currencyAddresses: currencies,
            fromTimestamp: Math.floor(from.getTime() / 1_000),
            toTimestamp: Math.floor(to.getTime() / 1_000),
            after,
          }),
        ).sales,
    );
    return sales.flatMap(({ originatedFromAsk, ...sale }) =>
      originatedFromAsk === null ? [] : [{ ...sale, originatedFromAsk }],
    );
  }

  /** The current price of one unit of the currency in USD. Throws when the API has no rate. */
  async currencyUsdPrice(currency: Address): Promise<number> {
    return currencyUsdPriceResult.parse(
      await this.query(CURRENCY_USD_PRICE_QUERY, { address: currency }),
    ).currency.currentUsdcPrice;
  }

  /**
   * The collection's floor at each of `timestamps`, in ETH: the last floor sample at or before it,
   * `null` where there is none. One query asks for them all, so keep each call to a few dozen.
   */
  async floorPricesAt({
    slug,
    timestamps,
  }: {
    slug: string;
    timestamps: Date[];
  }): Promise<(number | null)[]> {
    const { collection } = floorPricesResult.parse(
      await this.query(floorPricesQuery(timestamps), { slug }),
    );
    if (!collection) throw new Error(`invalid collection ${slug}`);
    return timestamps.map((_, index) => collection.statistics[`f${index}`] ?? null);
  }

  /**
   * The collection's floor and top bid, in ETH, once per UTC day from `from` to `to`: each day's
   * last sample, stamped at the day's midnight.
   */
  async dailyPriceHistory({
    slug,
    from,
    to,
  }: {
    slug: string;
    from: Date;
    to: Date;
  }): Promise<{ floors: StatPoint[]; topBids: StatPoint[] }> {
    const { collection } = dailyPriceHistoryResult.parse(
      await this.query(DAILY_PRICE_HISTORY_QUERY, {
        slug,
        from: from.toISOString(),
        to: to.toISOString(),
      }),
    );
    if (!collection) throw new Error(`invalid collection ${slug}`);
    return {
      floors: collection.statistics.floorPriceHistory,
      topBids: collection.statistics.topBidHistory,
    };
  }

  /** The fee a sale of the collection's items on GONDI pays, in basis points of the price. */
  async saleFeeBps(collectionId: number): Promise<bigint> {
    return saleFeesResult
      .parse(await this.query(SALE_FEES_QUERY, { collectionId }))
      .fees.reduce((total, fee) => total + fee.bps, 0n);
  }

  /**
   * Up to `limit` Ethereum ERC721 collections, ranked by their sales volume over the last seven
   * days, wrapper contracts left out, read a page at a time; with `searchTerm`, only those it
   * matches.
   *
   * IMPLEMENTATION NOTE: these are the arguments the gondi.xyz collections page passes to
   * `listCollections` for its Top tab (`wrappers: false`, `excludeGondiUserVault`), sorted by
   * `TOTAL_VOLUME_7D` descending rather than that tab's `TOTAL_LOAN_VOLUME`, and narrowed to
   * `standards: [ERC721]` and `blockchains: [ETHEREUM]`, the items the bot can bid on and list.
   * `searchTerm` matches a collection's name or slug ("pudgy" finds Pudgy Penguins and Lil Pudgys,
   * "mutant-ape-yacht-club" finds that collection), and `null` matches every one. The API returns
   * at most 30 collections a page whatever `first` asks. `wrapperCollections` lists the contracts that wrap a
   * collection's items; `image.cacheUrl` is a CDN base that serves `/size_<n>x<n>` thumbnails and
   * their `.webp` renditions, which stay a few kilobytes where some PNG ones are the full original.
   */
  async topCollections(limit: number, searchTerm?: string): Promise<TopCollection[]> {
    const collections = await this.allPages(
      async (after, readCount) =>
        topCollectionsResult.parse(
          await this.query(TOP_COLLECTIONS_QUERY, {
            first: limit - readCount,
            after,
            searchTerm: searchTerm ?? null,
          }),
        ).result,
      (read) => read.length >= limit,
    );
    return collections.slice(0, limit).map((collection) => ({
      slug: collection.slug,
      name: collection.name || collection.slug,
      imageUrl: collection.image?.cacheUrl ?? null,
      wrapped: collection.wrapperCollections.length > 0,
    }));
  }

  /**
   * The wallet's public GONDI profile: its display name and profile picture's URL, `null` where it
   * has none.
   *
   * IMPLEMENTATION NOTE: `listProfiles(walletAddresses:)` answers without a session, one profile per
   * address in order. Its `name` is the username chosen on GONDI, else the wallet's ENS or OpenSea
   * name; its `profilePictureUrl` the picture uploaded to GONDI, else the OpenSea one (the resolver
   * is `list_profiles` in the GONDI backend; the schema is the SDK's, see the class note).
   */
  async profile(wallet: Address): Promise<{ name: string | null; pictureUrl: string | null }> {
    const [profile] = profileResult.parse(await this.query(PROFILE_QUERY, { wallet })).profiles;
    return { name: profile?.name || null, pictureUrl: profile?.profilePictureUrl || null };
  }

  /** The page of `ORDERS_QUERY`'s connection that `filter` asks for. */
  private async ordersConnection(filter: OrdersFilter): Promise<Connection<ApiOrder>> {
    return ordersResult.parse(
      await this.query(ORDERS_QUERY, {
        side: filter.side,
        collectionIds: filter.collections,
        traitIds: filter.traits,
        nfts: filter.nfts,
        maker: filter.makers,
        excludeMaker: filter.excludeMakers,
        currencyAddresses: filter.currencies,
        statuses: filter.statuses ?? ['Active'],
        matchMode: filter.matchMode ?? 'ALL',
        orderTypes: filter.orderTypes,
        sortBy: filter.sortBy,
        first: filter.limit ?? 20,
        after: filter.after,
      }),
    ).result;
  }

  /**
   * Every node of a connection, read a page at a time from the first: `readPage` reads the page
   * after the `after` cursor, given how many nodes are read so far, until the last page or until
   * `isComplete` says the nodes read so far are enough.
   */
  private async allPages<Node>(
    readPage: (after: string | null, readCount: number) => Promise<Connection<Node>>,
    isComplete: (read: Node[]) => boolean = () => false,
  ): Promise<Node[]> {
    const nodes: Node[] = [];
    let after: string | null = null;
    do {
      const page = await readPage(after, nodes.length);
      nodes.push(...page.edges.map((edge) => edge.node));
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after && !isComplete(nodes));
    return nodes;
  }

  private async query(query: string, variables: object): Promise<unknown> {
    const response = await this.post(this.apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`GONDI API answered ${response.status}`);
    const { data, errors } = (await response.json()) as {
      data?: unknown;
      errors?: { message: string }[];
    };
    if (errors?.length) throw new Error(errors.map((error) => error.message).join(', '));
    return data;
  }
}
