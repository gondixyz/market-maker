import { formatEther, parseEther } from 'viem';
import { z } from 'zod';

import { VENUES } from './market';

export const MAX_TASKS = 25;

/** The most offers one bid task's `ladder` keeps live. */
export const MAX_LADDER_OFFERS = 10;

/**
 * The shortest and default lifetime of a listing. A listing the bot replaced stays live until it
 * expires, so a short lifetime is what keeps replaced listings from piling up.
 */
export const LISTING_EXPIRATION_MINUTES = 5;

/**
 * The shortest lifetime of a bid. It stays above OpenSea's off-chain cancel delay (5.5 minutes),
 * so an offer becomes cancellable, and is refreshed, before it expires.
 */
export const MIN_BID_EXPIRATION_MINUTES = 15;

/** The default lifetime of a bid. Bids are cancelled off-chain, so a long one leaves nothing up. */
export const BID_EXPIRATION_MINUTES = 60;

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
};

const task = z
  .discriminatedUnion('kind', [
    /** A bid any item of the collection can fill. */
    z.object({
      ...bidFields,
      kind: z.literal('collectionBid'),
      /** The venue the bid is posted on: GONDI's own order book, or OpenSea as a collection offer. */
      venue: z.enum(VENUES).default('gondi'),
      quantity: z.number().int().positive().default(1),
      /**
       * Keep bidding after a fill while the wallet holds fewer than this many items of the
       * collection; without it the task halts once it has bought `quantity` items.
       */
      maxItems: z.number().int().positive().optional(),
      /**
       * Keep bidding after a fill while the items the wallet holds of the collection, valued at
       * the floor, plus the live bid stay within this many ETH.
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
    }),
  ])
  .refine((task) => task.minPrice <= task.maxPrice, 'minPrice must not exceed maxPrice')
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
     * Wrap ETH into WETH each round the wallet's WETH is under `exposureLimit`, keeping `keepEth`
     * ETH for gas, so a listing that sells for ETH funds the bids again. Off when omitted.
     */
    wrapEth: z.object({ keepEth: ether }).optional(),
    tasks: z.array(task).max(MAX_TASKS),
  })
  .refine(
    (file) => new Set(file.tasks.map((task) => task.id)).size === file.tasks.length,
    'task ids must be unique',
  );

export type PricingRule = z.output<typeof pricingRule>;
export type ListingPricingRule = z.output<typeof listingPricingRule>;
export type Task = z.output<typeof task>;
export type BidTask = Exclude<Task, { kind: 'listing' }>;
export type ListingTask = Extract<Task, { kind: 'listing' }>;
export type LossLimits = z.output<typeof lossLimits>;
export type TasksFile = z.output<typeof tasksFile>;

/**
 * Parses a tasks file into typed tasks with amounts in wei. Throws on any invalid task, so a file
 * is either run whole or not at all.
 */
export const parseTasksFile = (raw: unknown): TasksFile => tasksFile.parse(raw);

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
