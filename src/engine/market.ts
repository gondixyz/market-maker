import type { Address } from 'viem';

/** The marketplaces a bid can be posted on. */
export const VENUES = ['gondi', 'opensea'] as const;
export type Venue = (typeof VENUES)[number];

/**
 * What a bid can fill with, and the marketplace it is posted on; `levels` is how many competing
 * price levels its snapshot must read, for `level` pricing (only the best one when omitted).
 */
export type BidScope = { kind: 'collection'; slug: string; venue: Venue; levels?: number };

/** A bid the wallet itself placed, as the marketplace reports it. */
export type OwnBid = {
  /** The marketplace's own id for the bid, opaque to the engine. */
  id: string;
  venue: Venue;
  /** When the bid started, what tells the newest of a task's bids. */
  placedAt: Date;
  price: bigint;
  expiration: Date;
  executions: number;
  /** How many items the bid may buy in all; `maxExecutions - executions` are left. */
  maxExecutions: number;
  active: boolean;
  cancelsOffChain: boolean;
  /**
   * The earliest the marketplace takes an off-chain cancel of the bid; unset when it takes one at
   * once. A bid before then stays up, so a decision neither cancels it nor places another beside it.
   */
  cancellableFrom?: Date;
};

/** Everything one decision about a bid needs, read at one moment. */
export type BidSnapshot = {
  /** The cheapest active listing, or `null` when nothing is listed. */
  floorPrice: bigint | null;
  /** The best competing bid of the same kind, the wallet's own excluded. */
  bestCompetingBid: bigint | null;
  /**
   * The competing price levels, best first, the wallet's own bids excluded: at least the scope's
   * `levels` when the book holds them, which `level` pricing joins.
   */
  competingBidLevels?: bigint[];
  /** The price grid the marketplace accepts bids on; `0n` when it has none. */
  priceStep: bigint;
  /** The wallet's bids on the scope: active ones, and those filled since `since`. */
  ownBids: OwnBid[];
  /** How many items of the collection the wallet holds now. */
  held: number;
  balance: bigint;
  allowance: bigint;
};

/** The item a listing sells. */
export type ListingScope = { slug: string; tokenId: bigint };

/** A listing the wallet itself placed, as the marketplace reports it. */
export type OwnListing = {
  id: number;
  price: bigint;
  expiration: Date;
  executions: number;
  active: boolean;
};

/** The collection's side of a listing decision: the same for every item, so read once a round. */
export type ListingMarket = {
  /** The cheapest active listing of another item in the collection, or `null` when there is none. */
  lowestCompetingAsk: bigint | null;
  /** The best competing bid, which an ask under it contradicts (`crossedBook`); `null` when none. */
  bestCompetingBid: bigint | null;
  /** Whether the marketplace may move the collection's items out of the wallet. */
  approved: boolean;
};

/** The item's side of a listing decision. */
export type ItemListing = {
  /** The wallet's listings of the item: active ones, and those filled since `since`. */
  ownListings: OwnListing[];
  /** Whether the wallet holds the item. */
  owned: boolean;
};

/** Everything one decision about a listing needs. */
export type ListingSnapshot = ListingMarket & ItemListing;

/** An item the wallet bought or sold, as the marketplace's sales history reports it. */
export type Fill = {
  slug: string;
  tokenId: bigint;
  side: 'buy' | 'sell';
  /** What the buyer paid, in wei of ETH or WETH, before royalties and fees. */
  price: bigint;
  timestamp: Date;
};

/** What a sale of one of the collection's items is worth to the wallet. */
export type SaleTerms = {
  /** The cheapest active listing, or `null` when nothing is listed. */
  floorPrice: bigint | null;
  /** What the seller does not receive of a sale's price, in basis points: royalties and fees. */
  feeBps: bigint;
};

/**
 * The marketplace the engine trades on. The engine reads and acts only through this port, so its
 * decisions are tested against a fake and another marketplace plugs in behind the same calls.
 */
export interface Market {
  readonly account: Address;
  snapshot(scope: BidScope, since: Date): Promise<BidSnapshot>;
  placeBid(bid: {
    scope: BidScope;
    price: bigint;
    quantity: number;
    expiration: Date;
  }): Promise<OwnBid>;
  /**
   * Cancels bids without a transaction. Throws, cancelling nothing, when any of them can only be
   * cancelled on-chain: the engine spends gas only on `wrapEth`.
   */
  cancelBids(bids: OwnBid[]): Promise<void>;
  /** The token ids of the collection's items the wallet holds. */
  heldItems(slug: string): Promise<bigint[]>;
  listingMarket(slug: string): Promise<ListingMarket>;
  /** Reads one item of the collection; call `listingMarket` for the collection first. */
  itemListing(scope: ListingScope, since: Date): Promise<ItemListing>;
  /** Lists the item. There is no listing cancel: one costs a transaction, so it is never automatic. */
  placeListing(listing: {
    scope: ListingScope;
    price: bigint;
    expiration: Date;
  }): Promise<OwnListing>;
  /** Every item the wallet bought or sold since `since`, wherever it traded. */
  fills(since: Date): Promise<Fill[]>;
  /** The collection's floor and what a sale pays in royalties and fees. */
  saleTerms(slug: string): Promise<SaleTerms>;
  /** The current price of one ETH in USD. */
  ethUsdPrice(): Promise<number>;
  /**
   * The wallet's ETH and WETH, in wei, as of the latest block, and whether it has a transaction
   * sent but not yet mined, which those balances do not count yet.
   */
  walletBalances(): Promise<{ eth: bigint; weth: bigint; pending: boolean }>;
  /**
   * Wraps `amount` of the wallet's ETH into WETH and resolves once the transaction is mined. The
   * one transaction the engine sends on its own, and only with the tasks file's `wrapEth`.
   */
  wrapEth(amount: bigint): Promise<void>;
}

/**
 * The part of a `Market` that bids on one venue. The book a bid is priced from is the same on every
 * venue; what differs is where the wallet's own bids live, and how they are placed and cancelled.
 */
export type BidVenue = Pick<Market, 'snapshot' | 'placeBid' | 'cancelBids'>;
