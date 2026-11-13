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
import { type RoundReport, Runner } from '../engine/runner';
import type { TasksFile } from '../engine/task';
import { requiredRoyaltyBps } from './market';
import type { PriceHistory, RecordedSale, ReplayCollection } from './replay';

const BPS = 10_000n;
const ROUND_MS = 5 * 60_000;
/** A bid accepted above this share of the floor was an offer on one item, not on the collection. */
const NEAR_FLOOR_BID_BPS = 9_800n;
/** A listing bought above this share of the floor was a chosen item, not the cheapest one. */
const NEAR_FLOOR_ASK_BPS: Record<FillModel, bigint> = { strict: 10_200n, loose: 11_000n };
/** A sale below this share of the floor is noise (a wash or a mispriced test), not a market. */
const LOWEST_SALE_BPS = 5_000n;
const BACKTEST_ACCOUNT = '0x000000000000000000000000000000000000b4c7';

/**
 * How a recorded sale fills the bot's orders. `strict`: a seller who accepted a bid at or below
 * the bot's bid would have taken the bot's instead, and a buyer within 2% of the floor the bot's
 * listing. `loose`: every seller who accepted a bid near the floor would have, the bot being the
 * best bid, paying the higher of the two prices, and every buyer within 10% of the floor would
 * have taken the bot's listing, the cheapest. Either way a listing under the floor reaches further,
 * as floor sweepers take the cheapest item: by as much over the floor as it sits under it.
 */
export type FillModel = 'strict' | 'loose';

type BacktestBid = OwnBid & { slug: string };
type BacktestListing = OwnListing & { slug: string; tokenId: bigint };

/** The wallet's profit at one round, in wei: what its sales made plus its held items at the floor. */
export type ProfitPoint = { at: Date; profit: bigint };

export type BacktestResult = {
  fills: Fill[];
  /** The last round's report, whose `pnl` is the backtest's outcome. */
  report: RoundReport;
  profits: ProfitPoint[];
  /** The deepest fall of `profit` from an earlier high, in wei. */
  worstDrawdown: bigint;
};

const shareOf = (amount: bigint, bps: bigint) => (amount * bps) / BPS;

/** The latest sample at or before `at`, the first one before the history starts. */
const sampleAt = (collection: ReplayCollection, at: Date) =>
  collection.samples.findLast((sample) => sample.at <= at) ?? collection.samples[0]!;

/**
 * A market played from a recorded `PriceHistory`: prices are the recording's at the clock's
 * moment, and the bot's orders fill only when `fillWith` is handed a recorded sale that would
 * have taken them. Nothing is signed or sent.
 */
export class BacktestMarket implements Market {
  readonly account = BACKTEST_ACCOUNT;
  now: Date;
  private readonly bids: BacktestBid[] = [];
  private readonly listings: BacktestListing[] = [];
  private readonly held = new Map<string, Set<bigint>>();
  private readonly madeTrades: Fill[] = [];
  private nextOrderId = 1;
  private nextTokenId = 1n;

  constructor(
    private readonly history: PriceHistory,
    private readonly fillModel: FillModel,
  ) {
    this.now = this.start();
  }

  /** Backtest bids are never short of WETH, so there is never ETH to wrap. */
  async walletBalances() {
    return { eth: 0n, weth: 2n ** 128n, pending: false };
  }

  async wrapEth(): Promise<void> {
    throw new Error('a backtest wraps no ETH');
  }

  /** The first moment the history covers. */
  start() {
    return new Date(
      Math.min(...this.collections().map(([, collection]) => +collection.samples[0]!.at)),
    );
  }

  /** The last moment the history covers. */
  end() {
    return new Date(
      Math.max(...this.collections().map(([, collection]) => +collection.samples.at(-1)!.at)),
    );
  }

  /** Every recorded sale, oldest first, with its collection. */
  sales() {
    return this.collections()
      .flatMap(([slug, collection]) => collection.sales.map((sale) => ({ ...sale, slug })))
      .sort((first, second) => +first.at - +second.at);
  }

  /** Every trade the backtest made so far. */
  trades() {
    return [...this.madeTrades];
  }

  /**
   * Plays one recorded sale against the bot's live orders, at its moment: a sale into a bid fills
   * the bot's best bid, a sale of a listing its cheapest listing, at most one order either way.
   * Returns whether it filled one.
   */
  fillWith(sale: RecordedSale & { slug: string }) {
    this.advanceTo(sale.at);
    const floor = this.floor(sale.slug);
    if (floor === null || sale.price < shareOf(floor, LOWEST_SALE_BPS)) return false;
    if (!sale.tookAsk) {
      const bid = this.bestBid(sale.slug);
      const fills =
        bid !== undefined &&
        (this.fillModel === 'strict'
          ? sale.price <= bid.price
          : sale.price <= shareOf(floor, NEAR_FLOOR_BID_BPS));
      if (fills) this.buy(bid, sale.price > bid.price ? sale.price : bid.price);
      return fills;
    }
    const listing = this.cheapestListing(sale.slug);
    const fills =
      listing !== undefined &&
      sale.price >= listing.price &&
      sale.price <= this.sweeperReach(floor, listing.price);
    if (fills) this.sell(listing);
    return fills;
  }

  /**
   * The most a recorded buyer of a listing can have paid and still have taken the bot's at
   * `listingPrice`: the fill model's share of the floor, plus however far under the floor the
   * listing sits, since a floor sweeper takes the cheapest item and a cheaper one draws buyers who
   * would otherwise have paid more.
   */
  private sweeperReach(floor: bigint, listingPrice: bigint) {
    const discount = floor > listingPrice ? floor - listingPrice : 0n;
    return shareOf(floor, NEAR_FLOOR_ASK_BPS[this.fillModel]) + discount;
  }

  /** Fills a bid any listing now sits at or below, as a trader would buy it and sell into the bid. */
  fillCrossedBids() {
    for (const [slug] of this.collections()) {
      const bid = this.bestBid(slug);
      const floor = this.floor(slug);
      if (bid && floor !== null && floor <= bid.price) this.buy(bid, bid.price);
    }
  }

  /** Moves the clock to `at` and expires the orders whose time has passed. */
  advanceTo(at: Date) {
    this.now = at;
    for (const order of [...this.bids, ...this.listings]) {
      if (order.active && order.expiration <= at) order.active = false;
    }
  }

  async snapshot(scope: BidScope): Promise<BidSnapshot> {
    const collection = this.collection(scope.slug);
    const sample = sampleAt(collection, this.now);
    return {
      floorPrice: sample.floorPrice,
      bestCompetingBid: sample.bestBid,
      priceStep: collection.priceStep,
      ownBids: this.bids
        .filter((bid) => bid.slug === scope.slug && (bid.active || bid.executions > 0))
        .map(({ slug: _slug, ...bid }) => ({ ...bid })),
      held: this.heldOf(scope.slug).size,
      balance: 2n ** 128n,
      allowance: 2n ** 128n,
    };
  }

  async placeBid(bid: { scope: BidScope; price: bigint; quantity: number; expiration: Date }) {
    const placed: BacktestBid = {
      id: String(this.nextOrderId++),
      venue: bid.scope.venue,
      placedAt: this.now,
      slug: bid.scope.slug,
      price: bid.price,
      expiration: bid.expiration,
      executions: 0,
      maxExecutions: bid.quantity,
      active: true,
      cancelsOffChain: true,
    };
    this.bids.push(placed);
    const { slug: _slug, ...own } = placed;
    return { ...own };
  }

  async cancelBids(bids: OwnBid[]) {
    for (const bid of bids) {
      const own = this.bids.find((candidate) => candidate.id === bid.id);
      if (own) own.active = false;
    }
  }

  async heldItems(slug: string) {
    return [...this.heldOf(slug)];
  }

  async listingMarket(slug: string): Promise<ListingMarket> {
    const collection = this.collection(slug);
    const sample = sampleAt(collection, this.now);
    return {
      lowestCompetingAsk: sample.floorPrice,
      bestCompetingBid: sample.bestBid,
      approved: true,
    };
  }

  async itemListing(scope: ListingScope): Promise<ItemListing> {
    return {
      owned: this.heldOf(scope.slug).has(scope.tokenId),
      ownListings: this.listings
        .filter((listing) => listing.slug === scope.slug && listing.tokenId === scope.tokenId)
        .map(({ slug: _slug, tokenId: _tokenId, ...listing }) => ({ ...listing })),
    };
  }

  async placeListing(listing: { scope: ListingScope; price: bigint; expiration: Date }) {
    const placed: BacktestListing = {
      id: this.nextOrderId++,
      slug: listing.scope.slug,
      tokenId: listing.scope.tokenId,
      price: listing.price,
      expiration: listing.expiration,
      executions: 0,
      active: true,
    };
    this.listings.push(placed);
    const { slug: _slug, tokenId: _tokenId, ...own } = placed;
    return { ...own };
  }

  async fills(since: Date) {
    return this.madeTrades.filter((fill) => fill.timestamp >= since);
  }

  async saleTerms(slug: string): Promise<SaleTerms> {
    const collection = this.collection(slug);
    return {
      floorPrice: this.floor(slug),
      feeBps: requiredRoyaltyBps(collection.royalties) + collection.saleFeeBps,
    };
  }

  async ethUsdPrice() {
    return this.history.ethUsdPrice;
  }

  private collections() {
    return Object.entries(this.history.collections);
  }

  private collection(slug: string) {
    const collection = this.history.collections[slug];
    if (!collection) throw new Error(`${slug} is not in the recorded history`);
    return collection;
  }

  private floor(slug: string) {
    return sampleAt(this.collection(slug), this.now).floorPrice;
  }

  private heldOf(slug: string) {
    const held = this.held.get(slug) ?? new Set<bigint>();
    this.held.set(slug, held);
    return held;
  }

  private bestBid(slug: string) {
    return this.bids
      .filter((bid) => bid.slug === slug && bid.active)
      .sort((first, second) =>
        first.price === second.price ? 0 : first.price < second.price ? 1 : -1,
      )[0];
  }

  private cheapestListing(slug: string) {
    const held = this.heldOf(slug);
    return this.listings
      .filter((listing) => listing.slug === slug && listing.active && held.has(listing.tokenId))
      .sort((first, second) =>
        first.price === second.price ? 0 : first.price < second.price ? -1 : 1,
      )[0];
  }

  private buy(bid: BacktestBid, price: bigint) {
    bid.executions += 1;
    if (bid.executions >= bid.maxExecutions) bid.active = false;
    const tokenId = this.nextTokenId++;
    this.heldOf(bid.slug).add(tokenId);
    this.madeTrades.push({ slug: bid.slug, tokenId, side: 'buy', price, timestamp: this.now });
  }

  private sell(listing: BacktestListing) {
    for (const other of this.listings) {
      if (other.slug === listing.slug && other.tokenId === listing.tokenId) other.active = false;
    }
    listing.executions = 1;
    this.heldOf(listing.slug).delete(listing.tokenId);
    this.madeTrades.push({
      slug: listing.slug,
      tokenId: listing.tokenId,
      side: 'sell',
      price: listing.price,
      timestamp: this.now,
    });
  }
}

/** The round's profit across collections, in wei: sales made plus held items at the floor. */
const profitOf = (report: RoundReport) =>
  (report.pnl?.collections ?? []).reduce(
    (total, collection) => total + collection.realized + (collection.unrealized ?? 0n),
    0n,
  );

/** The deepest fall of a profit series from an earlier high. */
const worstDrawdownOf = (profits: ProfitPoint[]) => {
  let high = 0n;
  let worst = 0n;
  for (const { profit } of profits) {
    if (profit > high) high = profit;
    if (high - profit > worst) worst = high - profit;
  }
  return worst;
};

/**
 * Runs the tasks file through the engine over a recorded history, as if the bot had traded it:
 * a round every five minutes and one straight after each fill, its loss limits counted from the
 * history's start. `onRound` sees every round at its replayed moment, such as to push its metrics.
 */
export const runBacktest = async ({
  history,
  file,
  fillModel,
  onRound,
}: {
  history: PriceHistory;
  file: TasksFile;
  fillModel: FillModel;
  onRound?: (report: RoundReport, at: Date) => Promise<void> | void;
}): Promise<BacktestResult> => {
  const market = new BacktestMarket(history, fillModel);
  const start = market.start();
  const lossLimits = file.lossLimits && { ...file.lossLimits, since: start };
  const runner = new Runner(market, { ...file, lossLimits }, start, () => market.now);
  const profits: ProfitPoint[] = [];
  let report: RoundReport | undefined;
  runner.on('round', (round) => {
    report = round;
    profits.push({ at: market.now, profit: profitOf(round) });
  });
  const round = async () => {
    await runner.round();
    await onRound?.(report!, market.now);
  };
  const sales = market.sales();
  let next = 0;
  for (let at = +start; at <= +market.end(); at += ROUND_MS) {
    for (; next < sales.length && +sales[next]!.at <= at; next++) {
      if (market.fillWith(sales[next]!)) await round();
    }
    market.advanceTo(new Date(at));
    market.fillCrossedBids();
    await round();
  }
  return {
    fills: market.trades(),
    report: report!,
    profits,
    worstDrawdown: worstDrawdownOf(profits),
  };
};
