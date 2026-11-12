import { parseEther } from 'viem';

import type {
  BidScope,
  BidSnapshot,
  Fill,
  ListingMarket,
  ListingScope,
  ListingSnapshot,
  Market,
  OwnBid,
  OwnListing,
  SaleTerms,
} from '../src/engine/market';
import { type BidTask, type ListingTask, parseTasksFile } from '../src/engine/task';

export const eth = (amount: string) => parseEther(amount);

export const snapshotOf = (overrides: Partial<BidSnapshot> = {}): BidSnapshot => ({
  floorPrice: eth('10'),
  bestCompetingBid: eth('8'),
  priceStep: eth('0.01'),
  ownBids: [],
  held: 0,
  balance: eth('100'),
  allowance: eth('100'),
  ...overrides,
});

export const bidOf = (overrides: Partial<OwnBid> = {}): OwnBid => ({
  id: '1',
  venue: 'gondi',
  placedAt: new Date('2029-12-31T23:00:00Z'),
  price: eth('8.01'),
  expiration: new Date('2030-01-01T01:00:00Z'),
  executions: 0,
  maxExecutions: 1,
  active: true,
  cancelsOffChain: true,
  ...overrides,
});

export const listingSnapshotOf = (overrides: Partial<ListingSnapshot> = {}): ListingSnapshot => ({
  lowestCompetingAsk: eth('10'),
  priceStep: eth('0.01'),
  bestCompetingBid: null,
  ownListings: [],
  owned: true,
  approved: true,
  ...overrides,
});

export const listingOf = (overrides: Partial<OwnListing> = {}): OwnListing => ({
  id: 1,
  price: eth('9.99'),
  expiration: new Date('2030-01-01T01:00:00Z'),
  executions: 0,
  active: true,
  ...overrides,
});

export const listingTaskJson = (overrides: object = {}) => ({
  id: 'pudgy-3950',
  kind: 'listing',
  collection: 'pudgypenguins',
  tokenId: '3950',
  pricing: { mode: 'undercut' },
  minPrice: '9',
  maxPrice: '12',
  ...overrides,
});

export const listingTaskOf = (overrides: object = {}): ListingTask => {
  const [task] = tasksFileOf([listingTaskJson(overrides)]).tasks;
  if (task.kind !== 'listing') throw new Error('expected a listing task');
  return task;
};

export const tasksFileOf = (tasks: object[], overrides: object = {}) =>
  parseTasksFile({ version: 1, exposureLimit: '100', tasks, ...overrides });

export const taskOf = (overrides: object = {}): BidTask => {
  const [task] = tasksFileOf([
    {
      id: 'punks',
      kind: 'collectionBid',
      collection: 'pudgypenguins',
      pricing: { mode: 'outbid' },
      minPrice: '5',
      maxPrice: '9',
      ...overrides,
    },
  ]).tasks;
  if (task.kind === 'listing') throw new Error('expected a bid task');
  return task;
};

/**
 * An in-memory market: bids and listings placed land in the wallet's own orders and, like
 * `GondiMarket`, a cancelled bid stays among its collection's own bids, inactive, only when it
 * bought something; the competing book is whatever the test sets. A snapshot only sees the own
 * bids of its collection, and those a test pushes to `ownBids` itself count for every collection.
 */
export class FakeMarket implements Market {
  readonly account = '0x0000000000000000000000000000000000000001' as const;
  market: Omit<BidSnapshot, 'ownBids'> = snapshotOf();
  ownBids: OwnBid[] = [];
  placed: { scope: BidScope; price: bigint; quantity: number; expiration: Date }[] = [];
  snapshotScopes: BidScope[] = [];
  cancelled: string[] = [];
  listingBook: ListingMarket = {
    lowestCompetingAsk: eth('10'),
    priceStep: eth('0.01'),
    bestCompetingBid: null,
    approved: true,
  };
  /** How many times the collection's listing market was read. */
  listingMarketReads = 0;
  ownListings: (OwnListing & { tokenId: bigint })[] = [];
  /** The items of the collection the wallet holds; a listing's item counts as held while listed here. */
  heldTokenIds: bigint[] = [3950n];
  /** Items whose reads fail. */
  failingTokenIds: bigint[] = [];
  placedListings: { scope: ListingScope; price: bigint; expiration: Date }[] = [];
  failNextSnapshot = false;
  /** The wallet's trades, as the sales history reports them. */
  tradeHistory: Fill[] = [];
  terms = new Map<string, SaleTerms>([['pudgypenguins', { floorPrice: eth('10'), feeBps: 550n }]]);
  ethUsd = 2_000;
  /** Makes every read of the wallet's trades fail, as an API outage would. */
  failFills = false;
  /** The `since` of every read of the wallet's trades, in order. */
  fillsReadSince: Date[] = [];
  private nextId = 100;
  private readonly collectionOfBid = new Map<string, string>();

  async fills(since: Date) {
    if (this.failFills) throw new Error('API unavailable');
    this.fillsReadSince.push(since);
    return this.tradeHistory.filter((fill) => fill.timestamp >= since);
  }

  async saleTerms(slug: string) {
    const terms = this.terms.get(slug);
    if (!terms) throw new Error(`invalid collection ${slug}`);
    return terms;
  }

  async ethUsdPrice() {
    return this.ethUsd;
  }

  async snapshot(scope: BidScope) {
    this.snapshotScopes.push(scope);
    if (this.failNextSnapshot) {
      this.failNextSnapshot = false;
      throw new Error('API unavailable');
    }
    const ownBids = this.ownBids.filter(
      (bid) => (this.collectionOfBid.get(bid.id) ?? scope.slug) === scope.slug,
    );
    return { ...this.market, ownBids: ownBids.map((bid) => ({ ...bid })) };
  }

  async placeBid(bid: { scope: BidScope; price: bigint; quantity: number; expiration: Date }) {
    this.placed.push(bid);
    const id = this.nextId++;
    const placed = bidOf({
      id: String(id),
      venue: bid.scope.venue,
      placedAt: new Date(Date.UTC(2030, 0, 1) + id),
      price: bid.price,
      expiration: bid.expiration,
      maxExecutions: bid.quantity,
    });
    this.ownBids.push(placed);
    this.collectionOfBid.set(placed.id, bid.scope.slug);
    return placed;
  }

  async heldItems() {
    return [...this.heldTokenIds];
  }

  async listingMarket() {
    if (this.failNextSnapshot) {
      this.failNextSnapshot = false;
      throw new Error('API unavailable');
    }
    this.listingMarketReads++;
    return { ...this.listingBook };
  }

  async itemListing(scope: ListingScope) {
    if (this.failingTokenIds.includes(scope.tokenId)) throw new Error('API unavailable');
    return {
      owned: this.heldTokenIds.includes(scope.tokenId),
      ownListings: this.ownListings
        .filter((listing) => listing.tokenId === scope.tokenId)
        .map(({ tokenId: _tokenId, ...listing }) => listing),
    };
  }

  async placeListing(listing: { scope: ListingScope; price: bigint; expiration: Date }) {
    this.placedListings.push(listing);
    const placed = listingOf({
      id: this.nextId++,
      price: listing.price,
      expiration: listing.expiration,
    });
    this.ownListings.push({ ...placed, tokenId: listing.scope.tokenId });
    return placed;
  }

  async cancelBids(bids: OwnBid[]) {
    if (bids.some((bid) => !bid.cancelsOffChain)) throw new Error('on-chain cancel');
    for (const bid of bids) {
      this.cancelled.push(bid.id);
      const own = this.ownBids.find((candidate) => candidate.id === bid.id);
      if (own) own.active = false;
    }
    this.ownBids = this.ownBids.filter((bid) => bid.active || bid.executions > 0);
  }
}
