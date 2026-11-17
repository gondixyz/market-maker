import { zeroAddress } from 'viem';

import type { Trait, Venue } from '../../engine/market';
import type { GondiApi, OrdersFilter } from '../../gondi/api';
import { WETH } from '../../gondi/market';
import { OPENSEA_PRICE_STEP } from '../../opensea/market';

/** How many of the top bids of a book are read to find the highest one. */
const TOP_BIDS_PAGE = 50;

/**
 * The `slug` collection's price step on `venue`, its floor (the cheapest ETH or WETH listing) and
 * its top bid (the highest WETH collection bid on any marketplace GONDI indexes), in wei; `null`
 * for a floor or top bid the collection has none of. With a `trait`, the floor is the cheapest
 * listing of an item with it, and the top bid the highest bid such an item sells into: one on the
 * trait or a collection bid, the bids a trait bid competes with. The top bid is display-only, so a
 * failed read of it leaves it `undefined` rather than failing the step and floor the editor's
 * warnings need.
 *
 * IMPLEMENTATION NOTE: `listOrdersV2` sorts bids by `steppedPrice`, the price floored onto the
 * collection's bid step, so bids within one step come in no particular order (checked against the
 * production API: Decagon's 0.0001–0.0003 WETH offers all read `steppedPrice: 0` under a 0.01 step).
 * The top bid is the highest raw `price` of each book's first page, which holds its best step's
 * bids. The trait's and the collection's books are read apart, as `GondiMarket` reads them.
 */
export const collectionPricing = async (
  api: Pick<GondiApi, 'collectionMarket' | 'priceStep' | 'orders' | 'traitMarket'>,
  slug: string,
  venue: Venue,
  trait?: Trait,
) => {
  const market = await api.collectionMarket({ slug, currencies: [zeroAddress, WETH] });
  const traitMarket =
    trait && (await api.traitMarket(market.collectionId, trait, [zeroAddress, WETH]));
  const books: Pick<OrdersFilter, 'collections' | 'traits' | 'orderTypes'>[] = [
    { collections: [market.collectionId], orderTypes: ['COLLECTION'] },
    ...(traitMarket ? [{ traits: [traitMarket.traitId], orderTypes: ['TRAIT' as const] }] : []),
  ];
  const [priceStep, topBid] = await Promise.all([
    venue === 'opensea' ? OPENSEA_PRICE_STEP : api.priceStep(market.collectionId),
    Promise.all(
      books.map((book) =>
        api.orders({
          side: 'BID',
          ...book,
          currencies: [WETH],
          sortBy: [{ field: 'PRICE', order: 'DESC' }],
          limit: TOP_BIDS_PAGE,
        }),
      ),
    ).then(
      (reads) =>
        reads
          .flatMap(({ orders }) => orders)
          .reduce<
            bigint | null
          >((highest, order) => (highest === null || order.price > highest ? order.price : highest), null),
      () => undefined,
    ),
  ]);
  return { priceStep, floor: traitMarket ? traitMarket.floorPrice : market.floorPrice, topBid };
};
