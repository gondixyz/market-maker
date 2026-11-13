import type { Gondi } from 'gondi';
import { type Address, type Hash, isAddressEqual, parseAbi, zeroAddress } from 'viem';
import { mainnet } from 'viem/chains';

import type { BidScope, BidSnapshot, BidVenue, OwnBid } from '../engine/market';
import type { GondiApi } from '../gondi/api';
import { WETH } from '../gondi/market';
import {
  type OpenSeaApi,
  type OpenSeaCollection,
  type OpenSeaConsiderationItem,
  type OpenSeaOffer,
  SEAPORT_PROTOCOL,
} from './api';

/** The conduit OpenSea's orders name, and the contract a wallet lets spend the WETH they pay. */
export const OPENSEA_CONDUIT_KEY: Hash =
  '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000';
export const OPENSEA_CONDUIT: Address = '0x1E0049783F008A0085193E00003D00cd54003c71';
/**
 * How long a posted offer counts as the wallet's own before OpenSea lists it: production listed new
 * offers 20 to 40 seconds after they were posted, so a round in between would otherwise post again.
 */
const LISTING_DELAY_MS = 120_000;
/**
 * How long after its start OpenSea refuses to cancel an offer off-chain ("Orders created recently
 * must be cancelled onchain"). OpenSea does not document it; production refused cancels of offers
 * 4m46s to 4m56s old and took them at 5m04s to 5m14s, so five minutes, plus a margin for the
 * seconds between an offer's start time and when OpenSea records it.
 */
const OFF_CHAIN_CANCEL_DELAY_MS = 330_000;
/** OpenSea's SignedZone: the orders it protects are the ones OpenSea cancels without a transaction. */
const OPENSEA_SIGNED_ZONE: Address = '0x000056f7000000ece9003ca63978907a00ffd100';

/**
 * OpenSea takes offers only on a 0.01 WETH grid: it refused a 2.3265 WETH offer with "Bids at this
 * price are not allowed. Please place a bid in the nearest allowed increment. 2 decimals allowed".
 * The engine floors a bid onto the step, so an offer never goes above its task's limits.
 */
export const OPENSEA_PRICE_STEP = 10n ** 16n;

const ERC20_ITEM = 1;
const PARTIAL_RESTRICTED = 3;
const BPS = 10_000n;

const seaportAbi = parseAbi(['function getCounter(address offerer) view returns (uint256)']);
const erc721Abi = parseAbi(['function balanceOf(address owner) view returns (uint256)']);

const SEAPORT_DOMAIN = {
  name: 'Seaport',
  version: '1.6',
  chainId: mainnet.id,
  verifyingContract: SEAPORT_PROTOCOL,
} as const;

const ORDER_TYPES = {
  OrderComponents: [
    { name: 'offerer', type: 'address' },
    { name: 'zone', type: 'address' },
    { name: 'offer', type: 'OfferItem[]' },
    { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' },
    { name: 'startTime', type: 'uint256' },
    { name: 'endTime', type: 'uint256' },
    { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' },
    { name: 'conduitKey', type: 'bytes32' },
    { name: 'counter', type: 'uint256' },
  ],
  OfferItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
  ],
  ConsiderationItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
  ],
} as const;

const ORDER_HASH_TYPES = { OrderHash: [{ name: 'orderHash', type: 'bytes32' }] } as const;

/** How many items the offer may buy in all: the amount of its first consideration item, the NFT. */
const quantityOf = (offer: OpenSeaOffer) =>
  offer.protocol_data.parameters.consideration[0].startAmount;

/** What the offer pays per item: its WETH amount over the items it may buy. */
const pricePerItem = (offer: OpenSeaOffer) =>
  offer.protocol_data.parameters.offer[0].startAmount / quantityOf(offer);

/** When OpenSea first takes an off-chain cancel of an offer that started at `placedAt`. */
const cancellableFrom = (placedAt: Date) =>
  new Date(placedAt.getTime() + OFF_CHAIN_CANCEL_DELAY_MS);

/** An offer of the wallet's own, with its order hash as its id, which is what cancels it. */
const toOwnBid = (offer: OpenSeaOffer): OwnBid => {
  const maxExecutions = Number(quantityOf(offer));
  const placedAt = new Date(offer.protocol_data.parameters.startTime * 1_000);
  return {
    id: offer.order_hash,
    venue: 'opensea',
    placedAt,
    price: pricePerItem(offer),
    expiration: new Date(offer.protocol_data.parameters.endTime * 1_000),
    executions: maxExecutions - offer.remaining_quantity,
    maxExecutions,
    active: offer.status === 'ACTIVE',
    cancelsOffChain: isAddressEqual(offer.protocol_data.parameters.zone, OPENSEA_SIGNED_ZONE),
    cancellableFrom: cancellableFrom(placedAt),
  };
};

/** Each price anyone but `account` offers per item, once, best first. */
export const competingBidLevels = (offers: OpenSeaOffer[], account: Address) =>
  [
    ...new Set(
      offers
        .filter((offer) => !isAddressEqual(offer.protocol_data.parameters.offerer, account))
        .map(pricePerItem),
    ),
  ].sort((first, second) => (first > second ? -1 : first < second ? 1 : 0));

/**
 * The fees an offer of `quantity` items at `price` each must pay, as WETH consideration items:
 * each of the collection's required fees, floored per item so the order splits evenly when it
 * fills partly.
 */
export const requiredFees = (
  collection: OpenSeaCollection,
  price: bigint,
  quantity: number,
): OpenSeaConsiderationItem[] =>
  collection.fees
    .filter((fee) => fee.required)
    .map((fee) => {
      const total = ((price * BigInt(Math.round(fee.fee * 100))) / BPS) * BigInt(quantity);
      return {
        itemType: ERC20_ITEM,
        token: WETH,
        identifierOrCriteria: '0',
        startAmount: total,
        endAmount: total,
        recipient: fee.recipient,
      };
    });

/** A random Seaport salt, so two offers with the same terms still hash apart. */
const randomSalt = () =>
  BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}`);

/**
 * The engine's bid venue on OpenSea: WETH collection offers posted with the operator's own
 * OpenSea API key, signed by the bot wallet. Competing bids are OpenSea's other collection offers,
 * one price level per distinct price, so `level` pricing can join the book below its top; the
 * floor comes from GONDI's API, the cheapest listing wherever it is, as for GONDI bids.
 *
 * Each snapshot re-reads the wallet's offers from OpenSea, and a bid's id is its order hash, which is
 * all `cancelBids` needs. OpenSea lists a new offer only some seconds after accepting it, so an offer
 * this run posted counts among the wallet's own until a read shows it, it is cancelled, or
 * `LISTING_DELAY_MS` passes; without that, the rounds in between post the same offer again. That
 * memory is the only state kept, and only in memory. A filled offer is gone from those reads, so
 * `maxItems`, checked against the items the wallet holds on-chain, is what stops an OpenSea bid task
 * after a fill.
 *
 * IMPLEMENTATION NOTE: an offer is built the way `opensea-js` builds a collection offer
 * (`createCollectionOffer` in `src/sdk/orders.ts`, https://github.com/ProjectOpenSea/opensea-js):
 * `offers/build` returns the zone, zone hash and the NFT consideration item; the order offers the
 * WETH, pays each required fee of `collections/{slug}` from it, may fill partly and is restricted
 * to the zone (order type 3), with OpenSea's conduit key and the wallet's Seaport counter. It is
 * signed as Seaport 1.6's EIP-712 `OrderComponents` (`EIP_712_ORDER_TYPE` in
 * https://github.com/ProjectOpenSea/seaport-js/blob/main/src/constants.ts). Seaport pulls the WETH
 * through that conduit, so the wallet must let OpenSea's conduit spend it, not Seaport itself.
 * A cancel is signed as EIP-712 `OrderHash { bytes32 orderHash }` under the same domain
 * (`getOffererSignature` in opensea-js's `src/sdk/cancellation.ts`); OpenSea refuses it for an
 * order created moments before ("Orders created recently must be cancelled onchain"), so each
 * offer carries `cancellableFrom`, and `reconcile` leaves it up until then rather than cancel it.
 */
export class OpenSeaMarket implements BidVenue {
  private readonly collections = new Map<string, OpenSeaCollection>();
  /** The offers this run posted that OpenSea may not list yet, by collection slug. */
  private readonly unlisted = new Map<string, OwnBid[]>();

  constructor(
    private readonly gondi: Gondi,
    private readonly openSea: OpenSeaApi,
    private readonly gondiApi: GondiApi,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (gondi.wallet.chain?.id !== mainnet.id) throw new Error('OpenSea bids run on mainnet only');
  }

  get account() {
    return this.gondi.account.address;
  }

  async snapshot(scope: BidScope): Promise<BidSnapshot> {
    const [market, offers, ownOffers] = await Promise.all([
      this.gondiApi.collectionMarket({ slug: scope.slug, currencies: [zeroAddress, WETH] }),
      this.openSea.collectionOffers(scope.slug),
      this.openSea.ownOffers(scope.slug, this.account),
      this.collection(scope.slug),
    ]);
    const [held, balance, allowance] = await Promise.all([
      this.gondi.bcClient.readContract({
        address: market.contractAddress,
        abi: erc721Abi,
        functionName: 'balanceOf',
        args: [this.account],
      }),
      this.gondi.currencyBalance({ tokenAddress: WETH }),
      this.gondi.currencyAllowance({ tokenAddress: WETH, to: OPENSEA_CONDUIT }),
    ]);
    const levels = competingBidLevels(offers, this.account);
    const listed = ownOffers.map(toOwnBid);
    return {
      floorPrice: market.floorPrice,
      bestCompetingBid: levels[0] ?? null,
      competingBidLevels: levels,
      priceStep: OPENSEA_PRICE_STEP,
      ownBids: [...listed, ...this.stillUnlisted(scope.slug, listed)],
      held: Number(held),
      balance,
      allowance,
    };
  }

  async placeBid({ scope, price, quantity, expiration }: Parameters<BidVenue['placeBid']>[0]) {
    const [collection, built, counter] = await Promise.all([
      this.collection(scope.slug),
      this.openSea.buildOffer({ slug: scope.slug, offerer: this.account, quantity }),
      this.gondi.bcClient.readContract({
        address: SEAPORT_PROTOCOL,
        abi: seaportAbi,
        functionName: 'getCounter',
        args: [this.account],
      }),
    ]);
    const total = price * BigInt(quantity);
    const startTime = Math.floor(this.now().getTime() / 1_000);
    const parameters = {
      offerer: this.account,
      zone: built.zone,
      offer: [
        {
          itemType: ERC20_ITEM,
          token: WETH,
          identifierOrCriteria: '0',
          startAmount: total,
          endAmount: total,
        },
      ],
      consideration: [built.consideration[0], ...requiredFees(collection, price, quantity)],
      orderType: PARTIAL_RESTRICTED,
      startTime: BigInt(startTime),
      endTime: BigInt(Math.floor(expiration.getTime() / 1_000)),
      zoneHash: built.zoneHash,
      salt: randomSalt(),
      conduitKey: OPENSEA_CONDUIT_KEY,
      counter,
    };
    const signature = await this.gondi.wallet.signTypedData({
      account: this.gondi.account,
      domain: SEAPORT_DOMAIN,
      types: ORDER_TYPES,
      primaryType: 'OrderComponents',
      message: {
        ...parameters,
        offer: parameters.offer.map((item) => ({
          ...item,
          identifierOrCriteria: BigInt(item.identifierOrCriteria),
        })),
        consideration: parameters.consideration.map((item) => ({
          ...item,
          identifierOrCriteria: BigInt(item.identifierOrCriteria),
        })),
      },
    });
    const orderHash = await this.openSea.postOffer(scope.slug, { parameters, signature });
    const placedAt = new Date(startTime * 1_000);
    const placed: OwnBid = {
      id: orderHash,
      venue: 'opensea' as const,
      placedAt,
      price,
      expiration,
      executions: 0,
      maxExecutions: quantity,
      active: true,
      cancelsOffChain: isAddressEqual(built.zone, OPENSEA_SIGNED_ZONE),
      cancellableFrom: cancellableFrom(placedAt),
    };
    this.unlisted.set(scope.slug, [...(this.unlisted.get(scope.slug) ?? []), placed]);
    return placed;
  }

  async cancelBids(bids: OwnBid[]) {
    const onChainOnly = bids.filter((bid) => !bid.cancelsOffChain);
    if (onChainOnly.length > 0) {
      throw new Error(
        `offers ${onChainOnly.map((bid) => bid.id).join(', ')} can only be cancelled on-chain`,
      );
    }
    for (const bid of bids) {
      const orderHash = bid.id as Hash;
      const signature = await this.gondi.wallet.signTypedData({
        account: this.gondi.account,
        domain: SEAPORT_DOMAIN,
        types: ORDER_HASH_TYPES,
        primaryType: 'OrderHash',
        message: { orderHash },
      });
      await this.openSea.cancelOffer(orderHash, signature);
      for (const [slug, offers] of this.unlisted) {
        this.unlisted.set(
          slug,
          offers.filter((offer) => offer.id !== bid.id),
        );
      }
    }
  }

  /**
   * The offers this run posted on `slug` that `listed` does not show yet and that OpenSea has not
   * had `LISTING_DELAY_MS` to list; the rest are forgotten.
   */
  private stillUnlisted(slug: string, listed: OwnBid[]) {
    const now = this.now().getTime();
    const remaining = (this.unlisted.get(slug) ?? []).filter(
      (offer) =>
        now - offer.placedAt.getTime() < LISTING_DELAY_MS &&
        !listed.some((listedOffer) => listedOffer.id === offer.id),
    );
    this.unlisted.set(slug, remaining);
    return remaining;
  }

  /** The collection's OpenSea terms, read once a run: its fees change rarely, and reads are rationed. */
  private async collection(slug: string) {
    const cached = this.collections.get(slug);
    if (cached) return cached;
    const collection = await this.openSea.collection(slug);
    if (!collection.collection_offers_enabled) {
      throw new Error(`OpenSea takes no collection offers on ${slug}`);
    }
    this.collections.set(slug, collection);
    return collection;
  }
}
