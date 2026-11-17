import { formatEther, parseEther } from 'viem';
import { z } from 'zod';

import { VENUES } from './market';

/** The most tasks one file runs: room for a bid and a listing on each of 25 collections. */
export const MAX_TASKS = 50;

/** The most offers one bid task's `ladder` keeps live. */
export const MAX_LADDER_OFFERS = 10;

/**
 * The shortest and default lifetime of a listing. A listing the bot replaced stays live until it
 * expires, so a short lifetime is what keeps replaced listings from piling up.
 */
export const LISTING_EXPIRATION_MINUTES = 5;

/**
 * The shortest lifetime of a bid. Less the two-minute refresh margin it still outlasts OpenSea's
 * off-chain cancel delay (5.5 minutes), so an offer becomes cancellable, and is refreshed, before
 * it expires. A short lifetime limits how long bids outlive a bot that stopped.
 */
export const MIN_BID_EXPIRATION_MINUTES = 10;

/** The default lifetime of a bid. Bids are cancelled off-chain, so a long one leaves nothing up. */
export const BID_EXPIRATION_MINUTES = 60;

/**
 * The shortest and default lifetime of a loan offer. An offer cancels only on-chain, so a hidden
 * one still lends until it expires: a short lifetime bounds how long an offer outlives the item
 * leaving the wallet, when whoever holds it next could borrow against it.
 */
export const LOAN_OFFER_EXPIRATION_MINUTES = 10;

/**
 * The loan durations, in days, GONDI takes besides multiples of 30: its API refuses an offer for
 * any other (`allowed_duration_days` in its prod config).
 */
export const LOAN_DURATION_DAYS = [3, 5, 7, 10, 15, 20, 45];

const ether = z
  .string()
  .regex(/^\d+(\.\d{1,18})?$/, 'expected an ETH amount such as "1.25"')
  .transform((amount) => parseEther(amount));

/**
 * Reads an ETH amount above zero, such as an approval's, where zero would revoke the allowance
 * instead of granting one; throws on anything else, negative amounts included.
 */
export const parsePositiveEther = (amount: string): bigint => {
  const wei = ether.safeParse(amount);
  if (!wei.success || wei.data <= 0n)
    throw new Error('expected a positive ETH amount such as "1.5"');
  return wei.data;
};

/**
 * A plain union rather than a discriminated one: the two `floor` shapes share their `mode`, as do
 * the two `outbid` ones, and each refuses the other's field so a rule that sets both is rejected
 * instead of half ignored.
 */
const pricingRule = z.union([
  /** Always the same price. */
  z.object({ mode: z.literal('fixed'), price: ether }),
  /** A share of the floor, e.g. 90 bids at 90% of the cheapest listing. */
  z.object({
    mode: z.literal('floor'),
    percent: z.number().positive().max(100),
    steps: z.never().optional(),
  }),
  /** `steps` price steps under the floor, e.g. 1 bids the highest price still below it. */
  z.object({
    mode: z.literal('floor'),
    steps: z.number().int().positive(),
    percent: z.never().optional(),
  }),
  /** The best competing bid plus `steps` price steps; `minPrice` when nobody else bids. */
  z.object({
    mode: z.literal('outbid'),
    steps: z.number().int().positive().default(1),
    percent: z.never().optional(),
  }),
  /**
   * The best competing bid plus `percent` of it, rounded up onto the price step and at least one
   * step above it; `minPrice` when nobody else bids.
   */
  z.object({
    mode: z.literal('outbid'),
    percent: z.number().positive().max(100),
    steps: z.never().optional(),
  }),
  /**
   * The `level`-th best competing price level, e.g. 5 joins the fifth highest price anyone else
   * bids. No price with fewer levels.
   */
  z.object({ mode: z.literal('level'), level: z.number().int().positive().max(100) }),
]);

const listingPricingRule = z.discriminatedUnion('mode', [
  /** Always the same price. */
  z.object({ mode: z.literal('fixed'), price: ether }),
  /** A share of the cheapest competing listing, e.g. 105 lists 5% above it. */
  z.object({ mode: z.literal('floor'), percent: z.number().positive().max(1_000) }),
  /**
   * The cheapest competing listing minus `amount` ETH; `maxPrice` when nothing else is listed.
   * GONDI listings are not price-stepped, so the amount is the seller's own, not a count of the
   * collection's bid steps; a file still counting `steps` is refused rather than guessed at.
   */
  z.object({
    mode: z.literal('undercut'),
    amount: z
      .string({ error: 'expected an amount in ETH such as "0.0001"' })
      .pipe(ether)
      .refine((amount) => amount > 0n, 'must be above 0'),
    steps: z.never({ error: 'undercut now takes an amount in ETH, not steps' }).optional(),
  }),
]);

const tokenId = z
  .string()
  .regex(/^\d+$/, 'expected a token id such as "3950"')
  .transform((value) => BigInt(value));

const taskFields = {
  id: z.string().min(1),
  /** A disabled task stays in the file but does not run: it places nothing and stays `halted`. */
  enabled: z.boolean().default(true),
  /** The collection's slug, as in its GONDI or OpenSea URL. */
  collection: z.string().min(1),
  minPrice: ether,
  maxPrice: ether,
};

/**
 * What every bid kind takes. Its floor and items held are those of what it can fill with: the
 * collection for a collection bid, the items with the trait for a trait bid. A trait bid competes
 * with the bids on its trait and the collection bids, either of which a seller could take.
 */
const bidFields = {
  ...taskFields,
  expirationMinutes: z
    .number()
    .int()
    .min(MIN_BID_EXPIRATION_MINUTES)
    .default(BID_EXPIRATION_MINUTES),
  pricing: pricingRule,
  haltOnFloorMovePercent: z.number().positive().optional(),
  /** The bid never goes above this share of the floor, and does not bid without a floor. */
  maxFloorPercent: z.number().positive().max(100).optional(),
  /** The venue the bid is posted on: GONDI's own order book, or OpenSea as an offer. */
  venue: z.enum(VENUES).default('gondi'),
  quantity: z.number().int().positive().default(1),
  /**
   * Keep bidding after a fill while the wallet holds fewer than this many items the bid can fill
   * with; without it the task halts once it has bought `quantity` items.
   */
  maxItems: z.number().int().positive().optional(),
  /**
   * Keep bidding after a fill while the items the wallet holds that the bid can fill with, valued
   * at the floor, plus the live bid stay within this many ETH.
   */
  maxHeldValue: ether.optional(),
  /**
   * Keep `offers` offers live instead of one: the top one at the `pricing` price, the others on
   * the next multiples of `spacing` ETH below it, none under `minPrice`. They share the top
   * offer's WETH, so `exposureLimit` counts the task as its top offer alone.
   */
  ladder: z
    .object({
      offers: z.number().int().positive().max(MAX_LADDER_OFFERS),
      spacing: ether.refine((spacing) => spacing > 0n, 'spacing must be above zero'),
    })
    .optional(),
  /**
   * While the task would wait on `maxItems`, `maxHeldValue` or `exposureLimit`, keep one offer for
   * one item up instead, priced `marginPercent` under what the collection's `bidExit` would sell
   * the item for at once: the best other wallet's collection bid, its fees and the sale's gas taken
   * out. It counts against the file's `resaleLimit` rather than `exposureLimit`. Off when omitted;
   * see `resalePrice`.
   */
  resaleBid: z.object({ marginPercent: z.number().positive().max(100).default(2) }).optional(),
};

const task = z
  .discriminatedUnion('kind', [
    /** A bid any item of the collection can fill. */
    z.object({ ...bidFields, kind: z.literal('collectionBid') }),
    /** A bid any item of the collection with one trait can fill, priced against that trait's floor. */
    z.object({
      ...bidFields,
      kind: z.literal('traitBid'),
      /** The trait as the collection's metadata names it, matched exactly. */
      trait: z.object({ type: z.string().min(1), value: z.string().min(1) }),
    }),
    /**
     * A listing of one item the wallet owns or, without `tokenId`, of every item of the collection
     * it holds, each listed on its own; `minPrice` and `maxPrice` bound what it asks.
     */
    z.object({
      ...taskFields,
      kind: z.literal('listing'),
      /** Above zero: a rule that prices under it lists at it, and a 0 ETH listing gives the item away. */
      minPrice: ether.refine((wei) => wei > 0n, 'must be above 0'),
      expirationMinutes: z
        .number()
        .int()
        .min(LISTING_EXPIRATION_MINUTES)
        .default(LISTING_EXPIRATION_MINUTES),
      tokenId: tokenId.optional(),
      pricing: listingPricingRule,
      /**
       * Lower the price `percent` of the `pricing` price every `everyHours` the bot has been
       * listing the item, down to `minPrice`. The clock is the run's, in memory: it starts when
       * the run first finds the item held, so a restart lists at the full price again. Off when
       * omitted; see `decayedListingPrice`.
       */
      decay: z
        .object({
          percent: z.number().positive().max(100),
          everyHours: z.number().positive(),
        })
        .optional(),
      /**
       * Also sell a held item into the collection bid of another wallet that pays most, on GONDI or
       * on OpenSea, with a transaction, when that pays at least what the item cost, or, once it has been held `afterHours`, loses at most
       * `maxLossPercent` of it. Off when omitted; see `decideExit`.
       */
      bidExit: z
        .object({
          afterHours: z.number().nonnegative().default(6),
          maxLossPercent: z.number().nonnegative().max(100).default(1),
          /** The most sales the task tries this way in a UTC day, failed ones included. */
          maxPerDay: z.number().int().positive().default(2),
          /** No sale while gas costs more than this, in gwei. */
          maxGasGwei: z.number().positive().default(30),
        })
        .optional(),
      /**
       * Also list each held item on OpenSea, `markupPercent` above its GONDI listing, so GONDI stays
       * the cheaper place to buy it. Signed and cancelled off-chain, with the run's OpenSea key; the
       * OpenSea listing follows the GONDI one and is cancelled once the item is gone. Off when
       * omitted; see `decideMirror`. It lasts `expirationMinutes`, longer than a GONDI listing by
       * default: cancelled off-chain whenever the GONDI price moves, it needs no short life, and a
       * long one spares signing it again every few minutes.
       */
      openSeaListing: z
        .object({
          markupPercent: z.number().positive().max(100).default(3),
          expirationMinutes: z.number().int().min(15).default(60),
        })
        .optional(),
      /**
       * Also offer a loan against each listed item, `principalPercent` of its GONDI listing price,
       * so a buyer can buy it now and pay later: the loan pays most of the price, the buyer the
       * rest, and a default returns the item to the wallet. One single-loan offer per item, signed
       * off-chain with WETH; it is hidden once the item is no longer listed, and lends until it
       * expires. Off when omitted; see `decideLoanOffer`.
       */
      loanOffer: z
        .object({
          principalPercent: z.number().positive().max(100).default(90),
          aprPercent: z.number().positive().max(1_000).default(1),
          /** Charged up front, as a share of the principal: the borrower receives the rest. */
          originationFeePercent: z.number().nonnegative().max(10).default(0.25),
          durationDays: z
            .number()
            .int()
            .refine(
              (days) => LOAN_DURATION_DAYS.includes(days) || (days > 0 && days % 30 === 0),
              `must be one of ${LOAN_DURATION_DAYS.join(', ')} or a multiple of 30`,
            )
            .default(3),
          expirationMinutes: z
            .number()
            .int()
            .min(LOAN_OFFER_EXPIRATION_MINUTES)
            .default(LOAN_OFFER_EXPIRATION_MINUTES),
        })
        .optional(),
    }),
  ])
  .refine((task) => task.minPrice <= task.maxPrice, 'minPrice must not exceed maxPrice')
  .refine((task) => task.kind !== 'listing' || !task.bidExit || task.tokenId === undefined, {
    message: 'bidExit sells from the inventory, so it takes a listing without tokenId',
    path: ['bidExit'],
  })
  .refine((task) => task.kind !== 'listing' || !task.openSeaListing || task.tokenId === undefined, {
    message: 'openSeaListing lists the inventory, so it takes a listing without tokenId',
    path: ['openSeaListing'],
  })
  .refine((task) => task.kind !== 'listing' || !task.loanOffer || task.tokenId === undefined, {
    message: 'loanOffer lends against the inventory, so it takes a listing without tokenId',
    path: ['loanOffer'],
  })
  .refine((task) => task.kind !== 'traitBid' || task.venue === 'gondi', {
    message: 'trait bids are posted on GONDI only for now',
    path: ['venue'],
  })
  .refine(
    (task) => task.kind === 'listing' || task.venue !== 'opensea' || task.maxItems !== undefined,
    {
      message:
        'an OpenSea bid needs maxItems: a filled offer leaves its reads, so only the items held stop it',
      path: ['maxItems'],
    },
  );

/** Stop bidding once the loss over the UTC day or the ISO week reaches these many USD. */
const lossLimits = z.object({
  dailyUsd: z.number().positive(),
  weeklyUsd: z.number().positive(),
  /** Where the ledger starts: fills before it never count. */
  since: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
});

const tasksFile = z
  .object({
    version: z.literal(1),
    /** The most the wallet's live bids may commit at once, across every task. */
    exposureLimit: ether,
    pollSeconds: z.number().int().min(5).default(15),
    lossLimits: lossLimits.optional(),
    /**
     * The most the bid tasks' `resaleBid` offers may commit at once, apart from `exposureLimit`.
     * Each one's item is sold again at once, so this caps what one round of fills could leave held.
     */
    resaleLimit: ether.optional(),
    /**
     * Wrap ETH into WETH each round the wallet's WETH is under `exposureLimit`, keeping `keepEth`
     * ETH for gas, so a listing that sells for ETH funds the bids again. Off when omitted. A
     * `keepEth` of zero would wrap the whole balance and leave the wrap itself no gas.
     */
    wrapEth: z
      .object({
        keepEth: ether.refine(
          (wei) => wei > 0n,
          'keepEth is the ETH kept for gas, so it must be above 0, such as "0.05"',
        ),
      })
      .optional(),
    tasks: z.array(task).max(MAX_TASKS),
  })
  .refine(
    (file) => new Set(file.tasks.map((task) => task.id)).size === file.tasks.length,
    'task ids must be unique',
  )
  .refine((file) => file.lossLimits !== undefined || !exitsIntoBids(file), {
    message: 'bidExit needs lossLimits: what an item cost is read from the fills it measures',
    path: ['lossLimits'],
  })
  .refine((file) => file.resaleLimit !== undefined || !resellsFills(file), {
    message: 'resaleBid needs resaleLimit: its offers do not count against exposureLimit',
    path: ['resaleLimit'],
  })
  .refine(
    (file) =>
      file.tasks.every(
        (task) =>
          task.kind === 'listing' ||
          !task.enabled ||
          !task.resaleBid ||
          resaleExitOf(file, task.collection) !== undefined,
      ),
    {
      message:
        'resaleBid sells what it buys through bidExit, so it needs a listing with bidExit on its collection',
      path: ['tasks'],
    },
  );

export type PricingRule = z.output<typeof pricingRule>;
export type ListingPricingRule = z.output<typeof listingPricingRule>;
export type Task = z.output<typeof task>;
export type BidTask = Exclude<Task, { kind: 'listing' }>;
export type ListingTask = Extract<Task, { kind: 'listing' }>;
export type BidExit = NonNullable<ListingTask['bidExit']>;
export type LoanOfferTerms = NonNullable<ListingTask['loanOffer']>;
export type LossLimits = z.output<typeof lossLimits>;
export type TasksFile = z.output<typeof tasksFile>;

/**
 * Parses a tasks file into typed tasks with amounts in wei. Throws on any invalid task, so a file
 * is either run whole or not at all.
 */
export const parseTasksFile = (raw: unknown): TasksFile => tasksFile.parse(raw);

/** Whether any of the file's enabled listing tasks sells held items into other wallets' bids. */
export function exitsIntoBids({ tasks }: { tasks: Task[] }) {
  return tasks.some((task) => task.enabled && task.kind === 'listing' && task.bidExit);
}

/** Whether any of the file's enabled bid tasks keeps a `resaleBid`. */
const resellsFills = ({ tasks }: { tasks: Task[] }) =>
  tasks.some((task) => task.enabled && task.kind !== 'listing' && task.resaleBid);

/** The enabled listing task with `bidExit` that sells what a `resaleBid` on `slug` buys. */
export const resaleExitOf = ({ tasks }: { tasks: Task[] }, slug: string) =>
  tasks.find(
    (task): task is ListingTask =>
      task.enabled && task.kind === 'listing' && task.collection === slug && !!task.bidExit,
  );

/** Whether any of the file's enabled bid tasks bids on OpenSea. */
export const bidsOnOpenSea = ({ tasks }: TasksFile) =>
  tasks.some((task) => task.enabled && task.kind !== 'listing' && task.venue === 'opensea');

/**
 * The listings that could sell for no more than a bid on the same collection may pay: a bot that
 * buys at the bid's `maxPrice` and sells at the listing's `minPrice` would make nothing, or lose
 * the royalties and fees. A warning, not an error: holding items bought elsewhere is a reason to.
 */
export const marginWarnings = ({ tasks }: TasksFile) =>
  tasks.flatMap((listing) =>
    listing.kind !== 'listing'
      ? []
      : tasks
          .filter((bid) => bid.kind !== 'listing' && bid.collection === listing.collection)
          .filter((bid) => listing.minPrice <= bid.maxPrice)
          .map(
            (bid) =>
              `listing ${listing.id} may sell at ${formatEther(listing.minPrice)} ETH, no more ` +
              `than bid ${bid.id} may pay (${formatEther(bid.maxPrice)} ETH)`,
          ),
  );
