import { describe, expect, test } from 'bun:test';

import type { BidScope, BidVenue, ExitOffer, OwnBid } from '../src/engine/market';
import { VenueMarket } from '../src/engine/venueMarket';
import { bidOf, eth, FakeMarket, snapshotOf } from './fakeMarket';

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

  describe('selling a held item', () => {
    const gondiBid: ExitOffer = { id: '7', venue: 'gondi', netPrice: eth('2.3') };
    const openSeaOffer: ExitOffer = { id: '0xoffer', venue: 'opensea', netPrice: eth('2.31') };
    const betterGondiBid: ExitOffer = { ...gondiBid, netPrice: eth('2.32') };
    const marketsWith = (gondiOffer: ExitOffer | null, openSeaExit: ExitOffer | null) => {
      const gondi = new FakeMarket();
      const openSea = new FakeMarket();
      gondi.exitBid = gondiOffer;
      openSea.exitBid = openSeaExit;
      return { gondi, openSea, market: new VenueMarket(gondi, { opensea: openSea }) };
    };
    const saleInto = (offer: ExitOffer) => ({
      scope: { slug: 'pudgypenguins', tokenId: 1n },
      offer,
      minProceeds: eth('2.2'),
    });

    test.each([
      ['OpenSea when its offer pays more', gondiBid, openSeaOffer, openSeaOffer],
      ['GONDI when its bid pays more', betterGondiBid, openSeaOffer, betterGondiBid],
      ['GONDI when OpenSea has no offer', gondiBid, null, gondiBid],
    ])('takes the bid of %s', async (_name, gondiOffer, openSeaExit, expected) => {
      const { market } = marketsWith(gondiOffer, openSeaExit);
      expect(await market.exitOffer('pudgypenguins')).toEqual(expected);
    });

    test('sells on the venue the offer names', async () => {
      const { gondi, openSea, market } = marketsWith(gondiBid, openSeaOffer);

      await market.sellToOffer(saleInto(gondiBid));
      await market.sellToOffer(saleInto(openSeaOffer));

      expect(gondi.exitSales).toEqual([saleInto(gondiBid)]);
      expect(openSea.exitSales).toEqual([saleInto(openSeaOffer)]);
    });

    test('sells only into GONDI bids without OpenSea set up', async () => {
      const gondi = new FakeMarket();
      gondi.exitBid = gondiBid;
      const market = new VenueMarket(gondi, {});

      expect(await market.exitOffer('pudgypenguins')).toEqual(gondiBid);
      await expect(market.sellToOffer(saleInto(openSeaOffer))).rejects.toThrow('not set up');
    });
  });
});
