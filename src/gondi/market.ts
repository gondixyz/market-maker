import type { Gondi } from 'gondi';
import {
  type Address,
  getAddress,
  type Hash,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  zeroHash,
} from 'viem';

import type {
  BidScope,
  BidSnapshot,
  Fill,
  ItemListing,
  ListingMarket,
  ListingScope,
  Market,
  OwnBid,
  OwnListing,
  SaleTerms,
} from '../engine/market';
import {
  type ApiOrder,
  type CollectionMarket,
  GondiApi,
  type OrdersFilter,
  type OrderStatus,
  type PriceApi,
} from './api';

/** Wrapped ether on Ethereum: what bids are paid in. */
export const WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
/**
 * Seaport 1.6, which GONDI orders are filled through: it must be allowed to spend the WETH bids
 * pay with and to move the items listings sell.
 */
export const SEAPORT: Address = '0x0000000000000068F116a894984e2DB1123eB395';

const NATIVE_MARKETPLACE = 'MarketPlace.Native';
const ACTIVE_STATUS = 'OrderStatus.Active';
const OWN_ORDERS_PAGE = 50;
const CLOSED_STATUSES: OrderStatus[] = ['Executed', 'Cancelled', 'Expired'];
const MAX_CANCELS_PER_CALL = 50;
/** The most orders the API serves in one page of the competing bid book. */
const BOOK_PAGE = 20;
/** The most pages of the book one snapshot reads looking for its levels: 500 bids. */
const MAX_BOOK_PAGES = 25;
/** How far back past the previous read a closed-bid read starts, for clock drift with the API. */
const CLOSED_READ_OVERLAP_MS = 60_000;

/**
 * What a run has read of its own closed bids on one collection. A closed bid is terminal, so a later
 * read only needs the bids that can have closed since: those placed after `readAt`, and the
 * `unsettled` ones, seen active and not seen closed yet.
 */
type ClosedBidsRead = {
  since: Date;
  readAt: Date;
  /** Closed bids that bought something, by order id. */
  filled: Map<number, ApiOrder>;
  /**
   * The start time of every bid placed since `since`, seen active and not seen closed yet, by order
   * id. A bid placed before `since` is left out: no closed read returns it, so it would never leave.
   */
  unsettled: Map<number, Date>;
};

const BPS = 10_000n;

/** Seaport's ConduitController on Ethereum, which deploys and names every Seaport conduit. */
const CONDUIT_CONTROLLER: Address = '0x00000000F9490004C11Cef243f5400493c00Ad63';
const conduitControllerAbi = parseAbi([
  'function getConduit(bytes32 conduitKey) view returns (address conduit, bool exists)',
]);

type Royalty = CollectionMarket['royalties'][number];

/**
 * What listing a collection's items needs: its API id, its contract, the operator the holder
 * approves so its listings can be filled, and the royalties those listings pay.
 */
type ListingCollection = {
  collectionId: number;
  contractAddress: Address;
  operator: Address;
  royalties: Royalty[];
};

const itemKey = ({ slug, tokenId }: ListingScope) => `${slug}#${tokenId}`;

const toOwnListing = (order: ApiOrder): OwnListing => ({
  id: order.id,
  price: order.price,
  expiration: order.expiration,
  executions: order.executions,
  active: order.status === ACTIVE_STATUS,
});

/** The royalties a listing must pay, as the order's fees: each a share of the price. */
const requiredRoyaltyFees = (royalties: Royalty[], price: bigint) =>
  royalties
    .filter((royalty) => royalty.required)
    .map((royalty) => ({
      taker: getAddress(royalty.beneficiary),
      amount: (price * BigInt(Math.round(royalty.percentage * 100))) / BPS,
    }));

/** What a sale pays its collection's required royalties, in basis points of the price. */
export const requiredRoyaltyBps = (royalties: Royalty[]) =>
  royalties
    .filter((royalty) => royalty.required)
    .reduce((total, royalty) => total + BigInt(Math.round(royalty.percentage * 100)), 0n);

/**
 * The contract a holder approves so Seaport can move a collection's items: the conduit the
 * collection's `seaportConduitKey` names, or Seaport itself for the null key.
 *
 * IMPLEMENTATION NOTE: Seaport pulls an offerer's items through the conduit named by the order's
 * conduit key, and the ConduitController maps a key to its conduit with
 * `getConduit(bytes32 conduitKey) returns (address conduit, bool exists)`
 * (https://github.com/ProjectOpenSea/seaport-core/blob/main/src/interfaces/ConduitControllerInterface.sol).
 * The controller is deployed at `0x00000000F9490004C11Cef243f5400493c00Ad63` on Ethereum
 * (https://github.com/ProjectOpenSea/seaport#deployments). For the key GONDI signs ERC721-C
 * listings with, `0x0000007b…0f0000`, it returns OpenSea's conduit
 * `0x1E0049783F008A0085193E00003D00cd54003c71` with `exists: true`; for an unused key it returns
 * the would-be address with `exists: false`, which nothing can approve meaningfully.
 */
export const approvalOperator = async (gondi: Gondi, conduitKey: Hash) => {
  if (conduitKey === zeroHash) return SEAPORT;
  const [conduit, exists] = await gondi.bcClient.readContract({
    address: CONDUIT_CONTROLLER,
    abi: conduitControllerAbi,
    functionName: 'getConduit',
    args: [conduitKey],
  });
  if (!exists) throw new Error(`no Seaport conduit exists for key ${conduitKey}`);
  return conduit;
};

/**
 * Each price in `orders`, stepped where the API steps it, once, best first: the competing price
 * levels `level` pricing joins.
 */
export const bidLevels = (orders: ApiOrder[]) =>
  [...new Set(orders.map((order) => order.steppedPrice ?? order.price))].sort((first, second) =>
    first > second ? -1 : first < second ? 1 : 0,
  );

const erc721Abi = parseAbi(['function balanceOf(address owner) view returns (uint256)']);
const wethAbi = parseAbi(['function deposit() payable']);

const toOwnBid = (order: ApiOrder): OwnBid => ({
  id: String(order.id),
  venue: 'gondi',
  placedAt: order.startTime,
  price: order.price,
  expiration: order.expiration,
  executions: order.executions,
  maxExecutions: order.maxExecutions,
  active: order.status === ACTIVE_STATUS,
  cancelsOffChain: order.cancelsOffChain,
});

/**
 * Where the next closed-bid read after `read` starts: the oldest unsettled bid, or a little before
 * the previous read for bids placed after it, and never before the run's `since`.
 */
const closedReadStart = (read: ClosedBidsRead) =>
  new Date(
    Math.max(
      read.since.getTime(),
      Math.min(
        read.readAt.getTime() - CLOSED_READ_OVERLAP_MS,
        ...[...read.unsettled.values()].map((startTime) => startTime.getTime()),
      ),
    ),
  );

/**
 * The engine's market on GONDI, through the `gondi` SDK. Bids are WETH collection bids on GONDI's
 * own order book; competing bids are read from every marketplace GONDI indexes, since a seller
 * takes the best bid wherever it is. Listings are ETH asks of single ERC-721 items, priced against the cheapest listing of any
 * other item in the collection, wherever it is listed.
 *
 * IMPLEMENTATION NOTE: market reads go through `GondiApi` (the public lending API, no sign-in);
 * the SDK only signs and publishes orders (`gondi.makeOrder`), cancels them, and reads the WETH
 * balance and allowance on-chain. `gondi.cancelOrders` cancels bids whose `cancelsOffChain` is true
 * with one API call and no transaction, and sends a transaction for any other, which is why
 * `cancelBids` refuses those before calling it. See https://github.com/gondixyz/gondi-js.
 *
 * Listing reads, checked against the production API: a collection's item listings need
 * `orderTypes: [SINGLE_NFT]` beside `collectionIds`; one item's orders come from
 * `nfts: [{ collectionId, nftId }]`. A filled GONDI listing reads `status: OrderStatus.Executed`,
 * `executions: 1` and `cancelsOffChain: false` (listings only cancel on-chain). Listings are not
 * price-stepped: the API checks steps on bids only. Required royalties are paid as `fees` of
 * `{ taker, amount }`, each `price × percentage / 100`, as the GONDI web app lists. The API signs
 * a listing with the collection's conduit key itself (the key `collectionMarket` returns as
 * `seaportConduitKey`), so `makeOrder` takes no conduit; the wallet only has to approve the
 * operator `approvalOperator` resolves from that key.
 *
 * The loss `lossLimits` caps is read from the wallet's sales on every marketplace GONDI indexes,
 * each sale's proceeds net of the collection's required royalties and GONDI's sale fee (the only
 * marketplace the bot lists on), both read from the API rather than pinned here.
 *
 * What the wallet holds of a collection is read on-chain with ERC-721's
 * `balanceOf(address owner) returns (uint256)` (https://eips.ethereum.org/EIPS/eip-721) rather than
 * from the API, whose index of owners trails a purchase by up to a minute: a bid that just filled
 * must count at once, or `maxItems` would let the task buy one more.
 */
export class GondiMarket implements Market {
  private readonly priceSteps = new Map<number, bigint>();
  private readonly collectionIds = new Map<string, number>();
  private readonly listingCollections = new Map<string, ListingCollection>();
  private readonly nftIds = new Map<string, number>();
  private readonly closedBidsReads = new Map<number, ClosedBidsRead>();

  /**
   * `priceApi` is where market prices are read: the floor, the best competing bid, the lowest
   * competing listing and ETH's USD price. It defaults to `api`, which serves everything else (the
   * wallet's own orders, holdings and sales, price steps and fees); a separate one lets a test
   * stack trade at another deployment's prices, live or replayed (`PriceReplay`), matching
   * collections by slug since ids differ.
   */
  constructor(
    private readonly gondi: Gondi,
    private readonly api: GondiApi = new GondiApi(),
    private readonly priceApi: PriceApi = api,
  ) {}

  get account() {
    return this.gondi.account.address;
  }

  async snapshot(scope: BidScope, since: Date): Promise<BidSnapshot> {
    const market = await this.api.collectionMarket({
      slug: scope.slug,
      currencies: [zeroAddress, WETH],
    });
    this.collectionIds.set(scope.slug, market.collectionId);
    const prices = await this.priceMarket(scope.slug, market);
    const [competingBidLevels, ownBids, priceStep, held, balance, allowance] = await Promise.all([
      this.competingBidLevels(prices.collectionId, scope.levels ?? 1),
      this.ownBids(market.collectionId, since),
      this.priceStep(market.collectionId),
      this.gondi.bcClient.readContract({
        address: market.contractAddress,
        abi: erc721Abi,
        functionName: 'balanceOf',
        args: [this.account],
      }),
      this.gondi.currencyBalance({ tokenAddress: WETH }),
      this.gondi.currencyAllowance({ tokenAddress: WETH, to: SEAPORT }),
    ]);
    return {
      floorPrice: prices.floorPrice,
      bestCompetingBid: competingBidLevels[0] ?? null,
      competingBidLevels,
      ownBids,
      priceStep,
      held: Number(held),
      balance,
      allowance,
    };
  }

  async placeBid({ scope, price, quantity, expiration }: Parameters<Market['placeBid']>[0]) {
    const placedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const now = BigInt(placedAt.getTime() / 1_000);
    const collectionId = this.collectionIds.get(scope.slug);
    if (collectionId === undefined) throw new Error(`no snapshot of ${scope.slug} yet`);
    const order = await this.gondi.makeOrder({
      collectionId,
      currencyAddress: WETH,
      price,
      amount: 0n,
      isAsk: false,
      maxExecutions: BigInt(quantity),
      startTime: now,
      expirationTime: BigInt(Math.floor(expiration.getTime() / 1_000)),
      fees: [],
    });
    return {
      id: String(order.id),
      venue: 'gondi' as const,
      placedAt,
      price,
      expiration,
      executions: 0,
      maxExecutions: quantity,
      active: true,
      cancelsOffChain: true,
    };
  }

  async cancelBids(bids: OwnBid[]) {
    const onChainOnly = bids.filter((bid) => !bid.cancelsOffChain);
    if (onChainOnly.length > 0) {
      throw new Error(
        `bids ${onChainOnly.map((bid) => bid.id).join(', ')} can only be cancelled on-chain`,
      );
    }
    for (let start = 0; start < bids.length; start += MAX_CANCELS_PER_CALL) {
      const orderIds = bids.slice(start, start + MAX_CANCELS_PER_CALL).map((bid) => Number(bid.id));
      await this.gondi.cancelOrders({ orderIds });
    }
  }

  /**
   * IMPLEMENTATION NOTE: `getTransactionCount` at `blockTag: 'pending'` counts the transactions
   * the node holds in its mempool on top of the mined ones at `'latest'`, so a larger pending
   * count means a transaction is still unmined
   * (https://viem.sh/docs/actions/public/getTransactionCount).
   */
  async walletBalances() {
    const address = this.account;
    const [eth, weth, minedCount, pendingCount] = await Promise.all([
      this.gondi.bcClient.getBalance({ address }),
      this.gondi.currencyBalance({ tokenAddress: WETH }),
      this.gondi.bcClient.getTransactionCount({ address, blockTag: 'latest' }),
      this.gondi.bcClient.getTransactionCount({ address, blockTag: 'pending' }),
    ]);
    return { eth, weth, pending: pendingCount > minedCount };
  }

  /**
   * IMPLEMENTATION NOTE: WETH9's payable `deposit()` mints one WETH for each wei of ETH sent with
   * it (https://etherscan.io/address/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2#code). viem's
   * `writeContract` sends it through the SDK's wallet client, and `waitForTransactionReceipt`
   * resolves with the mined receipt, whose `status` is `'reverted'` when it failed
   * (https://viem.sh/docs/actions/public/waitForTransactionReceipt).
   */
  async wrapEth(amount: bigint) {
    const hash = await this.gondi.wallet.writeContract({
      address: WETH,
      abi: wethAbi,
      functionName: 'deposit',
      value: amount,
    });
    const receipt = await this.gondi.bcClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`wrapping ETH reverted in ${hash}`);
  }

  async heldItems(slug: string) {
    return this.api.heldNfts({ slug, owner: this.account });
  }

  async listingMarket(slug: string): Promise<ListingMarket> {
    const market = await this.api.collectionMarket({ slug, currencies: [zeroAddress, WETH] });
    const operator =
      this.listingCollections.get(slug)?.operator ??
      (await approvalOperator(this.gondi, market.seaportConduitKey));
    this.listingCollections.set(slug, {
      collectionId: market.collectionId,
      contractAddress: market.contractAddress,
      operator,
      royalties: market.royalties,
    });
    const prices = await this.priceMarket(slug, market);
    const [lowestCompetingAsk, bestCompetingBid, approved] = await Promise.all([
      this.lowestCompetingAsk(prices.collectionId),
      this.bestCompetingBid(prices.collectionId),
      this.gondi.isApprovedNFTForAll({
        nftAddress: market.contractAddress,
        standard: 'ERC721',
        to: operator,
      }),
    ]);
    return { lowestCompetingAsk, bestCompetingBid, approved };
  }

  async itemListing(scope: ListingScope, since: Date): Promise<ItemListing> {
    const collection = this.listingCollection(scope.slug);
    const [ownListings, owner] = await Promise.all([
      this.ownListings(scope, collection.collectionId, since),
      this.gondi.getOwner({ nftAddress: collection.contractAddress, tokenId: scope.tokenId }),
    ]);
    return { ownListings, owned: isAddressEqual(owner, this.account) };
  }

  async placeListing({ scope, price, expiration }: Parameters<Market['placeListing']>[0]) {
    const collection = this.listingCollection(scope.slug);
    const order = await this.gondi.makeOrder({
      contractAddress: collection.contractAddress,
      tokenId: scope.tokenId,
      currencyAddress: zeroAddress,
      price,
      isAsk: true,
      startTime: BigInt(Math.floor(Date.now() / 1_000)),
      expirationTime: BigInt(Math.floor(expiration.getTime() / 1_000)),
      fees: requiredRoyaltyFees(collection.royalties, price),
    });
    return { id: Number(order.id), price, expiration, executions: 0, active: true };
  }

  /** Throws on a sale paid in a currency other than ETH or WETH, which the loss cannot value. */
  async fills(since: Date): Promise<Fill[]> {
    const sales = await this.api.sales({ user: this.account, from: since });
    return sales.map((sale) => {
      if (
        !isAddressEqual(sale.currencyAddress, zeroAddress) &&
        !isAddressEqual(sale.currencyAddress, WETH)
      ) {
        throw new Error(
          `a sale of ${sale.nft.collection.slug} #${sale.nft.tokenId} was paid in ${sale.currencyAddress}`,
        );
      }
      return {
        slug: sale.nft.collection.slug,
        tokenId: sale.nft.tokenId,
        side: isAddressEqual(sale.receiver, this.account) ? 'buy' : 'sell',
        price: sale.price,
        timestamp: sale.timestamp,
      };
    });
  }

  async saleTerms(slug: string): Promise<SaleTerms> {
    const market = await this.api.collectionMarket({ slug, currencies: [zeroAddress, WETH] });
    return {
      floorPrice: (await this.priceMarket(slug, market)).floorPrice,
      feeBps:
        requiredRoyaltyBps(market.royalties) + (await this.api.saleFeeBps(market.collectionId)),
    };
  }

  async ethUsdPrice() {
    return this.priceApi.currencyUsdPrice(WETH);
  }

  /** The collection as `listingMarket` last read it. */
  private listingCollection(slug: string) {
    const collection = this.listingCollections.get(slug);
    if (!collection) throw new Error(`no listing market of ${slug} yet`);
    return collection;
  }

  private async nftId(scope: ListingScope) {
    const cached = this.nftIds.get(itemKey(scope));
    if (cached !== undefined) return cached;
    const nftId = await this.api.nftId(scope);
    this.nftIds.set(itemKey(scope), nftId);
    return nftId;
  }

  /** The collection's market on `priceApi`: `market` itself when prices come from `api`. */
  private async priceMarket(slug: string, market: CollectionMarket) {
    return this.priceApi === this.api
      ? market
      : this.priceApi.collectionMarket({ slug, currencies: [zeroAddress, WETH] });
  }

  private async lowestCompetingAsk(collectionId: number) {
    const { orders } = await this.priceApi.orders({
      side: 'ASK',
      collections: [collectionId],
      orderTypes: ['SINGLE_NFT'],
      excludeMakers: [this.account],
      currencies: [zeroAddress, WETH],
      sortBy: [{ field: 'PRICE', order: 'ASC' }],
      limit: 1,
    });
    return orders[0]?.price ?? null;
  }

  private async ownListings(scope: ListingScope, collectionId: number, since: Date) {
    const nftId = await this.nftId(scope);
    const { orders } = await this.api.orders({
      side: 'ASK',
      nfts: [{ collectionId, nftId }],
      makers: [this.account],
      statuses: ['Active', 'Executed'],
      sortBy: [{ field: 'CREATED_DATE', order: 'DESC' }],
      limit: OWN_ORDERS_PAGE,
    });
    return orders
      .filter((order) => order.marketPlace === NATIVE_MARKETPLACE)
      .filter((order) => order.status === ACTIVE_STATUS || order.startTime >= since)
      .map(toOwnListing);
  }

  private async bestCompetingBid(collectionId: number) {
    const [best] = await this.competingBidLevels(collectionId, 1);
    return best ?? null;
  }

  /**
   * The best `levels` competing price levels of the collection's WETH bids, best first, the
   * wallet's own excluded: one order for one level, else the book a page at a time until it holds
   * that many distinct prices, ends, or `MAX_BOOK_PAGES` pages are read. Fewer levels than asked
   * leave `level` pricing without a price, so a book cut short waits rather than bids too high.
   */
  private async competingBidLevels(collectionId: number, levels: number) {
    const orders: ApiOrder[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_BOOK_PAGES; page += 1) {
      const read = await this.priceApi.orders({
        side: 'BID',
        collections: [collectionId],
        orderTypes: ['COLLECTION'],
        excludeMakers: [this.account],
        currencies: [WETH],
        sortBy: [{ field: 'PRICE', order: 'DESC' }],
        limit: levels === 1 ? 1 : BOOK_PAGE,
        after,
      });
      orders.push(...read.orders);
      if (!read.nextCursor || bidLevels(orders).length >= levels) break;
      after = read.nextCursor;
    }
    return bidLevels(orders).slice(0, levels);
  }

  /**
   * The wallet's GONDI bids on the collection: every active one, whenever it was placed, and every
   * closed one placed since `since` that bought something. A bid the runner replaced is cancelled,
   * not executed, yet its fills still count against the task's `quantity`.
   *
   * The closed bids are read in full once per run and collection, then only back to the oldest bid
   * that can have closed since the previous read (`closedBidsRead`), so a long run does not page
   * through every bid it ever replaced on each round. Nothing is persisted: a restart reads them in
   * full again.
   */
  private async ownBids(collectionId: number, since: Date) {
    const filter = {
      side: 'BID',
      collections: [collectionId],
      orderTypes: ['COLLECTION'],
      makers: [this.account],
      sortBy: [{ field: 'CREATED_DATE', order: 'DESC' }],
      limit: OWN_ORDERS_PAGE,
    } satisfies OrdersFilter;
    const previous = this.closedBidsReads.get(collectionId);
    const read = previous?.since.getTime() === since.getTime() ? previous : undefined;
    const readAt = new Date();
    const [{ orders: active }, closed] = await Promise.all([
      this.api.orders({ ...filter, statuses: ['Active'] }),
      this.closedBidsSince(filter, read ? closedReadStart(read) : since),
    ]);
    const filled = new Map(read?.filled);
    const unsettled = new Map(read?.unsettled);
    for (const order of active) {
      if (order.startTime >= since) unsettled.set(order.id, order.startTime);
    }
    for (const order of closed) {
      unsettled.delete(order.id);
      if (order.executions > 0) filled.set(order.id, order);
    }
    this.closedBidsReads.set(collectionId, { since, readAt, filled, unsettled });
    return [...active, ...filled.values()]
      .filter((order) => order.marketPlace === NATIVE_MARKETPLACE)
      .map(toOwnBid);
  }

  /** Every closed bid matching `filter` placed since `since`, page by page, newest first. */
  private async closedBidsSince(filter: OrdersFilter, since: Date) {
    const closed: ApiOrder[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.api.orders({ ...filter, statuses: CLOSED_STATUSES, after });
      const recent = page.orders.filter((order) => order.startTime >= since);
      closed.push(...recent);
      if (page.nextCursor === null || recent.length < page.orders.length) return closed;
      after = page.nextCursor;
    }
  }

  private async priceStep(collectionId: number) {
    const cached = this.priceSteps.get(collectionId);
    if (cached !== undefined) return cached;
    const wethStep = await this.api.priceStep(collectionId);
    this.priceSteps.set(collectionId, wethStep);
    return wethStep;
  }
}
