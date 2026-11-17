import { basisPoints, BPS } from './basisPoints';
import { cheapestListing, isLive } from './listing';
import type { MirrorListing, OwnListing } from './market';

/**
 * What to do with one item's OpenSea listings this round: list it at `place` (none when `null`),
 * and cancel `cancel`, every one of which the venue takes an off-chain cancel of now.
 */
export type MirrorDecision = { place: bigint | null; cancel: MirrorListing[] };

export type DecideMirrorInput = {
  markupPercent: number;
  /** The item's GONDI listings, live or not; none when the wallet no longer holds the item. */
  gondiListings: OwnListing[];
  /** The item's listings on the mirror venue. */
  mirrors: MirrorListing[];
  /** The grid the venue prices listings on; the mirror price rounds up onto it. */
  priceStep: bigint;
  /** How long before its expiration a mirror is placed again: `refreshMarginMs`. */
  refreshMarginMs: number;
  now: Date;
};

/** `price` raised by `markupPercent`, rounded up onto `priceStep`, so it never undercuts GONDI. */
export const mirrorPrice = (price: bigint, markupPercent: number, priceStep: bigint) => {
  const raised = (price * (BPS + basisPoints(markupPercent)) + BPS - 1n) / BPS;
  return ((raised + priceStep - 1n) / priceStep) * priceStep;
};

const isCancellable = (mirror: MirrorListing, now: Date) =>
  !mirror.cancellableFrom || mirror.cancellableFrom.getTime() <= now.getTime();

/**
 * Decides one item's OpenSea listing, from its GONDI listing. Pure: the runner carries it out. The
 * item is listed at `mirrorPrice` of its cheapest live GONDI listing, so a buyer always finds it
 * cheaper on GONDI. A live mirror at that price that is not close to expiring stays; otherwise a
 * new one is placed. Every other live mirror is cancelled once the venue takes it off-chain, and
 * left up until then: a cheaper stale one still sells above GONDI's price, and a dearer one never
 * sells first. With no live GONDI listing (the item sold, moved, or is waiting), every live mirror
 * is cancelled, as nothing prices it.
 */
export const decideMirror = ({
  markupPercent,
  gondiListings,
  mirrors,
  priceStep,
  refreshMarginMs,
  now,
}: DecideMirrorInput): MirrorDecision => {
  const live = mirrors.filter((mirror) => mirror.expiration.getTime() > now.getTime());
  const gondi = cheapestListing(gondiListings.filter((listing) => isLive(listing, now)));
  const price = gondi ? mirrorPrice(gondi.price, markupPercent, priceStep) : null;
  const kept = live.find(
    (mirror) =>
      mirror.price === price && mirror.expiration.getTime() - now.getTime() > refreshMarginMs,
  );
  return {
    place: kept ? null : price,
    cancel: live.filter((mirror) => mirror !== kept && isCancellable(mirror, now)),
  };
};
