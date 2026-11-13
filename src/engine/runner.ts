import { EventEmitter } from 'node:events';

import {
  decideInventoryItem,
  decideListing,
  isCrossed,
  type ListingDecision,
  type ListingWaitReason,
} from './listing';
import type { BidScope, Fill, ListingScope, Market, OwnBid, OwnListing } from './market';
import {
  ledgerOf,
  type LossReport,
  lossReport,
  pnlOf,
  type PnlReport,
  tradedCollections,
  valuedCollections,
} from './pnl';
import { type HaltReason, reconcile, remaining, type WaitReason } from './reconcile';
import type { BidTask, ListingTask, LossLimits, Task, TasksFile } from './task';
import { wrapAmount } from './wrap';

/** What one listed item shows. */
export type ListingItemState =
  | { status: 'listing'; listingId: number; price: bigint }
  | { status: 'waiting'; reason: ListingWaitReason }
  | { status: 'failing'; error: string };

export type TaskState =
  | { status: 'starting' }
  /** `bidId` and `price` are the top offer's; `offers` counts every live one. */
  | { status: 'bidding'; bidId: string; price: bigint; offers: number }
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
  /** The floor and the items held as the task's latest bid snapshot read them; `null` before one. */
  floorPrice: bigint | null;
  held: number | null;
  /** The book as the task's latest read saw it, the wallet's own orders excluded; `null` before. */
  bestCompetingBid: bigint | null;
  lowestCompetingAsk: bigint | null;
  /** The orders the task's latest round left live; a failing round keeps the previous ones. */
  orders: LiveOrder[];
};

/** One task as a round left it. */
export type TaskReport = TaskRun;

/** What a round's `wrapEth` top-up did: wrapped `amount` wei of ETH, or failed with `error`. */
export type WrapReport =
  | { status: 'wrapped'; amount: bigint }
  | { status: 'failed'; error: string };

/** What a round saw and did, emitted as `round` once every task has advanced. */
export type RoundReport = {
  finishedAt: Date;
  durationMs: number;
  exposureLimit: bigint;
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
};

/** How long a measured loss stands in for a read that fails, before bidding stops. */
const LOSS_READ_GRACE_MS = 2 * 60_000;

/** How far before the latest fill read each round re-reads, for sales the API indexes late. */
const FILL_REREAD_MS = 60 * 60_000;

const fillKey = (fill: Fill) =>
  `${fill.slug}#${fill.tokenId}#${fill.side}#${fill.timestamp.getTime()}#${fill.price}`;

const scopeOf = (task: BidTask): BidScope => ({
  kind: 'collection',
  slug: task.collection,
  venue: task.venue,
  ...(task.pricing.mode === 'level' && { levels: task.pricing.level }),
});

/** Whether bidding stops for the loss: at a cap, or not measured at all. */
const lossLimitReached = (loss: LossReport | undefined) =>
  loss !== undefined && (loss.status === 'unmeasured' || loss.reached);

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
 * `loss`; while it is at a cap, or cannot be measured, every bid task withdraws its bids and waits
 * (`lossLimit`), and listings run on.
 *
 * A failing round leaves the task's bid as it is and is retried on the next round; nothing is
 * placed from a snapshot that could not be read whole. Listing tasks run in the same rounds but
 * never cancel and never count against the exposure limit, which only bids draw on.
 */
export class Runner extends EventEmitter<RunnerEvents> {
  private readonly runs: TaskRun[];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private looping = false;
  private currentRound: Promise<void> = Promise.resolve();
  /** Every fill read since `lossLimits.since`, kept in memory so a round re-reads only the latest. */
  private readonly fillsRead = new Map<string, Fill>();
  private latestFill: Date | undefined;
  /** The loss and profit the latest fresh round measured, and when; `undefined` when it could not. */
  private lastMeasured:
    | { loss: Extract<LossReport, { status: 'measured' }>; pnl: PnlReport; at: Date }
    | undefined;

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
      floorPrice: null,
      held: null,
      bestCompetingBid: null,
      lowestCompetingAsk: null,
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
    const { loss, pnl } = await this.reportLoss();
    await this.topUpWeth();
    for (const run of this.runs) {
      if (isBidRun(run) && !run.task.enabled) await this.countLeftBids(run);
    }
    for (const run of this.runs) {
      if (run.state.status !== 'halted') await this.advance(run, lossLimitReached(loss));
    }
    const finishedAt = this.now();
    this.emit('round', {
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      exposureLimit: this.file.exposureLimit,
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
        this.update(run, { status: 'halted', reason: 'cancelledAll' });
        continue;
      }
      try {
        const snapshot = await this.market.snapshot(scopeOf(run.task), this.startedAt);
        const active = snapshot.ownBids.filter((bid) => bid.active);
        if (active.length > 0) await this.market.cancelBids(active);
        run.commitment = 0n;
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
    const loss = lossReport({ ledger, terms, ethUsd, now, limits });
    const older = tradedCollections(ledger).filter((slug) => !valued.includes(slug));
    const olderTerms = await Promise.allSettled(older.map((slug) => this.market.saleTerms(slug)));
    for (const [index, result] of olderTerms.entries()) {
      if (result.status === 'fulfilled') terms.set(older[index], result.value);
    }
    return { loss, pnl: { ethUsd, collections: pnlOf(ledger, terms) } };
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

  private async advance(run: TaskRun, lossLimitReached: boolean) {
    try {
      if (isBidRun(run)) await this.advanceBid(run, lossLimitReached);
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

  private async advanceBid(run: TaskRun<BidTask>, lossLimitReached: boolean) {
    const snapshot = await this.market.snapshot(scopeOf(run.task), this.startedAt);
    if (!isCrossed(snapshot.floorPrice, snapshot.bestCompetingBid)) {
      run.referenceFloor ??= snapshot.floorPrice;
    }
    run.floorPrice = snapshot.floorPrice;
    run.held = snapshot.held;
    run.bestCompetingBid = snapshot.bestCompetingBid;
    const decision = reconcile({
      task: run.task,
      snapshot,
      now: this.now(),
      referenceFloor: run.referenceFloor,
      exposureAvailable: this.file.exposureLimit - this.committedByOthers(run),
      lossLimitReached,
    });
    const cancelled = new Set(decision.cancel.map((bid) => bid.id));
    const leftUp = snapshot.ownBids.filter((bid) => bid.active && !cancelled.has(bid.id));
    const placements = decision.type === 'bid' ? decision.place : [];
    for (const { price, quantity } of placements) {
      leftUp.push(
        await this.market.placeBid({
          scope: scopeOf(run.task),
          price,
          quantity,
          expiration: new Date(this.now().getTime() + run.task.expirationMinutes * 60_000),
        }),
      );
      this.book(run, leftUp);
    }
    if (decision.cancel.length > 0) await this.market.cancelBids(decision.cancel);
    this.book(run, leftUp);
    if (decision.type === 'bid' && leftUp.length > 0) {
      const top = leftUp.reduce((best, bid) => (bid.price > best.price ? bid : best));
      this.update(run, {
        status: 'bidding',
        bidId: top.id,
        price: top.price,
        offers: leftUp.length,
      });
    }
    if (decision.type === 'wait') this.update(run, { status: 'waiting', reason: decision.reason });
    if (decision.type === 'halt') this.update(run, { status: 'halted', reason: decision.reason });
  }

  /**
   * Books `bids`, the task's bids still live once its decision is carried out, as its orders and
   * its commitment: a bid the marketplace would not cancel yet stays up through a `wait` or beside
   * a kept bid, and still counts against `exposureLimit` for every other task.
   */
  private book(run: TaskRun, bids: OwnBid[]) {
    run.commitment = commitmentOf(bids);
    run.orders = bids.map(bidOrder);
  }

  private async advanceListing(run: TaskRun<ListingTask>, tokenId: bigint) {
    const scope = { slug: run.task.collection, tokenId };
    const listingMarket = await this.market.listingMarket(scope.slug);
    const itemListing = await this.market.itemListing(scope, this.startedAt);
    run.lowestCompetingAsk = listingMarket.lowestCompetingAsk;
    const snapshot = { ...listingMarket, ...itemListing };
    const decision = decideListing({ task: run.task, snapshot, now: this.now() });
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
    const items: { tokenId: bigint; state: ListingItemState }[] = [];
    const orders: LiveOrder[] = [];
    for (const [index, tokenId] of tokenIds.entries()) {
      const itemListing = itemListings[index];
      const scope = { slug, tokenId };
      try {
        if (itemListing.status === 'rejected') throw itemListing.reason;
        const snapshot = { ...listingMarket, ...itemListing.value };
        const decision = decideInventoryItem({ task: run.task, snapshot, now: this.now() });
        if (!decision) continue;
        const { state, listing } = await this.carryOutListing(run.task, scope, decision);
        items.push({ tokenId, state });
        if (listing) orders.push(listingOrder(listing, tokenId));
      } catch (error) {
        items.push({ tokenId, state: { status: 'failing', error: String(error) } });
      }
    }
    run.orders = orders;
    this.update(run, { status: 'listingInventory', items });
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
    state: Exclude<ListingItemState, { status: 'failing' }>;
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

  private committedByOthers(current: TaskRun) {
    return this.runs.reduce((total, run) => (run === current ? total : total + run.commitment), 0n);
  }

  private update(run: TaskRun, state: TaskState) {
    run.state = state;
    this.emit('state', run.task.id, state);
  }
}
