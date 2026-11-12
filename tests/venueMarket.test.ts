import { describe, expect, test } from 'bun:test';

import type { BidScope, BidVenue, OwnBid } from '../src/engine/market';
import { VenueMarket } from '../src/engine/venueMarket';
import { bidOf, FakeMarket, snapshotOf } from './fakeMarket';

/** A venue that records the bid calls it gets. */
const recordingVenue = () => {
  const calls: { method: string; argument: unknown }[] = [];
  const venue: BidVenue = {
    snapshot: async (scope: BidScope) => {
      calls.push({ method: 'snapshot', argument: scope });
      return snapshotOf();
    },
    placeBid: async (bid) => {
      calls.push({ method: 'placeBid', argument: bid });
      return bidOf();
    },
    cancelBids: async (bids: OwnBid[]) => {
      calls.push({ method: 'cancelBids', argument: bids });
    },
  };
  return { venue, calls };
};

const scope: BidScope = { kind: 'collection', slug: 'pudgypenguins', venue: 'gondi' };

describe('VenueMarket', () => {
  test("reads a bid's snapshot from the venue its scope names", async () => {
    const { venue, calls } = recordingVenue();
    await new VenueMarket(new FakeMarket(), { gondi: venue }).snapshot(scope, new Date());
    expect(calls).toEqual([{ method: 'snapshot', argument: scope }]);
  });

  test('places a bid on the venue its scope names', async () => {
    const { venue, calls } = recordingVenue();
    const bid = { scope, price: 1n, quantity: 1, expiration: new Date() };
    await new VenueMarket(new FakeMarket(), { gondi: venue }).placeBid(bid);
    expect(calls).toEqual([{ method: 'placeBid', argument: bid }]);
  });

  test('cancels bids with the venue each one names', async () => {
    const { venue, calls } = recordingVenue();
    const bids = [bidOf({ id: '1' }), bidOf({ id: '2' })];
    await new VenueMarket(new FakeMarket(), { gondi: venue }).cancelBids(bids);
    expect(calls).toEqual([{ method: 'cancelBids', argument: bids }]);
  });

  test('reads everything but bids from the market', async () => {
    const market = new FakeMarket();
    const { venue } = recordingVenue();
    expect(await new VenueMarket(market, { gondi: venue }).heldItems('pudgypenguins')).toEqual(
      market.heldTokenIds,
    );
  });
});
