import type {
  BidScope,
  BidVenue,
  ExitOffer,
  ExitSale,
  ExitVenue,
  ListingScope,
  Market,
  MirrorVenue,
  OwnBid,
  Venue,
} from './market';

/** The venues bids go to; OpenSea's also takes exits into its offers and mirrors listings. */
export type Venues = { gondi?: BidVenue; opensea?: BidVenue & ExitVenue & MirrorVenue };

/**
 * The market the runner trades on when bids go to more than one venue: each bid call goes to the
 * venue its scope or bid names, and everything else (listings, fills, sale terms, ETH's price, the wallet's balances and wrapping) to
 * `market`. `cancelBids` cancels each venue's bids with that venue, one venue after another, and
 * stops at the first that throws. A venue left out, such as OpenSea without an API key, fails the
 * calls of the tasks that name it. An exit takes the best of `market`'s bids and, when set up,
 * OpenSea's, and its sale goes to the venue of the bid it takes.
 */
export class VenueMarket implements Market {
  constructor(
    private readonly market: Market,
    private readonly venues: Venues,
  ) {}

  get account() {
    return this.market.account;
  }

  /** OpenSea, when the run has its key, where held items are listed beside GONDI. */
  get mirror(): MirrorVenue | undefined {
    return this.venues.opensea;
  }

  /** GONDI's loan offers, which only `market` makes. */
  get loans() {
    return this.market.loans;
  }

  snapshot(scope: BidScope, since: Date) {
    return this.venueOf(scope.venue).snapshot(scope, since);
  }

  placeBid(bid: Parameters<Market['placeBid']>[0]) {
    return this.venueOf(bid.scope.venue).placeBid(bid);
  }

  async cancelBids(bids: OwnBid[]) {
    for (const venue of new Set(bids.map((bid) => bid.venue))) {
      await this.venueOf(venue).cancelBids(bids.filter((bid) => bid.venue === venue));
    }
  }

  heldItems(slug: string) {
    return this.market.heldItems(slug);
  }

  listingMarket(slug: string) {
    return this.market.listingMarket(slug);
  }

  itemListing(scope: ListingScope, since: Date) {
    return this.market.itemListing(scope, since);
  }

  placeListing(listing: Parameters<Market['placeListing']>[0]) {
    return this.market.placeListing(listing);
  }

  fills(since: Date) {
    return this.market.fills(since);
  }

  saleTerms(slug: string) {
    return this.market.saleTerms(slug);
  }

  ethUsdPrice() {
    return this.market.ethUsdPrice();
  }

  async floorHistory(slug: string, timestamps: Date[]) {
    if (!this.market.floorHistory) throw new Error('the market keeps no floor history');
    return this.market.floorHistory(slug, timestamps);
  }

  walletBalances() {
    return this.market.walletBalances();
  }

  wrapEth(amount: bigint) {
    return this.market.wrapEth(amount);
  }

  /**
   * The bid on GONDI (`market`) or on OpenSea, when set up, that pays the seller most; either read
   * failing fails it, so a sale never goes to the worse bid of the two.
   */
  async exitOffer(slug: string) {
    const offers = await Promise.all([
      this.market.exitOffer(slug),
      this.venues.opensea?.exitOffer(slug) ?? null,
    ]);
    return offers.reduce<ExitOffer | null>(
      (best, offer) => (offer && (!best || offer.netPrice > best.netPrice) ? offer : best),
      null,
    );
  }

  gasPrice() {
    return this.market.gasPrice();
  }

  async sellToOffer(sale: ExitSale) {
    if (sale.offer.venue === 'gondi') return this.market.sellToOffer(sale);
    if (!this.venues.opensea) throw new Error('OpenSea exits are not set up in this run');
    return this.venues.opensea.sellToOffer(sale);
  }

  private venueOf(venue: Venue) {
    const bidVenue = this.venues[venue];
    if (!bidVenue) throw new Error(`bids on ${venue} are not set up in this run`);
    return bidVenue;
  }
}
