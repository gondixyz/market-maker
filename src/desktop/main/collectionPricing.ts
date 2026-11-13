import { zeroAddress } from 'viem';

import type { Venue } from '../../engine/market';
import type { GondiApi } from '../../gondi/api';
import { WETH } from '../../gondi/market';
import { OPENSEA_PRICE_STEP } from '../../opensea/market';

/** How many of the top collection bids are read to find the highest one. */
const TOP_BIDS_PAGE = 50;

/**
 * The `slug` collection's price step on `venue`, its floor (the cheapest ETH or WETH listing) and
 * its top bid (the highest WETH collection bid on any marketplace GONDI indexes), in wei; `null`
 * for a floor or top bid the collection has none of. The top bid is display-only, so a failed read
 * of it leaves it `undefined` rather than failing the step and floor the editor's warnings need.
 *
 * IMPLEMENTATION NOTE: `listOrdersV2` sorts bids by `steppedPrice`, the price floored onto the
 * collection's bid step, so bids within one step come in no particular order (checked against the
 * production API: Decagon's 0.0001–0.0003 WETH offers all read `steppedPrice: 0` under a 0.01 step).
 * The top bid is the highest raw `price` of the first page, which holds the best step's bids.
 */
export const collectionPricing = async (
  api: Pick<GondiApi, 'collectionMarket' | 'priceStep' | 'orders'>,
  slug: string,
  venue: Venue,
) => {
  const market = await api.collectionMarket({ slug, currencies: [zeroAddress, WETH] });
  const [priceStep, topBid] = await Promise.all([
    venue === 'opensea' ? OPENSEA_PRICE_STEP : api.priceStep(market.collectionId),
    api
      .orders({
        side: 'BID',
        collections: [market.collectionId],
        orderTypes: ['COLLECTION'],
        currencies: [WETH],
        sortBy: [{ field: 'PRICE', order: 'DESC' }],
        limit: TOP_BIDS_PAGE,
      })
      .then(
        ({ orders }) =>
          orders.reduce<bigint | null>(
            (highest, order) => (highest === null || order.price > highest ? order.price : highest),
            null,
          ),
        () => undefined,
      ),
  ]);
  return { priceStep, floor: market.floorPrice, topBid };
};
