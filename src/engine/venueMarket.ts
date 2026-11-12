import type { BidScope, BidVenue, ListingScope, Market, OwnBid, Venue } from './market';

/**
 * The market the runner trades on when bids go to more than one venue: each bid call goes to the
 * venue its scope or bid names, and everything else (listings, fills, sale terms, ETH's price) to
 * `market`. `cancelBids` cancels each venue's bids with that venue, one venue after another, and
 * stops at the first that throws. A venue left out, such as OpenSea without an API key, fails the
 * calls of the tasks that name it.
 */
export class VenueMarket implements Market {
  constructor(
    private readonly market: Market,
    private readonly venues: Partial<Record<Venue, BidVenue>>,
  ) {}

  get account() {
    return this.market.account;
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

  private venueOf(venue: Venue) {
    const bidVenue = this.venues[venue];
    if (!bidVenue) throw new Error(`bids on ${venue} are not set up in this run`);
    return bidVenue;
  }
}
