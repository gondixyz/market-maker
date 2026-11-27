import { EventEmitter } from 'node:events';

import { decideExit, resalePrice } from './exit';
import {
  decideInventoryItem,
  decideListing,
  isCrossed,
  type ItemCost,
  type ListingDecision,
  type ListingWaitReason,
  refreshMarginMs,
} from './listing';
import { decideLoanOffer, isVisibleLoanOffer } from './loan';
import type {
  BidScope,
  BidSnapshot,
  ExitOffer,
  Fill,
  ListingMarket,
  ListingScope,
  LoanBook,
  Market,
  MirrorListing,
  OwnBid,
  OwnListing,
  Venue,
} from './market';
import { decideMirror } from './mirror';
import {
  carriedCollections,
  dayStart,
  ledgerOf,
  type LossReport,
  lossReport,
  type PerWindow,
  pnlOf,
  type PnlReport,
  type Position,
  tradedCollections,
  valuedCollections,
  weekStart,
} from './pnl';
import { ladderPrices } from './pricing';
import {
  type Decision,
  type HaltReason,
  isResaleWait,
  reconcile,
  remaining,
  type ResaleWaitReason,
  type WaitReason,
} from './reconcile';
import { nextReference, type ReferencePrice } from './reference';
import {
  type BidTask,
  type ListingTask,
  type LossLimits,
  resaleExitOf,
  type Task,
  type TasksFile,
} from './task';
import { wrapAmount } from './wrap';

/** What one listed item shows. */
export type ListingItemState =
  | { status: 'listing'; listingId: number; price: bigint }
  | { status: 'waiting'; reason: ListingWaitReason }
  /** Sold into a bid on `venue` this round, for `netPrice` before gas (`bidExit`). */
  | { status: 'sold'; venue: Venue; netPrice: bigint }
  | { status: 'failing'; error: string };

export type TaskState =
  | { status: 'starting' }
  /**
   * `bidId` and `price` are the top offer's; `offers` counts every live one. `resale` names the
   * cap the task's one `resaleBid` offer stands in for, when that is what it keeps up.
   */
  | {
      status: 'bidding';
      bidId: string;
      price: bigint;
      offers: number;
      resale?: ResaleWaitReason;
    }
  | { status: 'listing'; listingId: number; price: bigint }
  | { status: 'listingInventory'; items: { tokenId: bigint; state: ListingItemState }[] }
  | { status: 'waiting'; reason: WaitReason | ListingWaitReason }
  | { status: 'halted'; reason: HaltReason | 'cancelledAll' | 'disabled' }
  | { status: 'failing'; error: string; failures: number };

/** A bid or listing of the task's that is live on the marketplace. */
export type LiveOrder = {
  side: 'bid' | 'listing';
  id: string;
  /** The item a listing sells; `undefined` for a bid. */
  tokenId: bigint | undefined;
  price: bigint;
  /** How many items it may still buy or sell. */
  remaining: number;
  expiration: Date;
};

type TaskRun<RunTask extends Task = Task> = {
  task: RunTask;
  state: TaskState;
  referenceFloor: bigint | null;
  /** What the task's live bids commit: see `commitmentOf`. */
  commitment: bigint;
  /** What its `resaleBid` offer commits against `resaleLimit` instead; `0n` without one. */
  resaleCommitment: bigint;
  /** The floor and the items held as the task's latest bid snapshot read them; `null` before one. */
  floorPrice: bigint | null;
  held: number | null;
  /** The book as the task's latest read saw it, the wallet's own orders excluded; `null` before. */
  bestCompetingBid: bigint | null;
  lowestCompetingAsk: bigint | null;
  /**
   * The top price the task's latest bid snapshot priced its offers at, whether or not a cap kept
   * them down; `null` before one or when it could not be priced.
   */
  targetPrice: bigint | null;
  /** The orders the task's latest round left live; a failing round keeps the previous ones. */
  orders: LiveOrder[];
};

/** One task as a round left it. */
export type TaskReport = TaskRun;

/** What a round's `wrapEth` top-up did: wrapped `amount` wei of ETH, or failed with `error`. */
export type WrapReport =
  | { status: 'wrapped'; amount: bigint }
  | { status: 'failed'; error: string };

/**
 * What an `bidExit` did: sold `tokenId` into an offer for `netPrice` before gas, or failed
 * with `error`, on the item or, with no `tokenId`, on reading the offer.
 */
export type ExitReport =
  | {
      status: 'sold';
      taskId: string;
      tokenId: bigint;
      venue: Venue;
      netPrice: bigint;
      reason: 'profit' | 'stopLoss';
    }
  | { status: 'failed'; taskId: string; tokenId: bigint | undefined; error: string };

/**
 * What an `openSeaListing` did on OpenSea: listed `tokenId` at `price`, cancelled listings of
 * `tokenId`, or failed with `error`, on the item or, with no `tokenId`, on reading the listings.
 */
export type MirrorReport =
  | { status: 'listed'; taskId: string; tokenId: bigint; price: bigint }
  | { status: 'cancelled'; taskId: string; tokenId: bigint; count: number }
  | { status: 'failed'; taskId: string; tokenId: bigint | undefined; error: string };

/** What a listing task's `loanOffer` did for one item, or why it could not. */
export type LendReport =
  | {
      status: 'offered';
      taskId: string;
      tokenId: bigint;
      principal: bigint;
      aprBps: bigint;
      durationSeconds: bigint;
      fee: bigint;
    }
  | { status: 'hidden'; taskId: string; tokenId: bigint; count: number }
  | {
      status: 'waiting';
      taskId: string;
      tokenId: bigint;
      reason: 'insufficientBalance' | 'insufficientAllowance';
    }
  | { status: 'failed'; taskId: string; tokenId: bigint | undefined; error: string };

/** What a round saw and did, emitted as `round` once every task has advanced. */
export type RoundReport = {
  finishedAt: Date;
  durationMs: number;
  exposureLimit: bigint;
  /** What every live bid commits against `exposureLimit`, as `exposureOf` counts it. */
  committed: bigint;
  lossLimits: LossLimits | undefined;
  /** `undefined` without `lossLimits`. */
  loss: LossReport | undefined;
  /** The fills read since `lossLimits.since`; empty without `lossLimits`. */
  fills: Fill[];
  /** The profit since `lossLimits.since`; `undefined` without `lossLimits` or while unmeasured. */
  pnl: PnlReport | undefined;
  tasks: TaskReport[];
};

type RunnerEvents = {
  state: [taskId: string, state: TaskState];
  loss: [report: LossReport];
  round: [report: RoundReport];
  wrap: [report: WrapReport];
  exit: [report: ExitReport];
  mirror: [report: MirrorReport];
  lend: [report: LendReport];
};

/** The best other wallet's bid on a collection and the gas price, as a round reads them. */
type ExitOfferRead = { offer: ExitOffer | null; gasPrice: bigint };

/** What a `bidExit` reads once a round, before deciding on each held item. */
type ExitMarket = ExitOfferRead & { pendingTransaction: boolean };

/** How long a measured loss stands in for a read that fails, before bidding stops. */
const LOSS_READ_GRACE_MS = 2 * 60_000;

/** How far before the latest fill read each round re-reads, for sales the API indexes late. */
const FILL_REREAD_MS = 60 * 60_000;
const HOUR_MS = 60 * 60_000;
/** How far either side of a loss window's start `readWindowFloors` also samples the floor. */
const WINDOW_FLOOR_SAMPLE_MS = HOUR_MS;
/** The most floor samples a `reference` is seeded from: one market read of a few dozen. */
const MAX_REFERENCE_SEED_SAMPLES = 72;

const fillKey = (fill: Fill) =>
  `${fill.slug}#${fill.tokenId}#${fill.side}#${fill.timestamp.getTime()}#${fill.price}`;

const scopeOf = (task: BidTask): BidScope => ({
  ...(task.kind === 'traitBid'
    ? { kind: 'trait' as const, trait: task.trait }
    : { kind: 'collection' as const }),
  slug: task.collection,
  venue: task.venue,
  ...(task.pricing.mode === 'level' && { levels: task.pricing.level }),
});

/**
 * Whether the round measured the loss itself, rather than not at all or by standing in an earlier
 * measure for a failed read: a `resaleBid` offer stands in for a loss cap only then.
 */
const freshlyMeasured = (loss: LossReport | undefined) =>
  loss?.status === 'measured' && loss.staleReason === undefined;

/**
 * Whether bidding on the collection `slug` stops for the loss: the wallet's or the collection's at
 * a cap, or not measured at all.
 */
const lossLimitReached = (loss: LossReport | undefined, slug: string) =>
  loss !== undefined &&
  (loss.status === 'unmeasured' ||
    loss.reached ||
    loss.collections.some((collection) => collection.slug === slug && collection.reached));

const bidOrder = (bid: OwnBid): LiveOrder => ({
  side: 'bid',
  id: bid.id,
  tokenId: undefined,
  price: bid.price,
  remaining: remaining(bid),
  expiration: bid.expiration,
});

const listingOrder = (listing: OwnListing, tokenId: bigint): LiveOrder => ({
  side: 'listing',
  id: String(listing.id),
  tokenId,
  price: listing.price,
  remaining: 1,
  expiration: listing.expiration,
});

/**
 * What a task's live bids commit against `exposureLimit`: the highest price times the most any one
 * may still buy. A ladder's offers share the top offer's WETH, and so do the leftovers of a task
 * that replaced its offer while the marketplace would not cancel the old one yet.
 */
const commitmentOf = (bids: OwnBid[]) => {
  const highestPrice = bids.reduce(
    (highest, bid) => (bid.price > highest ? bid.price : highest),
    0n,
  );
  const mostRemaining = Math.max(0, ...bids.map(remaining));
  return highestPrice * BigInt(mostRemaining);
};

/**
 * The tasks that bid one collection's WETH together: collection bids of the same collection share
 * a key, every other task has its own.
 */
const exposureKey = (task: Task) =>
  task.kind === 'collectionBid' ? `collection:${task.collection}` : `task:${task.id}`;

/**
 * Whether `run` and `other` share WETH against `exposureLimit`: collection bids of one collection
 * on different venues. Each holds the same WETH, and `maxItems` counts what the wallet holds of the
 * collection, so a fill on either venue stops both on the next round. Bids on one venue still add
 * up, since they can fill one after another before the next round counts the items.
 */
const sharesWeth = (run: TaskRun, other: TaskRun) =>
  exposureKey(run.task) === exposureKey(other.task) && venueOf(run.task) !== venueOf(other.task);

const venueOf = (task: Task) => (task.kind === 'listing' ? undefined : task.venue);

/**
 * What `runs` commit together against `exposureLimit`: per collection, the most any one venue's
 * tasks commit, the venues sharing WETH (see `sharesWeth`), summed over the collections.
 */
const exposureOf = (runs: TaskRun[]) => {
  const collections = new Map<string, Map<string | undefined, bigint>>();
  for (const run of runs) {
    const venues = collections.get(exposureKey(run.task)) ?? new Map<string | undefined, bigint>();
    const venue = venueOf(run.task);
    venues.set(venue, (venues.get(venue) ?? 0n) + run.commitment);
    collections.set(exposureKey(run.task), venues);
  }
  return [...collections.values()].reduce(
    (total, venues) =>
      total + [...venues.values()].reduce((most, sum) => (sum > most ? sum : most), 0n),
    0n,
  );
};

/** The waits that last until the wallet holds less or the loss window rolls over, not a round. */
const HOLDING_CAPS = new Set<WaitReason | ListingWaitReason>([
  'maxItemsHeld',
  'maxHeldValue',
  'lossLimit',
]);

/**
 * The waits a sale into a bid can end: it frees a `maxItems` slot, lowers what is held, and pays
 * WETH, which the task's balance and `exposureLimit` checks count.
 */
const WAITS_A_SALE_ENDS = new Set<WaitReason | ListingWaitReason>([
  'maxItemsHeld',
  'maxHeldValue',
  'insufficientBalance',
  'exposureLimit',
]);

/**
 * The cap a task is held back by: the reason it waits on, or the one its `resaleBid` offer stands
 * in for, so the exit guards treat a resale offer as the wait it replaces; `undefined` otherwise.
 */
const heldBackBy = (state: TaskState) =>
  state.status === 'waiting' ? state.reason : state.status === 'bidding' ? state.resale : undefined;

/** Whether the task is held back by what the wallet holds or has lost (`HOLDING_CAPS`). */
const isHeldBackByHolding = (state: TaskState) => {
  const reason = heldBackBy(state);
  return reason !== undefined && HOLDING_CAPS.has(reason);
};

/** Whether the task is held back by a cap a sale into a bid would not end (`WAITS_A_SALE_ENDS`). */
const isHeldBackPastSale = (state: TaskState) => {
  const reason = heldBackBy(state);
  return reason !== undefined && !WAITS_A_SALE_ENDS.has(reason);
};

const isBidRun = (run: TaskRun): run is TaskRun<BidTask> => run.task.kind !== 'listing';
const isListingRun = (run: TaskRun): run is TaskRun<ListingTask> => run.task.kind === 'listing';

/**
 * Runs every task of a tasks file against a market, one round at a time: each round snapshots
 * every task that is not halted, in order (a disabled task starts halted and never runs), and carries out its `reconcile` decision. Tasks run one
 * after another rather than concurrently, so the exposure each one sees already counts the bids the
 * earlier ones placed this round.
 *
 * With `wrapEth`, each round, once the loss is measured and before any task advances, wraps ETH
 * into WETH when the bids are short of it (`topUpWeth`).
 *
 * With `lossLimits`, each round first measures the wallet's loss from its fills and emits it as
 * `loss`; while the wallet's is at a cap, or cannot be measured, every bid task withdraws its bids
 * and waits (`lossLimit`), and while a collection's is at a cap of `perCollection`, its bid tasks
 * do; listings run on.
 *
 * A failing round leaves the task's bid as it is and is retried on the next round; nothing is
 * placed from a snapshot that could not be read whole. Listing tasks run in the same rounds but
 * never cancel and never count against the exposure limit, which only bids draw on.
 *
 * A listing task with `bidExit` first offers each held item to `decideExit`, at most one sale a
 * round, and lists only the items it did not sell; each sale or failed one is emitted as `exit`.
 * What each item cost comes from the fills `lossLimits` reads.
 *
 * A listing task with `openSeaListing` then mirrors each item's GONDI listing on OpenSea at a
 * markup (`decideMirror`), and cancels the OpenSea listings of items it no longer lists; each
 * listing, cancel or failure is emitted as `mirror`, and none of them changes what the item shows.
 *
 * A task with `reference` prices against its smoothed price too (`referenceOf`), and a listing
 * with `aboveCost` against what the item cost, from the same fills as `bidExit`, grossed up for the
 * collection's royalties and fees.
 *
 * A listing task with `loanOffer`, on a market that lends, then keeps one single-loan offer
 * against each item it lists, priced off the item's GONDI listing (`decideLoanOffer`), so a buyer
 * can buy it now and pay later, and hides the offers of items it no longer lists; each offer,
 * hide, wait or failure is emitted as `lend`. Loan offers draw on the wallet's WETH but not on
 * `exposureLimit`: a loan only starts as the item it lends against is bought from the wallet.
 */
export class Runner extends EventEmitter<RunnerEvents> {
  private readonly runs: TaskRun[];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private looping = false;
  private currentRound: Promise<void> = Promise.resolve();
  /** Every fill read since `lossLimits.since`, kept in memory so a round re-reads only the latest. */
  private readonly fillsRead = new Map<string, Fill>();
  private latestFill: Date | undefined;
  /** Each collection's floor when a loss window started, by `<slug>@<start>`, once its samples are past. */
  private readonly windowFloorsRead = new Map<string, bigint | null>();
  /** The loss and profit the latest fresh round measured, and when; `undefined` when it could not. */
  private lastMeasured:
    | { loss: Extract<LossReport, { status: 'measured' }>; pnl: PnlReport; at: Date }
    | undefined;
  /** The items the fills read so far say the wallet bought and still holds, with their cost. */
  private positions: Position[] = [];
  /**
   * How many sales into offers each task tried, by task id and UTC day, failed ones included so a
   * sale that keeps reverting cannot spend gas all day; in memory only.
   */
  private readonly exitsByDay = new Map<string, number>();
  /**
   * The items this run sold into offers, by `slug#tokenId`: the holdings index trails a sale by up
   * to a minute, and such an item must not be sold or listed again.
   */
  private readonly exited = new Set<string>();
  /**
   * The `openSeaListing` tasks whose latest read found OpenSea listings, or that placed one since: a
   * task that holds nothing
   * reads OpenSea again only while one may be left to cancel, which spares OpenSea's rate limit.
   */
  private readonly mirrored = new Set<string>();
  /**
   * The `loanOffer` tasks whose latest read found visible loan offers, or that signed one since: a
   * task that holds nothing reads its offers again only while one may be left to hide.
   */
  private readonly lending = new Set<string>();
  /**
   * When this run first found each listed item held, by `taskId#tokenId`: where a listing's
   * `decay` starts. In memory only, so a restart lists at the full price again.
   */
  private readonly listedSince = new Map<string, Date>();
  /**
   * Each task's smoothed price for its `reference`, by task id: seeded from the market's floor
   * history the first time, then moved by every price a round reads. In memory only; a restart
   * seeds it again.
   */
  private readonly references = new Map<string, ReferencePrice>();
  /**
   * Each collection's `ExitOfferRead` this round, by slug, so a `resaleBid` and the `bidExit` that
   * sells what it buys read the offer once between them; emptied at the start of every round.
   */
  private readonly exitOfferReads = new Map<string, Promise<ExitOfferRead>>();
  /**
   * Per collection, the task that last kept a `resaleBid` offer up there and what the wallet held,
   * as that task's snapshot counts it, when it did: that task holding more since means the offer
   * filled and its item is not sold yet, so no task on the collection puts another one up. Dropped
   * once that task bids as usual; in memory only, so after a restart only the `maxItems` check
   * stands in for it.
   */
  private readonly resaleHeldAt = new Map<string, { taskId: string; held: number }>();

  constructor(
    private readonly market: Market,
    private readonly file: TasksFile,
    private readonly startedAt: Date = new Date(),
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
    this.runs = file.tasks.map((task) => ({
      task,
      state: task.enabled ? { status: 'starting' } : { status: 'halted', reason: 'disabled' },
      referenceFloor: null,
      commitment: 0n,
      resaleCommitment: 0n,
      floorPrice: null,
      held: null,
      bestCompetingBid: null,
      lowestCompetingAsk: null,
      targetPrice: null,
      orders: [],
    }));
  }

  /** Runs a round now, then one every `pollSeconds` until `stop`. */
  start() {
    this.looping = true;
    const loop = async () => {
      this.currentRound = this.round();
      await this.currentRound;
      if (this.looping) this.timer = setTimeout(loop, this.file.pollSeconds * 1_000);
    };
    void loop();
  }

  /**
   * Ends the loop; a round already under way finishes, and none follows it. Resolves once that
   * round has, so a caller that starts another runner after it cannot overlap the two.
   */
  stop() {
    this.looping = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.currentRound;
  }

  states() {
    return new Map(this.runs.map((run) => [run.task.id, run.state]));
  }

  /**
   * Counts what disabled bid tasks' leftover bids commit, then advances every task that is not
   * halted, and emits the round's `RoundReport` as `round`.
   */
  async round() {
    const startedAt = this.now();
    this.exitOfferReads.clear();
    const { loss, pnl } = await this.reportLoss();
    if (this.file.lossLimits) {
      this.positions = ledgerOf([...this.fillsRead.values()], this.file.lossLimits.since).positions;
    }
    await this.topUpWeth();
    for (const run of this.runs) {
      if (isBidRun(run) && !run.task.enabled) await this.countLeftBids(run);
    }
    for (const run of this.runs) {
      if (run.state.status !== 'halted') await this.advance(run, loss);
    }
    const finishedAt = this.now();
    this.emit('round', {
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      exposureLimit: this.file.exposureLimit,
      committed: exposureOf(this.runs),
      lossLimits: this.file.lossLimits,
      loss,
      fills: [...this.fillsRead.values()],
      pnl,
      tasks: this.runs.map((run) => ({ ...run })),
    });
  }

  /**
   * The kill switch: stops the loop, waits out a round under way so it cannot place a bid after
   * the withdrawal, then withdraws every task's active bids and halts every task. Each task is
   * withdrawn on its own, so one that fails leaves the others' withdrawal intact; the failed ones
   * are named in the error thrown at the end and keep their state. Listings stay live until they
   * expire: cancelling one costs a transaction.
   */
  async cancelAll() {
    await this.stop();
    const failures: string[] = [];
    for (const run of this.runs) {
      if (!isBidRun(run)) {
        try {
          if (isListingRun(run)) await this.hideLoanOffers(run.task);
        } catch (error) {
          failures.push(`${run.task.id}: ${String(error)}`);
        }
        this.update(run, { status: 'halted', reason: 'cancelledAll' });
        continue;
      }
      try {
        const snapshot = await this.market.snapshot(scopeOf(run.task), this.startedAt);
        const active = snapshot.ownBids.filter((bid) => bid.active);
        if (active.length > 0) await this.market.cancelBids(active);
        run.commitment = 0n;
        run.resaleCommitment = 0n;
        run.orders = [];
        this.update(run, { status: 'halted', reason: 'cancelledAll' });
      } catch (error) {
        failures.push(`${run.task.id}: ${String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`could not withdraw the bids of ${failures.join('; ')}`);
    }
  }

  /**
   * Measures the loss against `lossLimits`, and emits it, with the profit; both `undefined`
   * without `lossLimits`. A read that fails within `LOSS_READ_GRACE_MS` of one that worked reports
   * that one's loss, marked with `staleReason`, so a dropped connection does not withdraw every
   * bid; past it, the loss is unmeasured and the bidding stops. Only a fresh measure stands in:
   * a round whose loss could not be valued forgets the earlier one.
   */
  private async reportLoss(): Promise<{
    loss: LossReport | undefined;
    pnl: PnlReport | undefined;
  }> {
    const limits = this.file.lossLimits;
    if (!limits) return { loss: undefined, pnl: undefined };
    let report: { loss: LossReport; pnl: PnlReport | undefined };
    try {
      report = this.remember(await this.measureLoss(limits));
    } catch (error) {
      report = this.lossAfterFailedRead(String(error));
    }
    this.emit('loss', report.loss);
    return report;
  }

  /**
   * Keeps a fresh `report` as `lastMeasured`, or forgets the earlier one when its loss could not
   * be valued, and returns it.
   */
  private remember(report: { loss: LossReport; pnl: PnlReport }) {
    this.lastMeasured =
      report.loss.status === 'measured'
        ? { loss: report.loss, pnl: report.pnl, at: this.now() }
        : undefined;
    return report;
  }

  /** What a round whose loss read failed for `reason` reports: see `reportLoss`. */
  private lossAfterFailedRead(reason: string): { loss: LossReport; pnl: PnlReport | undefined } {
    const last = this.lastMeasured;
    if (!last || this.now().getTime() - last.at.getTime() > LOSS_READ_GRACE_MS) {
      this.lastMeasured = undefined;
      return { loss: { status: 'unmeasured', reason }, pnl: undefined };
    }
    return { loss: { ...last.loss, staleReason: reason }, pnl: last.pnl };
  }

  /**
   * The loss and the profit since `limits.since`. The loss reads the terms it needs all or
   * nothing, as a failed read must stop the bidding; the profit also reads the collections of
   * older sales and leaves out one whose terms fail, so a gauge never stops the bidding.
   */
  private async measureLoss(limits: LossLimits) {
    const now = this.now();
    const [fills, ethUsd] = await Promise.all([
      this.readFills(limits.since),
      this.market.ethUsdPrice(),
    ]);
    const ledger = ledgerOf(fills, limits.since);
    const valued = valuedCollections(ledger, now);
    const terms = new Map(
      await Promise.all(
        valued.map(async (slug) => [slug, await this.market.saleTerms(slug)] as const),
      ),
    );
    const windowFloors = await this.readWindowFloors(carriedCollections(ledger, now), now);
    const loss = lossReport({ ledger, terms, ethUsd, now, limits, windowFloors });
    const older = tradedCollections(ledger).filter((slug) => !valued.includes(slug));
    const olderTerms = await Promise.allSettled(older.map((slug) => this.market.saleTerms(slug)));
    for (const [index, result] of olderTerms.entries()) {
      if (result.status === 'fulfilled') terms.set(older[index], result.value);
    }
    return { loss, pnl: { ethUsd, collections: pnlOf(ledger, terms) } };
  }

  /**
   * Each of `slugs`' floor at the start of `now`'s day and week, which `lossReport` values carried
   * items against: the largest of the samples `WINDOW_FLOOR_SAMPLE_MS` either side of each start,
   * up to `now`, so one dust print at the boundary cannot shrink the loss; a larger start only
   * counts more. A start is cached once all its samples are past. A collection whose read fails is
   * left out, so its items count against their cost, the whole loss: a failed read never makes the
   * loss look smaller.
   */
  private async readWindowFloors(slugs: string[], now: Date) {
    const starts = [dayStart(now), weekStart(now)];
    const samplesOf = (start: Date) =>
      [-WINDOW_FLOOR_SAMPLE_MS, 0, WINDOW_FLOOR_SAMPLE_MS].map(
        (offset) => new Date(Math.min(start.getTime() + offset, now.getTime())),
      );
    const settled = (start: Date) => start.getTime() + WINDOW_FLOOR_SAMPLE_MS <= now.getTime();
    const keyOf = (slug: string, start: Date) => `${slug}@${start.getTime()}`;
    const results = await Promise.allSettled(
      slugs.map(async (slug) => {
        const floors = new Map(
          starts.map((start) => [start.getTime(), this.windowFloorsRead.get(keyOf(slug, start))]),
        );
        const missing = starts.filter((start) => floors.get(start.getTime()) === undefined);
        if (missing.length > 0) {
          if (!this.market.floorHistory) throw new Error('the market keeps no floor history');
          const samples = await this.market.floorHistory(slug, missing.flatMap(samplesOf));
          missing.forEach((start, index) => {
            const floor = samples
              .slice(index * 3, index * 3 + 3)
              .reduce<
                bigint | null
              >((largest, sample) => (sample !== null && (largest === null || sample > largest) ? sample : largest), null);
            floors.set(start.getTime(), floor);
            if (settled(start)) this.windowFloorsRead.set(keyOf(slug, start), floor);
          });
        }
        const [day, week] = starts.map((start) => floors.get(start.getTime()) ?? null);
        return [slug, { day, week }] as const;
      }),
    );
    return new Map<string, PerWindow<bigint | null>>(
      results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
    );
  }

  /**
   * The wallet's fills since `since`. The first round reads them all; later ones read only from
   * an hour before the latest fill already read, so the cost of a round does not grow with the
   * ledger, and add what they had not read yet. A restart reads them all again.
   */
  private async readFills(since: Date) {
    const from = this.latestFill
      ? new Date(Math.max(since.getTime(), this.latestFill.getTime() - FILL_REREAD_MS))
      : since;
    for (const fill of await this.market.fills(from)) {
      this.fillsRead.set(fillKey(fill), fill);
      if (!this.latestFill || fill.timestamp > this.latestFill) this.latestFill = fill.timestamp;
    }
    return [...this.fillsRead.values()];
  }

  /**
   * With `wrapEth`, wraps the ETH `wrapAmount` decides before any bid is placed, so the round's
   * bids see the WETH it adds, and emits what it did as `wrap`. A failure is reported and the
   * round goes on: the bids then wait on the WETH they lack, as they would without `wrapEth`.
   * Nothing is wrapped while the wallet has a transaction unmined, such as a wrap that timed out,
   * since the balances do not count it yet and a second wrap would double it.
   */
  private async topUpWeth() {
    const settings = this.file.wrapEth;
    if (!settings) return;
    try {
      const { eth, weth, pending } = await this.market.walletBalances();
      if (pending) return;
      const amount = wrapAmount({
        eth,
        weth,
        target: this.file.exposureLimit,
        keepEth: settings.keepEth,
      });
      if (amount === 0n) return;
      await this.market.wrapEth(amount);
      this.emit('wrap', { status: 'wrapped', amount });
    } catch (error) {
      this.emit('wrap', { status: 'failed', error: String(error) });
    }
  }

  private async advance(run: TaskRun, loss: LossReport | undefined) {
    try {
      if (isBidRun(run)) await this.advanceBid(run, loss);
      if (isListingRun(run)) {
        if (run.task.tokenId === undefined) await this.advanceInventory(run);
        else await this.advanceListing(run, run.task.tokenId);
      }
    } catch (error) {
      const failures = run.state.status === 'failing' ? run.state.failures + 1 : 1;
      this.update(run, { status: 'failing', error: String(error), failures });
    }
  }

  /**
   * A disabled bid task never reconciles, but the bids it left up (disabling cancels nothing) still
   * commit WETH, so each round reads them and counts them against `exposureLimit`, until they fill,
   * expire or are cancelled. A failed read keeps the last count.
   */
  private async countLeftBids(run: TaskRun<BidTask>) {
    try {
      const snapshot = await this.market.snapshot(scopeOf(run.task), this.startedAt);
      this.book(
        run,
        snapshot.ownBids.filter((bid) => bid.active),
      );
    } catch {
      return;
    }
  }

  private async advanceBid(run: TaskRun<BidTask>, loss: LossReport | undefined) {
    const snapshot = await this.market.snapshot(scopeOf(run.task), this.startedAt);
    if (!isCrossed(snapshot.floorPrice, snapshot.bestCompetingBid)) {
      run.referenceFloor ??= snapshot.floorPrice;
    }
    run.floorPrice = snapshot.floorPrice;
    run.held = snapshot.held;
    run.bestCompetingBid = snapshot.bestCompetingBid;
    const crossed = isCrossed(snapshot.floorPrice, snapshot.bestCompetingBid);
    const referencePrice = await this.referenceOf(run.task, crossed ? null : snapshot.floorPrice);
    run.targetPrice = ladderPrices(run.task, snapshot, referencePrice).at(0) ?? null;
    const input = {
      referencePrice,
      task: run.task,
      snapshot,
      now: this.now(),
      pollSeconds: this.file.pollSeconds,
      referenceFloor: run.referenceFloor,
      exposureAvailable: this.file.exposureLimit - this.committedByOthers(run),
      lossLimitReached: lossLimitReached(loss, run.task.collection),
    };
    let decision: Decision = reconcile({ ...input, resalePrice: null });
    if (
      decision.type === 'wait' &&
      isResaleWait(decision.reason) &&
      (decision.reason !== 'lossLimit' || freshlyMeasured(loss)) &&
      run.task.resaleBid
    ) {
      decision = reconcile({ ...input, resalePrice: await this.resalePriceOf(run, snapshot) });
    }
    const resaleAt = decision.type === 'resale' ? decision.price : null;
    const slug = run.task.collection;
    if (decision.type === 'resale') {
      this.resaleHeldAt.set(slug, { taskId: run.task.id, held: snapshot.held });
    }
    if (decision.type === 'bid' && this.resaleHeldAt.get(slug)?.taskId === run.task.id) {
      this.resaleHeldAt.delete(slug);
    }
    const cancelled = new Set(decision.cancel.map((bid) => bid.id));
    const leftUp = snapshot.ownBids.filter((bid) => bid.active && !cancelled.has(bid.id));
    const placements = decision.type === 'bid' || decision.type === 'resale' ? decision.place : [];
    for (const { price, quantity } of placements) {
      leftUp.push(
        await this.market.placeBid({
          scope: scopeOf(run.task),
          price,
          quantity,
          expiration: new Date(this.now().getTime() + run.task.expirationMinutes * 60_000),
        }),
      );
      this.book(run, leftUp, resaleAt);
    }
    if (decision.cancel.length > 0) await this.market.cancelBids(decision.cancel);
    this.book(run, leftUp, resaleAt);
    if ((decision.type === 'bid' || decision.type === 'resale') && leftUp.length > 0) {
      const top = leftUp.reduce((best, bid) => (bid.price > best.price ? bid : best));
      this.update(run, {
        status: 'bidding',
        bidId: top.id,
        price: top.price,
        offers: leftUp.length,
        ...(decision.type === 'resale' && { resale: decision.reason }),
      });
    }
    if (decision.type === 'wait') this.update(run, { status: 'waiting', reason: decision.reason });
    if (decision.type === 'halt') this.update(run, { status: 'halted', reason: decision.reason });
  }

  /**
   * Books `bids`, the task's bids still live once its decision is carried out, as its orders and
   * its commitment: a bid the marketplace would not cancel yet stays up through a `wait` or beside
   * a kept bid, and still counts against `exposureLimit` for every other task. The bids at
   * `resaleAt`, the price of a `resale` decision, count against `resaleLimit` instead.
   */
  private book(run: TaskRun, bids: OwnBid[], resaleAt: bigint | null = null) {
    const isResale = (bid: OwnBid) => resaleAt !== null && bid.price === resaleAt;
    run.commitment = commitmentOf(bids.filter((bid) => !isResale(bid)));
    run.resaleCommitment = commitmentOf(bids.filter(isResale));
    run.orders = bids.map(bidOrder);
  }

  /**
   * The price of the task's `resaleBid` offer this round, or `null` when it keeps none: without a
   * `resaleLimit` or an enabled listing with `bidExit` on the collection (the desktop app drops
   * every `bidExit`), once that `bidExit` has tried its `maxPerDay` sales today, while the wallet
   * holds more than when a task last kept one up on the collection (`resaleHeldAt`) or more than `maxItems` (an
   * item an earlier offer bought is not sold yet), while another task
   * keeps one on the collection, when the offer or the gas cannot be read, when the best other bid
   * is on the task's own venue (an offer under it there never fills, so a task on the other venue
   * keeps the collection's resale offer), or when the price does not fit in what `resaleLimit` has
   * left.
   */
  private async resalePriceOf(run: TaskRun<BidTask>, snapshot: BidSnapshot) {
    const { task } = run;
    const exitTask = resaleExitOf(this.file, task.collection);
    const exit = exitTask?.bidExit;
    if (!task.resaleBid || this.file.resaleLimit === undefined || !exitTask || !exit) return null;
    const dayKey = `${exitTask.id}#${dayStart(this.now()).toISOString()}`;
    const others = this.runs.filter((other) => other !== run);
    if (
      this.resaleItemUnsold(task.collection) ||
      (this.exitsByDay.get(dayKey) ?? 0) >= exit.maxPerDay ||
      (task.maxItems !== undefined && snapshot.held > task.maxItems) ||
      others.some(
        (other) => other.task.collection === task.collection && other.resaleCommitment > 0n,
      )
    ) {
      return null;
    }
    let read: ExitOfferRead;
    try {
      read = await this.readExitOffer(task.collection);
    } catch {
      return null;
    }
    if (read.offer?.venue === task.venue) return null;
    const price = resalePrice({
      ...read,
      maxGasGwei: exit.maxGasGwei,
      marginPercent: task.resaleBid.marginPercent,
      floorPrice: snapshot.floorPrice,
      maxPrice: task.maxPrice,
      priceStep: snapshot.priceStep,
    });
    const room =
      this.file.resaleLimit - others.reduce((total, other) => total + other.resaleCommitment, 0n);
    return price !== null && price <= room ? price : null;
  }

  /**
   * Whether the task that last kept a resale offer up on the collection holds more than it did
   * then, by its latest snapshot (see `resaleHeldAt`).
   */
  private resaleItemUnsold(slug: string) {
    const heldAt = this.resaleHeldAt.get(slug);
    const setter = heldAt && this.runs.find((run) => run.task.id === heldAt.taskId);
    return !!heldAt && !!setter && (setter.held ?? 0) > heldAt.held;
  }

  /** The collection's `ExitOfferRead`, read once a round (see `exitOfferReads`). */
  private readExitOffer(slug: string) {
    const cached = this.exitOfferReads.get(slug);
    if (cached) return cached;
    const read = Promise.all([this.market.exitOffer(slug), this.market.gasPrice()]).then(
      ([offer, gasPrice]) => ({ offer, gasPrice }),
    );
    read.catch(() => this.exitOfferReads.delete(slug));
    this.exitOfferReads.set(slug, read);
    return read;
  }

  private async advanceListing(run: TaskRun<ListingTask>, tokenId: bigint) {
    const scope = { slug: run.task.collection, tokenId };
    const listingMarket = await this.market.listingMarket(scope.slug);
    const itemListing = await this.market.itemListing(scope, this.startedAt);
    run.lowestCompetingAsk = listingMarket.lowestCompetingAsk;
    const snapshot = { ...listingMarket, ...itemListing };
    const now = this.now();
    const decision = decideListing({
      task: run.task,
      snapshot,
      referencePrice: await this.listingReferenceOf(run.task, listingMarket),
      itemCost: await this.itemCostOf(run.task, tokenId),
      now,
      pollSeconds: this.file.pollSeconds,
      listedSince: this.listedSinceOf(run.task, tokenId, now, snapshot.owned),
    });
    if (decision.type === 'halt') {
      run.orders = [];
      this.update(run, { status: 'halted', reason: decision.reason });
      return;
    }
    const { state, listing } = await this.carryOutListing(run.task, scope, decision);
    run.orders = listing ? [listingOrder(listing, tokenId)] : [];
    this.update(run, state);
  }

  /**
   * Lists every item of the collection the wallet holds, each decided on its own. The collection is
   * read once and the items all at once, so a round costs about one item's latency rather than one
   * per item; an item that fails shows `failing` without holding up the others.
   */
  private async advanceInventory(run: TaskRun<ListingTask>) {
    const slug = run.task.collection;
    const [listingMarket, tokenIds] = await Promise.all([
      this.market.listingMarket(slug),
      this.market.heldItems(slug),
    ]);
    const itemListings = await Promise.allSettled(
      tokenIds.map((tokenId) => this.market.itemListing({ slug, tokenId }, this.startedAt)),
    );
    run.lowestCompetingAsk = listingMarket.lowestCompetingAsk;
    const referencePrice = await this.listingReferenceOf(run.task, listingMarket);
    const feeBps = tokenIds.length > 0 ? await this.feeBpsOf(run.task) : undefined;
    const heldKeys = new Set(tokenIds.map((tokenId) => `${run.task.id}#${tokenId}`));
    for (const key of this.listedSince.keys()) {
      if (key.startsWith(`${run.task.id}#`) && !heldKeys.has(key)) this.listedSince.delete(key);
    }
    const items: { tokenId: bigint; state: ListingItemState }[] = [];
    const orders: LiveOrder[] = [];
    const held = tokenIds.filter((tokenId) => !this.exited.has(`${slug}#${tokenId}`));
    const mirrors =
      held.length > 0 || this.mirrored.has(run.task.id)
        ? await this.readMirrors(run.task)
        : undefined;
    const loanBook =
      held.length > 0 || this.lending.has(run.task.id)
        ? await this.readLoanBook(run.task)
        : undefined;
    const gondiListings = new Map<bigint, OwnListing[]>();
    const unread = new Set<bigint>();
    let exitMarket = held.length > 0 ? await this.readExitMarket(run.task) : undefined;
    for (const [index, tokenId] of tokenIds.entries()) {
      const itemListing = itemListings[index];
      const scope = { slug, tokenId };
      if (!held.includes(tokenId)) continue;
      const exited = exitMarket && (await this.exitItem(run.task, scope, exitMarket, held.length));
      if (exited) exitMarket = undefined;
      if (exited?.status === 'sold') {
        const { venue, netPrice } = exited.offer;
        items.push({ tokenId, state: { status: 'sold', venue, netPrice } });
        continue;
      }
      if (itemListing.status === 'rejected') unread.add(tokenId);
      try {
        if (itemListing.status === 'rejected') throw itemListing.reason;
        const snapshot = { ...listingMarket, ...itemListing.value };
        const now = this.now();
        const decision = decideInventoryItem({
          task: run.task,
          snapshot,
          referencePrice,
          itemCost: this.itemCost(slug, tokenId, feeBps),
          now,
          pollSeconds: this.file.pollSeconds,
          listedSince: this.listedSinceOf(run.task, tokenId, now, snapshot.owned),
        });
        if (!decision) continue;
        gondiListings.set(tokenId, snapshot.ownListings);
        const { state, listing } = await this.carryOutListing(run.task, scope, decision);
        items.push({ tokenId, state });
        if (listing) orders.push(listingOrder(listing, tokenId));
        if (listing) gondiListings.set(tokenId, [...snapshot.ownListings, listing]);
      } catch (error) {
        items.push({ tokenId, state: { status: 'failing', error: String(error) } });
      }
    }
    if (mirrors) await this.mirrorItems(run.task, mirrors, gondiListings, unread);
    if (loanBook) await this.lendItems(run.task, loanBook, gondiListings, unread);
    run.orders = orders;
    this.update(run, { status: 'listingInventory', items });
  }

  /**
   * The task's smoothed price after `sample`, the price this round read (`null` when it read none,
   * which leaves the price as it was), or `null` for a task without a `reference`. The first time
   * it is seeded from the collection's floor history over three half-lives, hourly at most, so a
   * restart does not start it over from today's floor; a trait bid, whose floor is the trait's, a
   * market without history, or a read that fails, starts it at the first sample instead.
   */
  private async referenceOf(task: Task, sample: bigint | null): Promise<bigint | null> {
    if (!task.reference) return null;
    const { halfLifeHours } = task.reference;
    const now = this.now();
    let reference = this.references.get(task.id);
    if (!reference && task.kind !== 'traitBid') {
      reference = await this.seedReference(task.collection, halfLifeHours, now);
    }
    if (sample !== null) reference = nextReference(reference, sample, now, halfLifeHours);
    if (reference) this.references.set(task.id, reference);
    return reference?.price ?? null;
  }

  /**
   * A listing task's `referenceOf` the cheapest competing listing, which a crossed book leaves
   * out, as a dust ask would otherwise drag the average down.
   */
  private async listingReferenceOf(task: ListingTask, market: ListingMarket) {
    const crossed = isCrossed(market.lowestCompetingAsk, market.bestCompetingBid);
    return this.referenceOf(task, crossed ? null : market.lowestCompetingAsk);
  }

  /** The collection's floor history folded into a `ReferencePrice`, or `undefined` without one. */
  private async seedReference(
    slug: string,
    halfLifeHours: number,
    now: Date,
  ): Promise<ReferencePrice | undefined> {
    if (!this.market.floorHistory) return undefined;
    const spanMs = 3 * halfLifeHours * HOUR_MS;
    const stepMs = Math.max(HOUR_MS, spanMs / MAX_REFERENCE_SEED_SAMPLES);
    const timestamps = Array.from(
      { length: Math.floor(spanMs / stepMs) },
      (_, index) => new Date(now.getTime() - spanMs + index * stepMs),
    );
    try {
      const floors = await this.market.floorHistory(slug, timestamps);
      return floors.reduce<ReferencePrice | undefined>(
        (reference, floor, index) =>
          floor === null
            ? reference
            : nextReference(reference, floor, timestamps[index], halfLifeHours),
        undefined,
      );
    } catch {
      return undefined;
    }
  }

  /** The royalties and fees a sale of the collection pays, for a listing with `aboveCost`. */
  private async feeBpsOf(task: ListingTask) {
    return task.aboveCost ? (await this.market.saleTerms(task.collection)).feeBps : undefined;
  }

  /** What the item cost and what its sale pays away, when the fills say what it cost. */
  private itemCost(
    slug: string,
    tokenId: bigint,
    feeBps: bigint | undefined,
  ): ItemCost | undefined {
    const position = this.positions.find((held) => held.slug === slug && held.tokenId === tokenId);
    return position && feeBps !== undefined ? { cost: position.cost, feeBps } : undefined;
  }

  private async itemCostOf(task: ListingTask, tokenId: bigint) {
    return this.itemCost(task.collection, tokenId, await this.feeBpsOf(task));
  }

  /**
   * When this run first found `tokenId` held for `task`, noting `now` the first time. An item not
   * held has no clock, so one that leaves the wallet and comes back starts again.
   */
  private listedSinceOf(task: ListingTask, tokenId: bigint, now: Date, owned: boolean) {
    const key = `${task.id}#${tokenId}`;
    if (!owned) {
      this.listedSince.delete(key);
      return now;
    }
    const since = this.listedSince.get(key) ?? now;
    this.listedSince.set(key, since);
    return since;
  }

  /**
   * With `openSeaListing` and an OpenSea key, the wallet's OpenSea listings of the collection, read
   * once for the round, and noted in `mirrored`; `undefined` otherwise, or when the read fails, which is reported as
   * `mirror` and leaves the OpenSea listings as they are this round.
   */
  private async readMirrors(task: ListingTask): Promise<MirrorListing[] | undefined> {
    if (!task.openSeaListing || !this.market.mirror) return undefined;
    try {
      const mirrors = await this.market.mirror.mirrorListings(task.collection);
      if (mirrors.length > 0) this.mirrored.add(task.id);
      else this.mirrored.delete(task.id);
      return mirrors;
    } catch (error) {
      this.emit('mirror', {
        status: 'failed',
        taskId: task.id,
        tokenId: undefined,
        error: String(error),
      });
      return undefined;
    }
  }

  /**
   * Carries out `decideMirror` for every item the round listed or that has an OpenSea listing,
   * cancelling before placing; an item whose GONDI read failed is left as it is. `gondiListings`
   * holds each listed item's GONDI listings, so an item missing from it (sold, moved, or no longer
   * held) has its OpenSea listings cancelled. Each item fails on its own, reported as `mirror`.
   */
  private async mirrorItems(
    task: ListingTask,
    mirrors: MirrorListing[],
    gondiListings: Map<bigint, OwnListing[]>,
    unread: Set<bigint>,
  ) {
    const mirror = this.market.mirror;
    if (!task.openSeaListing || !mirror) return;
    const { markupPercent, expirationMinutes } = task.openSeaListing;
    const tokenIds = new Set([...gondiListings.keys(), ...mirrors.map((item) => item.tokenId)]);
    for (const tokenId of tokenIds) {
      if (unread.has(tokenId)) continue;
      const now = this.now();
      const decision = decideMirror({
        markupPercent,
        gondiListings: gondiListings.get(tokenId) ?? [],
        mirrors: mirrors.filter((item) => item.tokenId === tokenId),
        priceStep: mirror.priceStep,
        refreshMarginMs: refreshMarginMs(expirationMinutes, this.file.pollSeconds),
        now,
      });
      try {
        if (decision.cancel.length > 0) {
          await mirror.cancelMirrorListings(decision.cancel);
          this.emit('mirror', {
            status: 'cancelled',
            taskId: task.id,
            tokenId,
            count: decision.cancel.length,
          });
        }
        if (decision.place !== null) {
          await mirror.placeMirrorListing({
            scope: { slug: task.collection, tokenId },
            price: decision.place,
            expiration: new Date(now.getTime() + expirationMinutes * 60_000),
          });
          this.mirrored.add(task.id);
          this.emit('mirror', {
            status: 'listed',
            taskId: task.id,
            tokenId,
            price: decision.place,
          });
        }
      } catch (error) {
        this.emit('mirror', { status: 'failed', taskId: task.id, tokenId, error: String(error) });
      }
    }
  }

  /**
   * With `loanOffer` on a market that lends, the wallet's loan offers on the collection and its
   * WETH, read once for the round; `undefined` otherwise, or when the read fails, which is reported
   * as `lend` and leaves the offers as they are this round.
   */
  private async readLoanBook(task: ListingTask): Promise<LoanBook | undefined> {
    if (!task.loanOffer || !this.market.loans) return undefined;
    try {
      const book = await this.market.loans.loanBook(task.collection);
      const now = this.now();
      if (book.offers.some((offer) => isVisibleLoanOffer(offer, now))) this.lending.add(task.id);
      else this.lending.delete(task.id);
      return book;
    } catch (error) {
      this.emit('lend', {
        status: 'failed',
        taskId: task.id,
        tokenId: undefined,
        error: String(error),
      });
      return undefined;
    }
  }

  /**
   * Carries out `decideLoanOffer` for every item the round listed or that has a loan offer, hiding
   * after signing, as a bid is placed before the old one is cancelled; an item whose GONDI read
   * failed is left as it is. An item missing from `gondiListings` (sold, moved, or no longer held)
   * has its visible offers hidden. Each item fails on its own, reported as `lend`.
   */
  private async lendItems(
    task: ListingTask,
    book: LoanBook,
    gondiListings: Map<bigint, OwnListing[]>,
    unread: Set<bigint>,
  ) {
    const loans = this.market.loans;
    if (!task.loanOffer || !loans) return;
    const { expirationMinutes } = task.loanOffer;
    const tokenIds = new Set([
      ...gondiListings.keys(),
      ...book.offers.map((offer) => offer.tokenId),
    ]);
    for (const tokenId of tokenIds) {
      if (unread.has(tokenId)) continue;
      const now = this.now();
      const decision = decideLoanOffer({
        terms: task.loanOffer,
        minPrice: task.minPrice,
        gondiListings: gondiListings.get(tokenId) ?? [],
        offers: book.offers.filter((offer) => offer.tokenId === tokenId),
        balance: book.balance,
        allowance: book.allowance,
        refreshMarginMs: refreshMarginMs(expirationMinutes, this.file.pollSeconds),
        now,
      });
      try {
        if (decision.type === 'place') {
          await loans.placeLoanOffer({
            scope: { slug: task.collection, tokenId },
            ...decision.terms,
            expiration: new Date(now.getTime() + expirationMinutes * 60_000),
          });
          this.lending.add(task.id);
          this.emit('lend', { status: 'offered', taskId: task.id, tokenId, ...decision.terms });
        }
        if (decision.type === 'wait' && decision.reason !== 'notListed') {
          this.emit('lend', {
            status: 'waiting',
            taskId: task.id,
            tokenId,
            reason: decision.reason,
          });
        }
        if (decision.hide.length > 0) {
          await loans.hideLoanOffers(decision.hide);
          this.emit('lend', {
            status: 'hidden',
            taskId: task.id,
            tokenId,
            count: decision.hide.length,
          });
        }
      } catch (error) {
        this.emit('lend', { status: 'failed', taskId: task.id, tokenId, error: String(error) });
      }
    }
  }

  /** Hides every visible loan offer of a `loanOffer` task, for `cancelAll`; they lend until they expire. */
  private async hideLoanOffers(task: ListingTask) {
    if (!task.loanOffer || !this.market.loans) return;
    const now = this.now();
    const { offers } = await this.market.loans.loanBook(task.collection);
    const visible = offers.filter((offer) => isVisibleLoanOffer(offer, now));
    if (visible.length > 0) await this.market.loans.hideLoanOffers(visible);
    this.lending.delete(task.id);
  }

  /**
   * Carries out a listing decision for one item: what the item shows, and its live listing, which a
   * `needsOnChainCancel` wait still leaves up.
   */
  private async carryOutListing(
    task: ListingTask,
    scope: ListingScope,
    decision: Exclude<ListingDecision, { type: 'halt' }>,
  ): Promise<{
    state: Exclude<ListingItemState, { status: 'failing' | 'sold' }>;
    listing: OwnListing | undefined;
  }> {
    if (decision.type === 'wait') {
      return { state: { status: 'waiting', reason: decision.reason }, listing: decision.listing };
    }
    const listing =
      decision.type === 'keep'
        ? decision.listing
        : await this.market.placeListing({
            scope,
            price: decision.price,
            expiration: new Date(this.now().getTime() + task.expirationMinutes * 60_000),
          });
    return { state: { status: 'listing', listingId: listing.id, price: listing.price }, listing };
  }

  /**
   * With `bidExit`, the best bid of GONDI and OpenSea, the gas price and whether a transaction is
   * unmined, read once for the round; `undefined` without it, or when a read fails, which is reported as `exit`
   * and leaves the items to their listings.
   */
  private async readExitMarket(task: ListingTask): Promise<ExitMarket | undefined> {
    if (!task.bidExit) return undefined;
    try {
      const [{ offer, gasPrice }, balances] = await Promise.all([
        this.readExitOffer(task.collection),
        this.market.walletBalances(),
      ]);
      return { offer, gasPrice, pendingTransaction: balances.pending };
    } catch (error) {
      this.emit('exit', {
        status: 'failed',
        taskId: task.id,
        tokenId: undefined,
        error: String(error),
      });
      return undefined;
    }
  }

  /**
   * Sells the held item into the round's offer when `decideExit` says so, and reports it as
   * `exit`; what it tried, or `undefined` when it held. A failed sale counts against `maxPerDay`,
   * is reported, and the item goes on to its listing; either way the round tries no other item.
   */
  private async exitItem(
    task: ListingTask,
    scope: ListingScope,
    exitMarket: ExitMarket,
    held: number,
  ) {
    const exit = task.bidExit;
    if (!exit) return undefined;
    const now = this.now();
    const dayKey = `${task.id}#${dayStart(now).toISOString()}`;
    const decision = decideExit({
      exit,
      minPrice: task.minPrice,
      position: this.positions.find(
        (position) => position.slug === scope.slug && position.tokenId === scope.tokenId,
      ),
      ...exitMarket,
      ownTopBid: this.ownTopBid(task.collection, held),
      bidsFull: this.bidsFull(task.collection, held),
      soldToday: this.exitsByDay.get(dayKey) ?? 0,
      now,
    });
    if (decision.type === 'hold') return undefined;
    this.exitsByDay.set(dayKey, (this.exitsByDay.get(dayKey) ?? 0) + 1);
    try {
      await this.market.sellToOffer({
        scope,
        offer: decision.offer,
        minProceeds: decision.minProceeds,
      });
    } catch (error) {
      this.emit('exit', {
        status: 'failed',
        taskId: task.id,
        tokenId: scope.tokenId,
        error: String(error),
      });
      return { status: 'failed' as const };
    }
    this.exited.add(`${scope.slug}#${scope.tokenId}`);
    this.emit('exit', {
      status: 'sold',
      taskId: task.id,
      tokenId: scope.tokenId,
      venue: decision.offer.venue,
      netPrice: decision.offer.netPrice,
      reason: decision.reason,
    });
    return { status: 'sold' as const, offer: decision.offer };
  }

  /**
   * Whether no bid task on the collection can buy another item, so a held one may be sold at a
   * loss. A task cannot buy once it is halted (disabled, `filled`, `floorMoved`, cancelled), while it
   * waits on what it holds or has lost (`HOLDING_CAPS`), or keeps a `resaleBid` offer in place of
   * such a wait (`heldBackBy`), or once `held` items reach its `maxItems`; a collection with no bid
   * task cannot buy either. A wait on balance, allowance or exposure passes,
   * so it does not count.
   */
  private bidsFull(slug: string, held: number) {
    return !this.runs
      .filter(isBidRun)
      .filter((run) => run.task.collection === slug)
      .some(
        (run) =>
          run.state.status !== 'halted' &&
          !isHeldBackByHolding(run.state) &&
          (run.task.maxItems === undefined || held < run.task.maxItems),
      );
  }

  /**
   * The most the bid tasks on the collection pay for an item, on any venue, now or once a sale
   * makes room: their live bids, and the `targetPrice` of each task that bids, or waits only on
   * what the sale ends (`WAITS_A_SALE_ENDS`), as long as one fewer than `held` items is under its
   * `maxItems`. A task waiting on `maxItemsHeld` has withdrawn its bids, bids its target price
   * again the round after a sale, and a seller could hand the same item straight back into it. A
   * halted task, one waiting on what a sale leaves as it is (`lossLimit`, allowance, a crossed
   * book), and one still at its `maxItems` after the sale stay out.
   */
  private ownTopBid(slug: string, held: number) {
    const runs = this.runs.filter(isBidRun).filter((run) => run.task.collection === slug);
    const targets = runs
      .filter(
        (run) =>
          run.state.status !== 'halted' &&
          !isHeldBackPastSale(run.state) &&
          (run.task.maxItems === undefined || held - 1 < run.task.maxItems),
      )
      .flatMap((run) => (run.targetPrice === null ? [] : [run.targetPrice]));
    return [...runs.flatMap((run) => run.orders.map((order) => order.price)), ...targets].reduce<
      bigint | null
    >((top, price) => (top === null || price > top ? price : top), null);
  }

  /**
   * What every other task's live bids commit against `exposureLimit`, before `current` bids: the
   * tasks that share WETH with it (see `sharesWeth`) are left out, since its bid takes no more WETH
   * than theirs already does, and the rest are counted by `exposureOf`.
   */
  private committedByOthers(current: TaskRun) {
    return exposureOf(this.runs.filter((run) => run !== current && !sharesWeth(run, current)));
  }

  private update(run: TaskRun, state: TaskState) {
    run.state = state;
    this.emit('state', run.task.id, state);
  }
}
