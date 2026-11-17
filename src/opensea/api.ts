import { type Address, type Hash, type Hex, isAddressEqual } from 'viem';
import { z } from 'zod';

const API_URL = 'https://api.opensea.io/api/v2';
/** Seaport 1.6, the protocol every OpenSea order on Ethereum is made on. */
export const SEAPORT_PROTOCOL: Address = '0x0000000000000068F116a894984e2DB1123eB395';
/** The most offers one page of `offers/collection/{slug}` returns. */
const OFFERS_PAGE = 100;
/** The most listings one page of `listings/collection/{slug}/all` returns. */
const LISTINGS_PAGE = 100;
/** The most pages of the wallet's listings one read follows before it refuses a partial view. */
const MAX_LISTINGS_PAGES = 10;

const address = z.string().transform((value) => value as Address);
const amount = z.coerce.bigint();

const item = z.object({
  itemType: z.number(),
  token: address,
  identifierOrCriteria: z.string(),
  startAmount: amount,
  endAmount: amount,
});

const considerationItem = item.extend({ recipient: address });

const offer = z.object({
  order_hash: z.string().transform((value) => value as Hash),
  protocol_data: z.object({
    parameters: z.object({
      offerer: address,
      offer: z.array(item),
      consideration: z.array(considerationItem),
      startTime: z.coerce.number(),
      endTime: z.coerce.number(),
      zone: address,
    }),
  }),
  remaining_quantity: z.number(),
  status: z.string(),
  criteria: z
    .object({
      collection: z.object({ slug: z.string() }),
      traits: z.array(z.unknown()).nullish(),
      numeric_traits: z.array(z.unknown()).nullish(),
    })
    .nullish(),
});

const offersPage = z.object({ offers: z.array(offer) });

const listing = z.object({
  order_hash: z.string().transform((value) => value as Hash),
  protocol_data: z.object({
    parameters: z.object({
      offerer: address,
      offer: z.array(item),
      consideration: z.array(considerationItem),
      startTime: z.coerce.number(),
      endTime: z.coerce.number(),
      zone: address,
    }),
  }),
  status: z.string().nullish(),
});

const listingsPage = z.object({ listings: z.array(listing), next: z.string().nullish() });

const postedOffer = z.object({ order_hash: z.string().transform((value) => value as Hash) });

const collection = z.object({
  fees: z.array(z.object({ fee: z.number(), recipient: address, required: z.boolean() })),
  collection_offers_enabled: z.boolean(),
});

const builtOffer = z.object({
  partialParameters: z.object({
    consideration: z.array(considerationItem).min(1),
    zone: address,
    zoneHash: z.string().transform((value) => value as Hash),
  }),
});

const hex = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/)
  .transform((value) => value as Hex);
const smallNumber = z.coerce.number().int().nonnegative();

const orderItem = z.object({
  itemType: smallNumber,
  token: address,
  identifierOrCriteria: amount,
  startAmount: amount,
  endAmount: amount,
});

const advancedOrder = z.object({
  parameters: z.object({
    offerer: address,
    zone: address,
    offer: z.array(orderItem),
    consideration: z.array(orderItem.extend({ recipient: address })),
    orderType: smallNumber,
    startTime: amount,
    endTime: amount,
    zoneHash: hex,
    salt: amount,
    conduitKey: hex,
    totalOriginalConsiderationItems: amount,
  }),
  numerator: amount,
  denominator: amount,
  signature: hex,
  extraData: hex,
});

const fulfillAdvancedOrderInput = z.object({
  advancedOrder,
  criteriaResolvers: z.array(
    z.object({
      orderIndex: amount,
      side: smallNumber,
      index: amount,
      identifier: amount,
      criteriaProof: z.array(hex),
    }),
  ),
  fulfillerConduitKey: hex,
  recipient: address,
});

const fulfillmentTransaction = z.object({
  function: z.string(),
  to: address,
  value: amount,
  input_data: z.unknown(),
  calldata_suffix: hex.nullish(),
});

const offerFulfillment = z.object({
  fulfillment_data: z.object({ transaction: fulfillmentTransaction }),
});

export type OpenSeaOffer = z.output<typeof offer>;
export type OpenSeaListing = z.output<typeof listing>;
/**
 * The `fulfillAdvancedOrder` call OpenSea builds to sell one item into an offer: Seaport 1.6's
 * arguments, with the zone's signature in `advancedOrder.extraData`.
 */
export type OfferFulfillment = {
  to: Address;
  value: bigint;
  input: z.output<typeof fulfillAdvancedOrderInput>;
  calldataSuffix: Hex | undefined;
};
export type OpenSeaItem = z.output<typeof item>;
export type OpenSeaConsiderationItem = z.output<typeof considerationItem>;
export type OpenSeaCollection = z.output<typeof collection>;
export type BuiltOffer = z.output<typeof builtOffer>['partialParameters'];

/** A signed Seaport order, as `postOffer` and `postListing` send it. */
export type SignedOrder = {
  parameters: {
    offerer: Address;
    zone: Address;
    offer: OpenSeaItem[];
    consideration: OpenSeaConsiderationItem[];
    orderType: number;
    startTime: bigint;
    endTime: bigint;
    zoneHash: Hash;
    salt: bigint;
    conduitKey: Hash;
    counter: bigint;
  };
  signature: Hex;
};

/** The order as OpenSea's `parameters` take it: every uint256 as a decimal string. */
const wireParameters = ({ parameters }: SignedOrder) => {
  const wireItem = (entry: OpenSeaItem) => ({
    ...entry,
    startAmount: entry.startAmount.toString(),
    endAmount: entry.endAmount.toString(),
  });
  return {
    ...parameters,
    offer: parameters.offer.map(wireItem),
    consideration: parameters.consideration.map((entry) => ({
      ...wireItem(entry),
      recipient: entry.recipient,
    })),
    startTime: parameters.startTime.toString(),
    endTime: parameters.endTime.toString(),
    salt: parameters.salt.toString(),
    counter: parameters.counter.toString(),
    totalOriginalConsiderationItems: parameters.consideration.length,
  };
};

/**
 * OpenSea's REST API, with the operator's own key: reads a collection's offers and fees, and
 * builds, posts and cancels the wallet's collection offers.
 *
 * IMPLEMENTATION NOTE: every call sends the key as `x-api-key` to `https://api.opensea.io/api/v2`
 * (https://docs.opensea.io/reference/api-overview), and a refusal answers
 * `{"errors": ["<message>"]}`. The paths and bodies are the ones `opensea-js` sends
 * (`src/api/apiPaths.ts` and `src/orders/utils.ts` in https://github.com/ProjectOpenSea/opensea-js):
 *
 * - `GET offers/collection/{slug}` lists the collection offers, trait offers left out, best price
 *   per item first (checked against production: 100 BAYC offers came back sorted, and `limit`
 *   tops out at 100). Each offer carries `order_hash`, `protocol_data.parameters` (the Seaport
 *   order, amounts as decimal strings), `remaining_quantity`, `status` and `criteria`.
 * - `GET offers/collection/{slug}/all?maker=` lists one maker's offers of every kind on it.
 * - `GET collections/{slug}` carries `fees` (`fee` in percent, `recipient`, `required`;
 *   https://docs.opensea.io/reference/get_collection), which an offer must pay
 *   (https://docs.opensea.io/docs/opensea-fees).
 * - `POST offers/build` with `{ offerer, quantity, criteria: { collection: { slug } },
 *   protocol_address, offer_protection_enabled }` answers `partialParameters`: the zone, zone hash
 *   and the consideration item the offerer receives (https://docs.opensea.io/reference/build_offer_v2).
 * - `POST offers` with `{ criteria, protocol_address, protocol_data: { parameters, signature } }`
 *   posts the signed order (https://docs.opensea.io/reference/post_criteria_offer_v2).
 * - `GET listings/collection/{slug}/all?maker=&limit=&next=` lists one maker's listings of a
 *   collection, `{ listings, next }`, each with `order_hash`, `protocol_data.parameters` and
 *   `status`, and `next` as the cursor of the following page (`getAllListings` in
 *   `src/api/listings.ts`; https://docs.opensea.io/reference/get_all_listings_on_collection_v2).
 *   `GET orders/ethereum/seaport/listings` is gone: production answered it 405, and opensea-js
 *   now builds that path only to post (`getPostListingPath` in `src/api/apiPaths.ts`).
 * - `POST orders/ethereum/seaport/listings` with `{ parameters, signature, protocol_address }`
 *   posts a signed listing (`postOrder` in `src/api/api.ts`;
 *   https://docs.opensea.io/reference/post_listing).
 * - `POST orders/chain/ethereum/protocol/{seaport}/{order_hash}/cancel` with `{ offererSignature }`
 *   cancels an order the SignedZone protects, with no transaction
 *   (https://docs.opensea.io/reference/cancel_order).
 * - `POST offers/fulfillment_data` with `{ offer: { hash, chain, protocol_address }, fulfiller:
 *   { address }, units_to_fill, consideration: { asset_contract_address, token_id } }` answers
 *   `fulfillment_data.transaction`: the Seaport `function` signature, `to`, `value`, the call's
 *   arguments decoded by name as `input_data` and an optional `calldata_suffix` to append to the
 *   encoded call (`getFulfillOfferPayload` in `src/orders/utils.ts` and `fulfillOrder` in
 *   `src/sdk/fulfillment.ts`; https://docs.opensea.io/reference/generate_offer_fulfillment_data_v2).
 *   A collection offer needs a criteria resolver naming the item sold, so the bot takes only a
 *   `fulfillAdvancedOrder` answer, whose arguments are `advancedOrder`, `criteriaResolvers`,
 *   `fulfillerConduitKey` and `recipient`.
 */
export class OpenSeaApi {
  constructor(
    private readonly apiKey: string,
    private readonly send: typeof fetch = fetch,
  ) {}

  /** The collection's offers, best first, as far as one page reaches. */
  async collectionOffers(slug: string): Promise<OpenSeaOffer[]> {
    const page = await this.request(`offers/collection/${slug}?limit=${OFFERS_PAGE}`);
    return offersPage.parse(page).offers;
  }

  /** `maker`'s collection offers on the collection; its trait and item offers are left out. */
  async ownOffers(slug: string, maker: Address): Promise<OpenSeaOffer[]> {
    const page = await this.request(
      `offers/collection/${slug}/all?limit=${OFFERS_PAGE}&maker=${maker}`,
    );
    return offersPage
      .parse(page)
      .offers.filter(
        (candidate) =>
          candidate.criteria?.collection.slug === slug &&
          !candidate.criteria.traits?.length &&
          !candidate.criteria.numeric_traits?.length,
      );
  }

  async collection(slug: string): Promise<OpenSeaCollection> {
    return collection.parse(await this.request(`collections/${slug}`));
  }

  async buildOffer({
    slug,
    offerer,
    quantity,
  }: {
    slug: string;
    offerer: Address;
    quantity: number;
  }): Promise<BuiltOffer> {
    const built = await this.request('offers/build', {
      offerer,
      quantity,
      criteria: { collection: { slug } },
      protocol_address: SEAPORT_PROTOCOL,
      offer_protection_enabled: true,
    });
    return builtOffer.parse(built).partialParameters;
  }

  /** Posts the signed offer and resolves with its order hash. */
  async postOffer(slug: string, signed: SignedOrder): Promise<Hash> {
    const posted = await this.request('offers', {
      criteria: { collection: { slug } },
      protocol_address: SEAPORT_PROTOCOL,
      protocol_data: { parameters: wireParameters(signed), signature: signed.signature },
    });
    return postedOffer.parse(posted).order_hash;
  }

  /**
   * All of `maker`'s live listings of the collection, following `next` page after page; throws
   * past `MAX_LISTINGS_PAGES` rather than answer part of them, since a listing it missed would be
   * listed again every round. A listing of anyone else is dropped too, in case OpenSea ignores
   * `maker`.
   */
  async ownListings(slug: string, maker: Address): Promise<OpenSeaListing[]> {
    const listings: OpenSeaListing[] = [];
    let cursor: string | null | undefined;
    for (let pages = 0; pages < MAX_LISTINGS_PAGES; pages++) {
      const page = listingsPage.parse(
        await this.request(
          `listings/collection/${slug}/all?limit=${LISTINGS_PAGE}&maker=${maker}${cursor ? `&next=${encodeURIComponent(cursor)}` : ''}`,
        ),
      );
      listings.push(...page.listings);
      cursor = page.next;
      if (!cursor) {
        return listings.filter(
          (candidate) =>
            (candidate.status ?? 'ACTIVE') === 'ACTIVE' &&
            isAddressEqual(candidate.protocol_data.parameters.offerer, maker),
        );
      }
    }
    throw new Error(`the wallet has over ${MAX_LISTINGS_PAGES} pages of OpenSea listings`);
  }

  async postListing(signed: SignedOrder): Promise<void> {
    await this.request('orders/ethereum/seaport/listings', {
      parameters: wireParameters(signed),
      signature: signed.signature,
      protocol_address: SEAPORT_PROTOCOL,
    });
  }

  /** Cancels an order the SignedZone protects, an offer or a listing, with no transaction. */
  async cancelOrder(orderHash: Hash, offererSignature: Hex): Promise<void> {
    await this.request(`orders/chain/ethereum/protocol/${SEAPORT_PROTOCOL}/${orderHash}/cancel`, {
      offererSignature,
    });
  }

  /** What selling `tokenId` of `contract` into the offer `orderHash` takes, as `fulfiller`. */
  async offerFulfillment({
    orderHash,
    fulfiller,
    contract,
    tokenId,
  }: {
    orderHash: Hash;
    fulfiller: Address;
    contract: Address;
    tokenId: bigint;
  }): Promise<OfferFulfillment> {
    const answer = await this.request('offers/fulfillment_data', {
      offer: { hash: orderHash, chain: 'ethereum', protocol_address: SEAPORT_PROTOCOL },
      fulfiller: { address: fulfiller },
      units_to_fill: '1',
      consideration: { asset_contract_address: contract, token_id: tokenId.toString() },
    });
    const { transaction } = offerFulfillment.parse(answer).fulfillment_data;
    const name = transaction.function.split('(')[0];
    if (name !== 'fulfillAdvancedOrder') {
      throw new Error(`OpenSea would sell through ${name}, which the bot does not send`);
    }
    return {
      to: transaction.to,
      value: transaction.value,
      input: fulfillAdvancedOrderInput.parse(transaction.input_data),
      calldataSuffix: transaction.calldata_suffix ?? undefined,
    };
  }

  private async request(path: string, body?: object): Promise<unknown> {
    const response = await this.send(`${API_URL}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const errors = (payload as { errors?: unknown[] } | undefined)?.errors;
      throw new Error(`OpenSea answered ${response.status}: ${String(errors?.[0] ?? 'no reason')}`);
    }
    return payload;
  }
}
