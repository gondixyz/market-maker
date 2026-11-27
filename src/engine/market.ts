import type { Address } from 'viem';

/** The marketplaces a bid can be posted on. */
export const VENUES = ['gondi', 'opensea'] as const;
export type Venue = (typeof VENUES)[number];

/** Each venue's name as people know it. */
export const VENUE_NAMES: Record<Venue, string> = { gondi: 'GONDI', opensea: 'OpenSea' };

/** One trait of a collection's items, as its metadata names it, e.g. `Background: Blue`. */
export type Trait = { type: string; value: string };

/** What a bid can fill with: any item of the collection, or any item with one trait. */
export type BidTarget = { kind: 'collection' } | { kind: 'trait'; trait: Trait };

/**
 * What a bid can fill with, on which collection, and the marketplace it is posted on; `levels` is
 * how many competing price levels its snapshot must read, for `level` pricing (only the best one
 * when omitted).
 */
export type BidScope = BidTarget & { slug: string; venue: Venue; levels?: number };

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
  /**
   * The cheapest active listing the bid can fill with (of the collection, or with the trait), or
   * `null` when nothing is listed.
   */
  floorPrice: bigint | null;
  /**
   * The best bid another wallet makes that a seller of an item the bid can fill with would take
   * instead: a collection bid's competes with the collection bids, a trait bid's with the bids on
   * the trait and the collection bids.
   */
  bestCompetingBid: bigint | null;
  /** Whether `bestCompetingBid` is a bid on GONDI's own book; unset when the market cannot tell. */
  bestCompetingBidOnGondi?: boolean;
  /**
   * The competing price levels, best first, the wallet's own bids excluded: at least the scope's
   * `levels` when the book holds them, which `level` pricing joins.
   */
  competingBidLevels?: bigint[];
  /** The price grid the marketplace accepts bids on; `0n` when it has none. */
  priceStep: bigint;
  /** The wallet's bids on the scope: active ones, and those filled since `since`. */
  ownBids: OwnBid[];
  /** How many items the bid can fill with the wallet holds now. */
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
  /** Whether `lowestCompetingAsk` is a GONDI listing; unset when the market cannot tell. */
  lowestCompetingAskOnGondi?: boolean;
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

/** The best collection bid someone else makes on a venue, as a seller would take it. */
export type ExitOffer = {
  /** The marketplace's own id for the bid, opaque to the engine. */
  id: string;
  /** Where the bid is, which is where the sale goes. */
  venue: Venue;
  /** What selling one item into it pays the seller, its royalties and fees taken out. */
  netPrice: bigint;
};

/** A sale of one held item into an `ExitOffer`. */
export type ExitSale = {
  scope: ListingScope;
  offer: ExitOffer;
  /** The least the sale may pay the seller, its gas taken out; the sale is refused under it. */
  minProceeds: bigint;
};

/**
 * Where held items are sold into other people's collection bids, one transaction each, for listing
 * tasks with `bidExit`: GONDI's own book and OpenSea's offers.
 */
export type ExitVenue = {
  /** The best bid anyone else makes for any item of the collection, or `null` when none. */
  exitOffer(slug: string): Promise<ExitOffer | null>;
  /** What a unit of gas costs now, in wei. */
  gasPrice(): Promise<bigint>;
  /**
   * Sells the item into the offer and resolves once the transaction is mined. Throws, sending
   * nothing, when the offer would pay less than `minProceeds` once its gas is paid.
   */
  sellToOffer(sale: ExitSale): Promise<void>;
};

/** A listing the wallet placed on OpenSea beside its GONDI listing of the same item. */
export type MirrorListing = {
  /** The marketplace's own id for the listing, opaque to the engine. */
  id: string;
  tokenId: bigint;
  /** What a buyer pays, royalties and fees included. */
  price: bigint;
  expiration: Date;
  /** The earliest the marketplace takes an off-chain cancel of it; unset when it takes one at once. */
  cancellableFrom?: Date;
};

/**
 * Where the wallet lists held items beside GONDI, for listing tasks with `openSeaListing`: OpenSea,
 * whose listings are signed off-chain and cancelled off-chain, so mirroring one costs no gas.
 */
export type MirrorVenue = {
  /** The grid the venue takes listing prices on. */
  readonly priceStep: bigint;
  /** The wallet's live listings of the collection's items on the venue. */
  mirrorListings(slug: string): Promise<MirrorListing[]>;
  placeMirrorListing(listing: {
    scope: ListingScope;
    price: bigint;
    expiration: Date;
  }): Promise<MirrorListing>;
  /** Cancels listings without a transaction; throws when any of them can only be cancelled on-chain. */
  cancelMirrorListings(listings: MirrorListing[]): Promise<void>;
};

/** A single-item loan offer the wallet signed, as the lending API reports it. */
export type OwnLoanOffer = {
  /** The API's own id for the offer, opaque to the engine. */
  id: string;
  /** The item the offer lends against. */
  tokenId: bigint;
  principal: bigint;
  aprBps: bigint;
  durationSeconds: bigint;
  expiration: Date;
  /** Hidden from the API's listings; its signature still lends until it expires. */
  hidden: boolean;
};

/** The wallet's loan offers on a collection's items, and the WETH a loan would draw on. */
export type LoanBook = {
  /** The wallet's single-item loan offers on the collection that the API does not report closed. */
  offers: OwnLoanOffer[];
  /** The wallet's WETH, and how much of it the loan contract may pull. */
  balance: bigint;
  allowance: bigint;
};

/**
 * Where the wallet lends against the items it lists, for listing tasks with `loanOffer`: GONDI's
 * single-item loan offers, signed off-chain, which a buyer can take to buy the item now and pay
 * later. An offer cancels only on-chain, so the engine never cancels one: it hides it from the
 * API, off-chain, and lets it expire.
 */
export type LoanVenue = {
  loanBook(slug: string): Promise<LoanBook>;
  /** Signs one item's offer for a single loan. */
  placeLoanOffer(offer: {
    scope: ListingScope;
    principal: bigint;
    aprBps: bigint;
    durationSeconds: bigint;
    /** The origination fee, taken from the principal as the loan starts. */
    fee: bigint;
    expiration: Date;
  }): Promise<OwnLoanOffer>;
  /** Hides the offers from the API's listings, without a transaction. */
  hideLoanOffers(offers: OwnLoanOffer[]): Promise<void>;
};

/**
 * The marketplace the engine trades on. The engine reads and acts only through this port, so its
 * decisions are tested against a fake and another marketplace plugs in behind the same calls.
 */
export interface Market extends ExitVenue {
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
   * cancelled on-chain: the engine spends gas only on `wrapEth` and `sellToOffer`.
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
   * The collection's floor at each of `timestamps`, `null` where it had none, to seed a task's
   * `reference`; unset when the market keeps no history, and the reference starts from the first
   * floor a round reads.
   */
  floorHistory?(slug: string, timestamps: Date[]): Promise<(bigint | null)[]>;
  /**
   * The wallet's ETH and WETH, in wei, as of the latest block, and whether it has a transaction
   * sent but not yet mined, which those balances do not count yet.
   */
  walletBalances(): Promise<{ eth: bigint; weth: bigint; pending: boolean }>;
  /**
   * Wraps `amount` of the wallet's ETH into WETH and resolves once the transaction is mined. Sent
   * on the engine's own only with the tasks file's `wrapEth`.
   */
  wrapEth(amount: bigint): Promise<void>;
  /** Where held items are listed beside GONDI; unset when the run has no OpenSea key. */
  readonly mirror?: MirrorVenue;
  /** Where the wallet lends against its listed items; unset when the market cannot, as in a backtest. */
  readonly loans?: LoanVenue;
}

/**
 * The part of a `Market` that bids on one venue. The book a bid is priced from is the same on every
 * venue; what differs is where the wallet's own bids live, and how they are placed and cancelled.
 */
export type BidVenue = Pick<Market, 'snapshot' | 'placeBid' | 'cancelBids'>;
