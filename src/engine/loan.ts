import { parseEther } from 'viem';

import { basisPoints, percentOf } from './basisPoints';
import { cheapestListing, isLive } from './listing';
import type { OwnListing, OwnLoanOffer } from './market';
import type { LoanOfferTerms } from './task';

/** The grid loan principals are rounded down onto. */
export const PRINCIPAL_STEP = parseEther('0.01');

const SECONDS_PER_DAY = 86_400n;

export type LoanWaitReason = 'notListed' | 'insufficientBalance' | 'insufficientAllowance';

/**
 * What a loan offer lends: how much, at what APR in basis points, for how long, and the origination
 * fee taken from the principal as the loan starts.
 */
export type LoanTerms = { principal: bigint; aprBps: bigint; durationSeconds: bigint; fee: bigint };

/**
 * What to do with one item's loan offers this round. Every variant names the visible offers to
 * hide, which still lend until they expire: `offer` keeps the one already at the terms, `place`
 * signs a new one, and `wait` offers nothing.
 */
export type LoanDecision = { hide: OwnLoanOffer[] } & (
  | { type: 'offer'; keep: OwnLoanOffer }
  | { type: 'place'; terms: LoanTerms }
  | { type: 'wait'; reason: LoanWaitReason }
);

export type DecideLoanOfferInput = {
  terms: LoanOfferTerms;
  /**
   * The least the item can leave the wallet for: the listing's `minPrice`, which bounds both its
   * listings and a `bidExit` sale. The principal never exceeds it.
   */
  minPrice: bigint;
  /** The item's GONDI listings, live or not; none when the wallet no longer holds the item. */
  gondiListings: OwnListing[];
  /** The wallet's loan offers on the item, hidden ones included. */
  offers: OwnLoanOffer[];
  /** The wallet's WETH, and how much of it the loan contract may pull. */
  balance: bigint;
  allowance: bigint;
  /** How long before its expiration an offer is signed again: `refreshMarginMs`. */
  refreshMarginMs: number;
  now: Date;
};

/**
 * `principalPercent` of the listing price, at most `minPrice`, rounded down onto `PRINCIPAL_STEP`;
 * `null` at zero. The cap is what keeps a buyer from profiting off a default: an offer still lends
 * minutes after the item leaves the wallet, so whoever got it, for as little as `minPrice`, must
 * not be able to borrow more than that against it.
 */
export const loanPrincipal = (price: bigint, principalPercent: number, minPrice: bigint) => {
  const share = percentOf(price, principalPercent);
  const capped = share < minPrice ? share : minPrice;
  const stepped = capped - (capped % PRINCIPAL_STEP);
  return stepped > 0n ? stepped : null;
};

/** The offer's terms, for an item listed at `price`; `null` when the principal rounds to nothing. */
export const loanTerms = (
  terms: LoanOfferTerms,
  price: bigint,
  minPrice: bigint,
): LoanTerms | null => {
  const principal = loanPrincipal(price, terms.principalPercent, minPrice);
  return principal === null
    ? null
    : {
        principal,
        aprBps: basisPoints(terms.aprPercent),
        durationSeconds: BigInt(terms.durationDays) * SECONDS_PER_DAY,
        fee: percentOf(principal, terms.originationFeePercent),
      };
};

/**
 * Whether the offer lends on `terms`. The fee is left out: the API can nudge it by a wei as it
 * normalizes it, and it follows the principal, which is compared.
 */
const sameTerms = (offer: OwnLoanOffer, terms: LoanTerms) =>
  offer.principal === terms.principal &&
  offer.aprBps === terms.aprBps &&
  offer.durationSeconds === terms.durationSeconds;

/** Whether a loan offer still shows to buyers: not hidden from the API, and not expired. */
export const isVisibleLoanOffer = (offer: OwnLoanOffer, now: Date) =>
  !offer.hidden && offer.expiration.getTime() > now.getTime();

/**
 * Decides one item's loan offer, from its GONDI listing. Pure: the runner carries it out. The item
 * keeps one visible offer for a single loan at `loanTerms` of its cheapest live GONDI listing, the
 * principal capped at `minPrice`, so
 * a buyer can borrow that much of the price from the wallet to buy it: an offer already at those
 * terms that is not close to expiring stays, otherwise a new one is signed, which needs the WETH
 * and the allowance for its principal. Every other visible offer is hidden; with no live listing
 * (the item sold, moved, or waits), every one is, as nothing prices the loan. Hidden offers are
 * left as they are: they still lend until they expire, and hiding them again changes nothing.
 */
export const decideLoanOffer = ({
  terms,
  minPrice,
  gondiListings,
  offers,
  balance,
  allowance,
  refreshMarginMs,
  now,
}: DecideLoanOfferInput): LoanDecision => {
  const visible = offers.filter((offer) => isVisibleLoanOffer(offer, now));
  const wait = (reason: LoanWaitReason): LoanDecision => ({ type: 'wait', reason, hide: visible });
  const listing = cheapestListing(gondiListings.filter((candidate) => isLive(candidate, now)));
  const target = listing ? loanTerms(terms, listing.price, minPrice) : null;
  if (!target) return wait('notListed');
  const keep = visible
    .filter(
      (offer) =>
        sameTerms(offer, target) && offer.expiration.getTime() - now.getTime() > refreshMarginMs,
    )
    .sort((first, second) => second.expiration.getTime() - first.expiration.getTime())
    .at(0);
  if (keep) return { type: 'offer', keep, hide: visible.filter((offer) => offer !== keep) };
  if (balance < target.principal) return wait('insufficientBalance');
  if (allowance < target.principal) return wait('insufficientAllowance');
  return { type: 'place', terms: target, hide: visible };
};
