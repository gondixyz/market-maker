import type { Gondi } from 'gondi';
import {
  type Address,
  concat,
  encodeFunctionData,
  type Hash,
  hashStruct,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  zeroHash,
} from 'viem';
import { mainnet } from 'viem/chains';

import { percentOf } from '../engine/basisPoints';
import { withGasHeadroom } from '../engine/gas';
import type {
  BidScope,
  BidSnapshot,
  BidVenue,
  ExitOffer,
  ExitSale,
  ExitVenue,
  ListingScope,
  MirrorListing,
  MirrorVenue,
  OwnBid,
} from '../engine/market';
import type { GondiApi } from '../gondi/api';
import { WETH } from '../gondi/market';
import {
  type OfferFulfillment,
  type OpenSeaApi,
  type OpenSeaCollection,
  type OpenSeaConsiderationItem,
  type OpenSeaListing,
  type OpenSeaOffer,
  SEAPORT_PROTOCOL,
  type SignedOrder,
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

/**
 * The grid the bot prices OpenSea listings on, 0.0001 ETH. OpenSea documents no step for
 * listings; four decimals is the finest its listing form shows, and a mirror rounds up onto it.
 */
export const OPENSEA_LISTING_PRICE_STEP = 10n ** 14n;

const NATIVE_ITEM = 0;
const ERC20_ITEM = 1;
const ERC721_ITEM = 2;
/** Whether a Seaport item is WETH, paid as an ERC-20. */
const isWeth = (item: { itemType: number; token: Address }) =>
  item.itemType === ERC20_ITEM && isAddressEqual(item.token, WETH);
/** An ERC-721 item named by a criteria root, which a collection offer asks for. */
const ERC721_WITH_CRITERIA_ITEM = 4;
/** Seaport's `Side.CONSIDERATION`: a criteria resolver that names a consideration item. */
const CONSIDERATION_SIDE = 1;
const PARTIAL_RESTRICTED = 3;

const seaportAbi = parseAbi(['function getCounter(address offerer) view returns (uint256)']);
const erc721Abi = parseAbi(['function balanceOf(address owner) view returns (uint256)']);

/** Seaport 1.6's `fulfillAdvancedOrder` (https://github.com/ProjectOpenSea/seaport-types). */
const fulfillAdvancedOrderAbi = parseAbi([
  'struct OfferItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; }',
  'struct ConsiderationItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; address recipient; }',
  'struct OrderParameters { address offerer; address zone; OfferItem[] offer; ConsiderationItem[] consideration; uint8 orderType; uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 conduitKey; uint256 totalOriginalConsiderationItems; }',
  'struct AdvancedOrder { OrderParameters parameters; uint120 numerator; uint120 denominator; bytes signature; bytes extraData; }',
  'struct CriteriaResolver { uint256 orderIndex; uint8 side; uint256 index; uint256 identifier; bytes32[] criteriaProof; }',
  'function fulfillAdvancedOrder(AdvancedOrder advancedOrder, CriteriaResolver[] criteriaResolvers, bytes32 fulfillerConduitKey, address recipient) payable returns (bool fulfilled)',
]);

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

/** A Seaport order as EIP-712 signs and hashes it: every identifier a `uint256`. */
const orderComponents = (parameters: SignedOrder['parameters']) => ({
  ...parameters,
  offer: parameters.offer.map((item) => ({
    ...item,
    identifierOrCriteria: BigInt(item.identifierOrCriteria),
  })),
  consideration: parameters.consideration.map((item) => ({
    ...item,
    identifierOrCriteria: BigInt(item.identifierOrCriteria),
  })),
});

const ORDER_HASH_TYPES = { OrderHash: [{ name: 'orderHash', type: 'bytes32' }] } as const;

/** How many items the offer may buy in all: the amount of its first consideration item, the NFT. */
const quantityOf = (offer: OpenSeaOffer) =>
  offer.protocol_data.parameters.consideration[0].startAmount;

/** What the offer pays per item: its WETH amount over the items it may buy. */
const pricePerItem = (offer: OpenSeaOffer) =>
  offer.protocol_data.parameters.offer[0].startAmount / quantityOf(offer);

/** The WETH an order's consideration pays others than the offerer: its royalties and fees. */
const feesOf = (consideration: { itemType: number; token: Address; startAmount: bigint }[]) =>
  consideration.filter(isWeth).reduce((total, item) => total + item.startAmount, 0n);

/** What selling one item into the offer pays the seller: its price per item, fees taken out. */
const netPerItem = (offer: OpenSeaOffer) => {
  const { parameters } = offer.protocol_data;
  return (parameters.offer[0].startAmount - feesOf(parameters.consideration)) / quantityOf(offer);
};

/**
 * The best collection offer on the page that anyone but `account` makes in WETH, can still buy an
 * item and has not expired, by what it pays the seller; `null` when none.
 */
export const bestExitOffer = (
  offers: OpenSeaOffer[],
  account: Address,
  now: Date,
): ExitOffer | null => {
  const takeable = offers.filter(({ protocol_data: { parameters }, ...offer }) => {
    const [paid] = parameters.offer;
    return (
      offer.status === 'ACTIVE' &&
      offer.remaining_quantity > 0 &&
      parameters.endTime * 1_000 > now.getTime() &&
      !isAddressEqual(parameters.offerer, account) &&
      parameters.offer.length === 1 &&
      isWeth(paid)
    );
  });
  const best = takeable.reduce<OpenSeaOffer | undefined>(
    (current, offer) => (!current || netPerItem(offer) > netPerItem(current) ? offer : current),
    undefined,
  );
  return best ? { id: best.order_hash, venue: 'opensea', netPrice: netPerItem(best) } : null;
};

/**
 * What the fulfillment OpenSea built pays `account` for `tokenId` of `contract`, its royalties and
 * fees taken out, after checking it is the sale asked for: a call to Seaport with no ETH, paid to
 * the wallet, of one ERC-721 item of the collection, named by the one resolver of the order's
 * first consideration item, for WETH from someone else, asking nothing more than WETH fees, at
 * fixed amounts. Throws on anything else, so nothing OpenSea answers is signed unread.
 */
export const fulfillmentProceeds = (
  fulfillment: OfferFulfillment,
  { account, contract, tokenId }: { account: Address; contract: Address; tokenId: bigint },
) => {
  const { advancedOrder, criteriaResolvers, recipient } = fulfillment.input;
  const { parameters, numerator, denominator } = advancedOrder;
  const [paid] = parameters.offer;
  const [asked, ...fees] = parameters.consideration;
  const [resolver] = criteriaResolvers;
  const problems = [
    !isAddressEqual(fulfillment.to, SEAPORT_PROTOCOL) && `it calls ${fulfillment.to}, not Seaport`,
    fulfillment.value !== 0n && 'it sends ETH',
    !isAddressEqual(recipient, zeroAddress) &&
      !isAddressEqual(recipient, account) &&
      `it pays ${recipient}`,
    isAddressEqual(parameters.offerer, account) && 'the offer is the wallet’s own',
    (parameters.offer.length !== 1 || !isWeth(paid)) && 'the offer does not pay in WETH alone',
    (asked?.itemType !== ERC721_WITH_CRITERIA_ITEM ||
      !isAddressEqual(asked.token, contract) ||
      !isAddressEqual(asked.recipient, parameters.offerer)) &&
      'the offer does not ask for an item of the collection',
    !fees.every(isWeth) && 'the offer asks for more than the item and WETH fees',
    [...parameters.offer, ...parameters.consideration].some(
      (item) => item.startAmount !== item.endAmount,
    ) && 'the offer’s amounts change over time',
    (criteriaResolvers.length !== 1 ||
      resolver.orderIndex !== 0n ||
      resolver.side !== CONSIDERATION_SIDE ||
      resolver.index !== 0n ||
      resolver.identifier !== tokenId) &&
      `the sale does not name item ${tokenId}`,
    (denominator === 0n || numerator * (asked?.startAmount ?? 0n) !== denominator) &&
      'the sale is not of one item',
  ].filter((problem) => typeof problem === 'string');
  if (problems.length > 0) throw new Error(`refused OpenSea's sale: ${problems.join('; ')}`);
  return ((paid.startAmount - feesOf(fees)) * numerator) / denominator;
};

/** Seaport's `fulfillAdvancedOrder` call for `fulfillment`, with OpenSea's suffix appended. */
const fulfillmentCalldata = (fulfillment: OfferFulfillment) => {
  const { advancedOrder, criteriaResolvers, fulfillerConduitKey, recipient } = fulfillment.input;
  const data = encodeFunctionData({
    abi: fulfillAdvancedOrderAbi,
    functionName: 'fulfillAdvancedOrder',
    args: [advancedOrder, criteriaResolvers, fulfillerConduitKey, recipient],
  });
  return fulfillment.calldataSuffix ? concat([data, fulfillment.calldataSuffix]) : data;
};

/** The contract a fulfiller's conduit key lets move its item: Seaport itself, or OpenSea's conduit. */
const fulfillerOperator = (conduitKey: Hash) => {
  if (conduitKey === zeroHash) return SEAPORT_PROTOCOL;
  if (conduitKey.toLowerCase() === OPENSEA_CONDUIT_KEY.toLowerCase()) return OPENSEA_CONDUIT;
  throw new Error(`OpenSea would move the item through the unknown conduit key ${conduitKey}`);
};

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

/**
 * A listing of the wallet's own as a mirror, with its order hash as its id; `null` for one that is
 * not of one ERC-721 item of `contract` for ETH alone, or that OpenSea cannot cancel off-chain,
 * which the bot leaves alone. Its price is what a buyer pays: every consideration item's ETH.
 */
const toMirrorListing = (listing: OpenSeaListing, contract: Address): MirrorListing | null => {
  const { offer, consideration, zone, startTime, endTime } = listing.protocol_data.parameters;
  const [item] = offer;
  const isMirror =
    offer.length === 1 &&
    item.itemType === ERC721_ITEM &&
    isAddressEqual(item.token, contract) &&
    consideration.every((entry) => entry.itemType === NATIVE_ITEM) &&
    isAddressEqual(zone, OPENSEA_SIGNED_ZONE);
  if (!isMirror) return null;
  return {
    id: listing.order_hash,
    tokenId: BigInt(item.identifierOrCriteria),
    price: consideration.reduce((total, entry) => total + entry.startAmount, 0n),
    expiration: new Date(endTime * 1_000),
    cancellableFrom: cancellableFrom(new Date(startTime * 1_000)),
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
 * The fees an order of `quantity` items at `price` each must pay, as consideration items in WETH
 * (an offer) or ETH (a listing): each of the collection's required fees, floored per item so the
 * order splits evenly when it fills partly.
 */
export const requiredFees = (
  collection: OpenSeaCollection,
  price: bigint,
  quantity: number,
  currency: 'weth' | 'eth' = 'weth',
): OpenSeaConsiderationItem[] =>
  collection.fees
    .filter((fee) => fee.required)
    .map((fee) => {
      const total = percentOf(price, fee.fee) * BigInt(quantity);
      return {
        itemType: currency === 'weth' ? ERC20_ITEM : NATIVE_ITEM,
        token: currency === 'weth' ? WETH : zeroAddress,
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
 * The orders a run posted that OpenSea may not list yet, by collection slug: OpenSea lists a new
 * order only some seconds after accepting it, so each counts among the wallet's own until a read
 * shows it, it is cancelled, or `LISTING_DELAY_MS` passes.
 */
class UnlistedOrders<Order extends { id: string; placedAt: Date }> {
  private readonly bySlug = new Map<string, Order[]>();

  /** Tracks `order`, just posted on `slug`. */
  add(slug: string, order: Order) {
    this.bySlug.set(slug, [...(this.bySlug.get(slug) ?? []), order]);
  }

  /** Stops tracking the order `id`, whichever slug it was posted on. */
  forget(id: string) {
    for (const [slug, orders] of this.bySlug) {
      this.bySlug.set(
        slug,
        orders.filter((order) => order.id !== id),
      );
    }
  }

  /**
   * The orders posted on `slug` that `listed` does not show yet and that OpenSea has not had
   * `LISTING_DELAY_MS` to list by `now`; the rest are forgotten.
   */
  stillUnlisted(slug: string, listed: { id: string }[], now: Date) {
    const remaining = (this.bySlug.get(slug) ?? []).filter(
      (order) =>
        now.getTime() - order.placedAt.getTime() < LISTING_DELAY_MS &&
        !listed.some((listedOrder) => listedOrder.id === order.id),
    );
    this.bySlug.set(slug, remaining);
    return remaining;
  }
}

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
export class OpenSeaMarket implements BidVenue, ExitVenue, MirrorVenue {
  readonly priceStep = OPENSEA_LISTING_PRICE_STEP;
  private readonly collections = new Map<string, OpenSeaCollection>();
  private readonly contracts = new Map<string, Address>();
  /** The offers this run posted that OpenSea may not list yet. */
  private readonly unlistedOffers = new UnlistedOrders<OwnBid>();
  /** The listings this run posted that OpenSea may not list yet. */
  private readonly unlistedMirrors = new UnlistedOrders<MirrorListing & { placedAt: Date }>();

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
      ownBids: [...listed, ...this.unlistedOffers.stillUnlisted(scope.slug, listed, this.now())],
      held: Number(held),
      balance,
      allowance,
    };
  }

  async placeBid({ scope, price, quantity, expiration }: Parameters<BidVenue['placeBid']>[0]) {
    const [collection, built, counter] = await Promise.all([
      this.collection(scope.slug),
      this.openSea.buildOffer({ slug: scope.slug, offerer: this.account, quantity }),
      this.seaportCounter(),
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
    const signature = await this.signOrder(parameters);
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
    this.unlistedOffers.add(scope.slug, placed);
    return placed;
  }

  async cancelBids(bids: OwnBid[]) {
    const onChainOnly = bids.filter((bid) => !bid.cancelsOffChain);
    if (onChainOnly.length > 0) {
      throw new Error(
        `offers ${onChainOnly.map((bid) => bid.id).join(', ')} can only be cancelled on-chain`,
      );
    }
    await this.cancelOrders(
      bids.map((bid) => bid.id),
      this.unlistedOffers,
    );
  }

  async exitOffer(slug: string) {
    return bestExitOffer(await this.openSea.collectionOffers(slug), this.account, this.now());
  }

  async gasPrice() {
    return this.gondi.bcClient.getGasPrice();
  }

  /**
   * Builds the sale with OpenSea, checks it (`fulfillmentProceeds`), and sends it only when what it
   * pays, less the most its gas limit and fee cap can spend, is at least `minProceeds`, and the
   * wallet has let the operator its conduit key names move the collection's items.
   *
   * IMPLEMENTATION NOTE: the call is encoded from OpenSea's decoded `input_data` with Seaport's
   * ABI, then OpenSea's `calldata_suffix` is appended, as `fulfillOrder` in opensea-js's
   * `src/sdk/fulfillment.ts` does (https://github.com/ProjectOpenSea/opensea-js). The fulfiller's
   * item moves through the conduit `fulfillerConduitKey` names, or Seaport itself for the zero
   * key (https://github.com/ProjectOpenSea/seaport/blob/main/docs/SeaportDocumentation.md), so
   * that is the operator the wallet must have approved. viem's `estimateGas`, `sendTransaction`
   * and `waitForTransactionReceipt` (https://viem.sh/docs/actions/public/estimateGas) price, send
   * and wait for it.
   */
  async sellToOffer({ scope, offer, minProceeds }: ExitSale) {
    const contract = await this.contractOf(scope.slug);
    const fulfillment = await this.openSea.offerFulfillment({
      orderHash: offer.id as Hash,
      fulfiller: this.account,
      contract,
      tokenId: scope.tokenId,
    });
    const net = fulfillmentProceeds(fulfillment, {
      account: this.account,
      contract,
      tokenId: scope.tokenId,
    });
    const operator = fulfillerOperator(fulfillment.input.fulfillerConduitKey);
    const approved = await this.gondi.isApprovedNFTForAll({
      nftAddress: contract,
      standard: 'ERC721',
      to: operator,
    });
    if (!approved) {
      throw new Error(
        `${operator} may not move ${scope.slug} items: run market-maker approve-nft ${scope.slug} opensea`,
      );
    }
    const data = fulfillmentCalldata(fulfillment);
    const [estimate, gasPrice] = await Promise.all([
      this.gondi.bcClient.estimateGas({ account: this.account, to: fulfillment.to, data }),
      this.gondi.bcClient.getGasPrice(),
    ]);
    const gas = withGasHeadroom(estimate);
    const maxFeePerGas = withGasHeadroom(gasPrice);
    const proceeds = net - gas * maxFeePerGas;
    if (proceeds < minProceeds) {
      throw new Error(
        `the sale would pay ${proceeds} wei after gas, under the ${minProceeds} wei it needs`,
      );
    }
    const hash = await this.gondi.wallet.sendTransaction({
      account: this.gondi.account,
      chain: this.gondi.wallet.chain,
      to: fulfillment.to,
      data,
      gas,
      maxFeePerGas,
    });
    const receipt = await this.gondi.bcClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`selling into the offer reverted in ${hash}`);
  }

  /**
   * The wallet's OpenSea listings of the collection's items that the bot can mirror with (see
   * `toMirrorListing`), with the ones this run posted that OpenSea does not show yet.
   */
  async mirrorListings(slug: string) {
    const contract = await this.contractOf(slug);
    const listed = (await this.openSea.ownListings(slug, this.account))
      .map((listing) => toMirrorListing(listing, contract))
      .filter((listing) => listing !== null);
    return [...listed, ...this.unlistedMirrors.stillUnlisted(slug, listed, this.now())];
  }

  /**
   * Lists the item on OpenSea for `price` in ETH, which the buyer pays: the wallet receives it less
   * the collection's required fees, each paid to its recipient. Throws, listing nothing, while
   * OpenSea's conduit may not move the collection's items.
   *
   * IMPLEMENTATION NOTE: built the way `opensea-js` builds a listing (`createListing` in
   * `src/sdk/orders.ts`, https://github.com/ProjectOpenSea/opensea-js): the order offers the one
   * ERC-721 item and asks for ETH (item type 0, the zero address) to the wallet and to each
   * required fee of `collections/{slug}`, through OpenSea's conduit, restricted to the SignedZone so
   * it cancels off-chain like an offer, with a zero zone hash and the wallet's Seaport counter.
   * Seaport moves the item through that conduit, so the wallet must have approved it for the
   * collection (`approve-nft <slug> opensea`). The order hash is Seaport's: the EIP-712 struct hash
   * of its `OrderComponents` (`getOrderHash` in https://github.com/ProjectOpenSea/seaport-js,
   * computed with viem's `hashStruct`, https://viem.sh/docs/utilities/hashTypedData).
   */
  async placeMirrorListing({
    scope,
    price,
    expiration,
  }: {
    scope: ListingScope;
    price: bigint;
    expiration: Date;
  }) {
    const contract = await this.contractOf(scope.slug);
    const [collection, counter, approved] = await Promise.all([
      this.terms(scope.slug),
      this.seaportCounter(),
      this.gondi.isApprovedNFTForAll({
        nftAddress: contract,
        standard: 'ERC721',
        to: OPENSEA_CONDUIT,
      }),
    ]);
    if (!approved) {
      throw new Error(
        `OpenSea's conduit may not move ${scope.slug} items: run market-maker approve-nft ${scope.slug} opensea`,
      );
    }
    const fees = requiredFees(collection, price, 1, 'eth');
    const proceeds = price - fees.reduce((total, fee) => total + fee.startAmount, 0n);
    const startTime = Math.floor(this.now().getTime() / 1_000);
    const parameters: SignedOrder['parameters'] = {
      offerer: this.account,
      zone: OPENSEA_SIGNED_ZONE,
      offer: [
        {
          itemType: ERC721_ITEM,
          token: contract,
          identifierOrCriteria: scope.tokenId.toString(),
          startAmount: 1n,
          endAmount: 1n,
        },
      ],
      consideration: [
        {
          itemType: NATIVE_ITEM,
          token: zeroAddress,
          identifierOrCriteria: '0',
          startAmount: proceeds,
          endAmount: proceeds,
          recipient: this.account,
        },
        ...fees,
      ],
      orderType: PARTIAL_RESTRICTED,
      startTime: BigInt(startTime),
      endTime: BigInt(Math.floor(expiration.getTime() / 1_000)),
      zoneHash: zeroHash,
      salt: randomSalt(),
      conduitKey: OPENSEA_CONDUIT_KEY,
      counter,
    };
    const signature = await this.signOrder(parameters);
    await this.openSea.postListing({ parameters, signature });
    const placedAt = new Date(startTime * 1_000);
    const placed = {
      id: hashStruct({
        data: orderComponents(parameters),
        primaryType: 'OrderComponents',
        types: ORDER_TYPES,
      }),
      tokenId: scope.tokenId,
      price,
      expiration,
      cancellableFrom: cancellableFrom(placedAt),
    };
    this.unlistedMirrors.add(scope.slug, { ...placed, placedAt });
    return placed;
  }

  /** Cancels each listing off-chain; OpenSea refuses one placed under five minutes before. */
  async cancelMirrorListings(listings: MirrorListing[]) {
    await this.cancelOrders(
      listings.map((listing) => listing.id),
      this.unlistedMirrors,
    );
  }

  /** The collection's contract, read once a run. */
  private async contractOf(slug: string) {
    const cached = this.contracts.get(slug);
    if (cached) return cached;
    const { contractAddress } = await this.gondiApi.collectionMarket({ slug });
    this.contracts.set(slug, contractAddress);
    return contractAddress;
  }

  /** The wallet's Seaport counter, which every order it signs carries. */
  private async seaportCounter() {
    return this.gondi.bcClient.readContract({
      address: SEAPORT_PROTOCOL,
      abi: seaportAbi,
      functionName: 'getCounter',
      args: [this.account],
    });
  }

  /** The collection's OpenSea terms, read once a run: its fees change rarely, and reads are rationed. */
  private async terms(slug: string) {
    const cached = this.collections.get(slug);
    if (cached) return cached;
    const collection = await this.openSea.collection(slug);
    this.collections.set(slug, collection);
    return collection;
  }

  /** The collection's terms, for an offer: throws when OpenSea takes no collection offers on it. */
  private async collection(slug: string) {
    const collection = await this.terms(slug);
    if (!collection.collection_offers_enabled) {
      throw new Error(`OpenSea takes no collection offers on ${slug}`);
    }
    return collection;
  }

  /** The wallet's signature of `parameters` as Seaport 1.6's EIP-712 `OrderComponents`. */
  private async signOrder(parameters: SignedOrder['parameters']) {
    return this.gondi.wallet.signTypedData({
      account: this.gondi.account,
      domain: SEAPORT_DOMAIN,
      types: ORDER_TYPES,
      primaryType: 'OrderComponents',
      message: orderComponents(parameters),
    });
  }

  /** Cancels each order off-chain, one at a time, and stops tracking it in `tracked`. */
  private async cancelOrders(
    ids: string[],
    tracked: UnlistedOrders<{ id: string; placedAt: Date }>,
  ) {
    for (const id of ids) {
      await this.cancelOrder(id as Hash);
      tracked.forget(id);
    }
  }

  /** Cancels the order `orderHash`, an offer or a listing, off-chain, with the wallet's signature. */
  private async cancelOrder(orderHash: Hash) {
    const signature = await this.gondi.wallet.signTypedData({
      account: this.gondi.account,
      domain: SEAPORT_DOMAIN,
      types: ORDER_HASH_TYPES,
      primaryType: 'OrderHash',
      message: { orderHash },
    });
    await this.openSea.cancelOrder(orderHash, signature);
  }
}
