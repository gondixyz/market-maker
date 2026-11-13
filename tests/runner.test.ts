import { describe, expect, spyOn, test } from 'bun:test';

import { type RoundReport, Runner } from '../src/engine/runner';
import { VenueMarket } from '../src/engine/venueMarket';
import { bidOf, eth, FakeMarket, listingTaskJson, tasksFileOf } from './fakeMarket';

const task = (id: string, overrides: object = {}) => ({
  id,
  kind: 'collectionBid',
  collection: 'pudgypenguins',
  pricing: { mode: 'outbid' },
  minPrice: '5',
  maxPrice: '9',
  ...overrides,
});

const NOW = new Date('2030-01-01T00:00:00Z');
const runnerFor = (market: FakeMarket, tasks: object[], overrides: object = {}) =>
  new Runner(market, tasksFileOf(tasks, overrides), NOW, () => NOW);

const openSeaTask = (id: string) =>
  task(id, { venue: 'opensea', pricing: { mode: 'level', level: 2 }, maxItems: 1 });

/** A runner whose bids go to `gondi` or `openSea` by venue, as the CLI wires it. */
const venueRunnerFor = (gondi: FakeMarket, openSea: FakeMarket | undefined, tasks: object[]) =>
  new Runner(
    new VenueMarket(gondi, { gondi, opensea: openSea }),
    tasksFileOf(tasks),
    NOW,
    () => NOW,
  );

describe('Runner', () => {
  test('bids an OpenSea task on the OpenSea venue, at its level', async () => {
    const gondi = new FakeMarket();
    const openSea = new FakeMarket();
    openSea.market.competingBidLevels = [eth('8.5'), eth('8.2'), eth('7')];
    const runner = venueRunnerFor(gondi, openSea, [openSeaTask('ad')]);

    await runner.round();

    expect([openSea.placed.map((bid) => bid.price), gondi.placed]).toEqual([[eth('8.2')], []]);
  });

  test('bids a GONDI task at its level, reading that many levels of the book', async () => {
    const market = new FakeMarket();
    market.market.competingBidLevels = [eth('8.5'), eth('8.2'), eth('7')];
    const runner = runnerFor(market, [task('ad', { pricing: { mode: 'level', level: 2 } })]);

    await runner.round();

    expect(market.placed.map((bid) => bid.price)).toEqual([eth('8.2')]);
    expect(market.snapshotScopes[0]).toEqual({
      kind: 'collection',
      slug: 'pudgypenguins',
      venue: 'gondi',
      levels: 2,
    });
  });

  test('fails an OpenSea task without an OpenSea venue, and runs the rest', async () => {
    const market = new FakeMarket();
    const runner = venueRunnerFor(market, undefined, [openSeaTask('ad'), task('punks')]);

    await runner.round();

    expect([runner.states().get('ad'), market.placed.length]).toEqual([
      {
        status: 'failing',
        error: 'Error: bids on opensea are not set up in this run',
        failures: 1,
      },
      1,
    ]);
  });

  test("withdraws an OpenSea task's offers from the OpenSea venue on cancelAll", async () => {
    const openSea = new FakeMarket();
    openSea.market.competingBidLevels = [eth('8.5'), eth('8.2')];
    const runner = venueRunnerFor(new FakeMarket(), openSea, [openSeaTask('ad')]);

    await runner.round();
    await runner.cancelAll();

    expect(openSea.cancelled).toEqual(['100']);
  });

  test('follows a competitor up to the ceiling, replacing its bid each time', async () => {
    const market = new FakeMarket();
    const runner = runnerFor(market, [task('punks')]);

    await runner.round();
    market.market.bestCompetingBid = eth('8.5');
    await runner.round();
    market.market.bestCompetingBid = eth('9.5');
    await runner.round();
    await runner.round();

    expect(market.placed.map((bid) => bid.price)).toEqual([eth('8.01'), eth('8.51'), eth('9')]);
    expect(market.cancelled).toEqual(['100', '101']);
    expect(runner.states().get('punks')).toEqual({
      status: 'bidding',
      bidId: '102',
      price: eth('9'),
      offers: 1,
    });
  });

  test('adopts a bid left by an earlier run instead of placing a duplicate', async () => {
    const market = new FakeMarket();
    market.ownBids = [bidOf({ id: '5' })];

    await runnerFor(market, [task('punks')]).round();

    expect(market.placed).toEqual([]);
  });

  test('runs a disabled task never, and the others as usual', async () => {
    const market = new FakeMarket();
    const runner = runnerFor(market, [task('off', { enabled: false }), task('on')]);

    await runner.round();

    expect({ placed: market.placed.length, off: runner.states().get('off') }).toEqual({
      placed: 1,
      off: { status: 'halted', reason: 'disabled' },
    });
  });

  test("counts a disabled task's leftover bid against the exposure limit", async () => {
    const market = new FakeMarket();
    await market.placeBid({
      scope: { kind: 'collection', slug: 'pudgypenguins', venue: 'gondi' },
      price: eth('6'),
      quantity: 1,
      expiration: new Date(NOW.getTime() + 3_600_000),
    });
    market.placed = [];
    const runner = runnerFor(
      market,
      [task('off', { enabled: false }), task('on', { collection: 'azuki' })],
      { exposureLimit: '10' },
    );

    await runner.round();

    expect({
      placed: market.placed,
      cancelled: market.cancelled,
      on: runner.states().get('on'),
    }).toEqual({ placed: [], cancelled: [], on: { status: 'waiting', reason: 'exposureLimit' } });
  });

  test('cancel-all still withdraws the bids a disabled task left from an earlier run', async () => {
    const market = new FakeMarket();
    market.ownBids = [bidOf({ id: '5' })];

    await runnerFor(market, [task('punks', { enabled: false })]).cancelAll();

    expect(market.cancelled).toEqual(['5']);
  });

  test('never places past the exposure limit across tasks', async () => {
    const market = new FakeMarket();
    const runner = runnerFor(market, [task('first'), task('second')], { exposureLimit: '10' });

    await runner.round();

    expect(market.placed).toHaveLength(1);
    expect(runner.states().get('second')).toEqual({ status: 'waiting', reason: 'exposureLimit' });
  });

  test('counts a ladder as its top offer against the exposure limit', async () => {
    const market = new FakeMarket();
    const ladder = task('ladder', { ladder: { offers: 3, spacing: '0.5' } });
    const second = task('second', { collection: 'boredapeyachtclub' });
    const runner = runnerFor(market, [ladder, second], { exposureLimit: '16.02' });

    await runner.round();

    expect(market.placed.map((bid) => bid.price)).toEqual([
      eth('8.01'),
      eth('8'),
      eth('7.5'),
      eth('8.01'),
    ]);
    expect(runner.states().get('ladder')).toEqual({
      status: 'bidding',
      bidId: '100',
      price: eth('8.01'),
      offers: 3,
    });
  });

  test('counts an offer a wait leaves up against the exposure limit of the other tasks', async () => {
    const gondi = new FakeMarket();
    const openSea = new FakeMarket();
    openSea.market.competingBidLevels = [eth('8.5'), eth('8.2')];
    const runner = new Runner(
      new VenueMarket(gondi, { gondi, opensea: openSea }),
      tasksFileOf([openSeaTask('ad'), task('punks')], { exposureLimit: '10' }),
      NOW,
      () => NOW,
    );
    await runner.round();
    openSea.ownBids[0].cancellableFrom = new Date(NOW.getTime() + 60_000);
    openSea.market.competingBidLevels = [];

    await runner.round();

    expect([runner.states(), openSea.cancelled, gondi.placed]).toEqual([
      new Map([
        ['ad', { status: 'waiting', reason: 'noPrice' }],
        ['punks', { status: 'waiting', reason: 'exposureLimit' }],
      ]),
      [],
      [],
    ]);
  });

  test('halts on a fill and leaves the task alone afterwards', async () => {
    const market = new FakeMarket();
    const runner = runnerFor(market, [task('punks')]);
    await runner.round();
    market.ownBids[0].executions = 1;
    market.ownBids[0].active = false;

    await runner.round();
    await runner.round();

    expect(runner.states().get('punks')).toEqual({ status: 'halted', reason: 'filled' });
    expect(market.placed).toHaveLength(1);
  });

  test('with maxItems, bids on after a fill until the wallet holds that many', async () => {
    const market = new FakeMarket();
    const runner = runnerFor(market, [task('punks', { maxItems: 2 })]);
    await runner.round();
    market.ownBids[0].executions = 1;
    market.ownBids[0].active = false;
    market.market.held = 1;

    await runner.round();
    market.ownBids[1].executions = 1;
    market.ownBids[1].active = false;
    market.market.held = 2;
    await runner.round();

    expect(market.placed).toHaveLength(2);
    expect(runner.states().get('punks')).toEqual({ status: 'waiting', reason: 'maxItemsHeld' });
  });

  test('counts the fills of a replaced bid, so it never buys past quantity', async () => {
    const market = new FakeMarket();
    const runner = runnerFor(market, [task('punks', { quantity: 3 })]);
    await runner.round();
    market.ownBids[0].executions = 1;
    market.market.bestCompetingBid = eth('8.5');

    await runner.round();
    await runner.round();

    expect(market.placed.map((bid) => bid.quantity)).toEqual([3, 2]);
    expect(market.cancelled).toEqual(['100']);
    expect(runner.states().get('punks')).toMatchObject({ status: 'bidding', bidId: '101' });
  });

  test('keeps the bid through a failed read and recovers on the next round', async () => {
    const market = new FakeMarket();
    const runner = runnerFor(market, [task('punks')]);
    await runner.round();
    market.failNextSnapshot = true;

    await runner.round();
    expect(runner.states().get('punks')).toMatchObject({ status: 'failing', failures: 1 });
    expect(market.cancelled).toEqual([]);

    await runner.round();
    expect(runner.states().get('punks')).toMatchObject({ status: 'bidding', bidId: '100' });
  });

  test('cancel-all withdraws every active bid and halts every task', async () => {
    const market = new FakeMarket();
    const runner = runnerFor(market, [task('first'), task('second', { collection: 'azuki' })]);
    await runner.round();

    await runner.cancelAll();

    expect(market.ownBids).toEqual([]);
    expect(market.cancelled).toEqual(['100', '101']);
    expect([...runner.states().values()]).toEqual([
      { status: 'halted', reason: 'cancelledAll' },
      { status: 'halted', reason: 'cancelledAll' },
    ]);
  });

  test('cancel-all withdraws the other tasks when one cannot be read', async () => {
    const market = new FakeMarket();
    const runner = runnerFor(market, [task('first'), task('second', { collection: 'azuki' })]);
    await runner.round();
    market.failNextSnapshot = true;

    await expect(runner.cancelAll()).rejects.toThrow('first');

    expect(market.cancelled).toEqual(['101']);
    expect(runner.states().get('first')).toMatchObject({ status: 'bidding' });
    expect(runner.states().get('second')).toEqual({ status: 'halted', reason: 'cancelledAll' });
  });

  test('never cancels a bid that would need a transaction', async () => {
    const market = new FakeMarket();
    market.ownBids = [bidOf({ id: '5', cancelsOffChain: false })];
    market.market.bestCompetingBid = eth('8.5');
    const runner = runnerFor(market, [task('punks')]);

    await runner.round();

    expect(market.cancelled).toEqual([]);
    expect(runner.states().get('punks')).toMatchObject({ status: 'failing' });
  });
});

const LOSS_LIMITS = {
  lossLimits: { dailyUsd: 1_000, weeklyUsd: 5_000, since: '2029-12-01T00:00:00Z' },
};

/**
 * A buy of #1 at 10.45 ETH, held while the floor is 10 and fees 5.5%: a 1 ETH loss, $2,000 at the
 * fake rate.
 */
const underwaterBuy = (timestamp: Date) => ({
  slug: 'pudgypenguins',
  tokenId: 1n,
  side: 'buy' as const,
  price: eth('10.45'),
  timestamp,
});

describe('Runner with wrapEth', () => {
  const WRAP = { exposureLimit: '9', wrapEth: { keepEth: '0.05' } };

  test("wraps the ETH a sale paid before bidding, so the round's bid has the WETH", async () => {
    const market = new FakeMarket();
    market.market = { ...market.market, balance: 0n };
    market.balances = { eth: eth('10'), weth: 0n, pending: false };
    const runner = runnerFor(market, [task('punks')], WRAP);
    const wraps: unknown[] = [];
    runner.on('wrap', (report) => wraps.push(report));

    await runner.round();

    expect(market.wrapped).toEqual([eth('9')]);
    expect(wraps).toEqual([{ status: 'wrapped', amount: eth('9') }]);
    expect(market.placed).toHaveLength(1);
  });

  test('wraps nothing without wrapEth', async () => {
    const market = new FakeMarket();
    market.balances = { eth: eth('10'), weth: 0n, pending: false };

    await runnerFor(market, [task('punks')]).round();

    expect(market.wrapped).toEqual([]);
  });

  test('reports a failed wrap and bids on', async () => {
    const market = new FakeMarket();
    market.balances = { eth: eth('10'), weth: 0n, pending: false };
    market.failWrap = true;
    const runner = runnerFor(market, [task('punks')], WRAP);
    const wraps: unknown[] = [];
    runner.on('wrap', (report) => wraps.push(report));

    await runner.round();

    expect(wraps).toEqual([{ status: 'failed', error: 'Error: timed out' }]);
    expect(market.placed).toHaveLength(1);
  });

  test('wraps nothing more while a wrap that timed out is still unmined', async () => {
    const market = new FakeMarket();
    market.balances = { eth: eth('10'), weth: 0n, pending: false };
    market.failWrap = true;
    const runner = runnerFor(market, [task('punks')], WRAP);
    const wraps: unknown[] = [];
    runner.on('wrap', (report) => wraps.push(report));
    await runner.round();
    market.failWrap = false;

    await runner.round();

    expect(wraps).toEqual([{ status: 'failed', error: 'Error: timed out' }]);
    expect(market.wrapped).toEqual([]);
  });
});

describe('Runner with loss limits', () => {
  test('a breach withdraws the bids and keeps the listings', async () => {
    const market = new FakeMarket();
    const runner = runnerFor(market, [task('punks'), listingTaskJson()], LOSS_LIMITS);
    await runner.round();
    market.tradeHistory = [underwaterBuy(NOW)];

    await runner.round();

    expect([...runner.states().values()]).toEqual([
      { status: 'waiting', reason: 'lossLimit' },
      { status: 'listing', listingId: 101, price: eth('9.99') },
    ]);
    expect(market.cancelled).toEqual(['100']);
  });

  test('a read that fails stops the bidding', async () => {
    const market = new FakeMarket();
    market.failFills = true;
    const runner = runnerFor(market, [task('punks')], LOSS_LIMITS);

    await runner.round();

    expect(runner.states().get('punks')).toEqual({ status: 'waiting', reason: 'lossLimit' });
  });

  describe('when a read fails after one that worked', () => {
    /** Runs a round that works, then one whose read fails at each of `secondsLater`. */
    const failingAfter = async (...secondsLater: number[]) => {
      const market = new FakeMarket();
      const started = new Date('2030-01-01T10:00:00Z');
      let now = started;
      const file = tasksFileOf([task('punks')], LOSS_LIMITS);
      const runner = new Runner(market, file, started, () => now);
      const losses: unknown[] = [];
      runner.on('loss', (report) => losses.push(report));
      await runner.round();
      market.failFills = true;
      for (const seconds of secondsLater) {
        now = new Date(started.getTime() + seconds * 1_000);
        await runner.round();
      }
      return { market, runner, loss: losses.at(-1) };
    };

    test('keeps the bid on the loss measured moments ago, and says the read failed', async () => {
      const { market, runner, loss } = await failingAfter(15);

      expect(runner.states().get('punks')?.status).toBe('bidding');
      expect(market.cancelled).toEqual([]);
      expect(loss).toEqual({
        status: 'measured',
        dailyLossUsd: 0,
        weeklyLossUsd: 0,
        reached: false,
        staleReason: 'Error: API unavailable',
      });
    });

    test('stops the bidding once the last measure is older than the grace', async () => {
      const { runner, loss } = await failingAfter(121);

      expect(runner.states().get('punks')).toEqual({ status: 'waiting', reason: 'lossLimit' });
      expect(loss).toEqual({ status: 'unmeasured', reason: 'Error: API unavailable' });
    });

    test('stops the bidding when the outage outlasts the grace', async () => {
      const { runner, loss } = await failingAfter(60, 121);

      expect(runner.states().get('punks')).toEqual({ status: 'waiting', reason: 'lossLimit' });
      expect(loss).toEqual({ status: 'unmeasured', reason: 'Error: API unavailable' });
    });

    test('keeps the bidding stopped after a round that could not value the loss', async () => {
      const market = new FakeMarket();
      const started = new Date('2030-01-01T10:00:00Z');
      market.tradeHistory = [{ ...underwaterBuy(started), price: eth('9') }];
      let now = started;
      const file = tasksFileOf([task('punks')], LOSS_LIMITS);
      const runner = new Runner(market, file, started, () => now);
      const losses: unknown[] = [];
      runner.on('loss', (report) => losses.push(report));
      await runner.round();
      market.terms.set('pudgypenguins', { floorPrice: null, feeBps: 550n });
      now = new Date(started.getTime() + 15_000);
      await runner.round();
      market.failFills = true;
      now = new Date(started.getTime() + 30_000);

      await runner.round();

      expect(runner.states().get('punks')).toEqual({ status: 'waiting', reason: 'lossLimit' });
      expect(losses.at(-1)).toEqual({ status: 'unmeasured', reason: 'Error: API unavailable' });
    });
  });

  test('a new day resumes the bidding once the loss is back under both caps', async () => {
    const market = new FakeMarket();
    const today = new Date('2030-01-01T10:00:00Z');
    let now = today;
    const runner = new Runner(market, tasksFileOf([task('punks')], LOSS_LIMITS), today, () => now);
    market.tradeHistory = [
      underwaterBuy(new Date('2030-01-01T09:00:00Z')),
      { ...underwaterBuy(new Date('2030-01-01T09:30:00Z')), side: 'sell', price: eth('10') },
    ];
    await runner.round();
    now = new Date('2030-01-02T00:00:01Z');

    await runner.round();

    expect(runner.states().get('punks')).toMatchObject({ status: 'bidding' });
  });

  test('re-reads only the last hour of fills, counting each one once', async () => {
    const market = new FakeMarket();
    market.tradeHistory = [underwaterBuy(new Date('2030-01-01T09:00:00Z'))];
    const runner = runnerFor(market, [task('punks')], {
      lossLimits: { ...LOSS_LIMITS.lossLimits, dailyUsd: 3_000 },
    });
    const reports: unknown[] = [];
    runner.on('loss', (report) => reports.push(report));

    await runner.round();
    await runner.round();

    expect(market.fillsReadSince).toEqual([
      new Date('2029-12-01T00:00:00Z'),
      new Date('2030-01-01T08:00:00Z'),
    ]);
    expect(reports[1]).toEqual(reports[0]);
  });

  test('reports the loss every round', async () => {
    const market = new FakeMarket();
    market.tradeHistory = [underwaterBuy(NOW)];
    const runner = runnerFor(market, [task('punks')], LOSS_LIMITS);
    const reports: unknown[] = [];
    runner.on('loss', (report) => reports.push(report));

    await runner.round();

    expect(reports).toEqual([
      { status: 'measured', dailyLossUsd: 2_000, weeklyLossUsd: 2_000, reached: true },
    ]);
  });
});

describe('Runner with listings', () => {
  test('follows a competitor down, leaving each older listing to expire', async () => {
    const market = new FakeMarket();
    const runner = runnerFor(market, [listingTaskJson()]);

    await runner.round();
    market.listingBook.lowestCompetingAsk = eth('9.5');
    await runner.round();
    await runner.round();

    expect(market.placedListings.map((listing) => listing.price)).toEqual([
      eth('9.99'),
      eth('9.49'),
    ]);
    expect(market.cancelled).toEqual([]);
    expect(runner.states().get('pudgy-3950')).toEqual({
      status: 'listing',
      listingId: 101,
      price: eth('9.49'),
    });
  });

  test('waits for the user instead of listing higher than a live listing', async () => {
    const market = new FakeMarket();
    const runner = runnerFor(market, [listingTaskJson()]);
    await runner.round();
    market.listingBook.lowestCompetingAsk = eth('11');

    await runner.round();

    expect(market.placedListings).toHaveLength(1);
    expect(runner.states().get('pudgy-3950')).toEqual({
      status: 'waiting',
      reason: 'needsOnChainCancel',
    });
  });

  test('reports the listing it leaves up while it waits for an on-chain cancel', async () => {
    const market = new FakeMarket();
    const runner = runnerFor(market, [listingTaskJson()]);
    const reports: RoundReport[] = [];
    runner.on('round', (report) => reports.push(report));
    await runner.round();
    market.listingBook.lowestCompetingAsk = eth('11');

    await runner.round();

    expect(reports.at(-1)?.tasks[0].orders.map((order) => order.price)).toEqual([eth('9.99')]);
  });

  test('halts once the listing fills', async () => {
    const market = new FakeMarket();
    const runner = runnerFor(market, [listingTaskJson()]);
    await runner.round();
    market.ownListings[0].executions = 1;
    market.ownListings[0].active = false;

    await runner.round();
    await runner.round();

    expect(runner.states().get('pudgy-3950')).toEqual({ status: 'halted', reason: 'filled' });
    expect(market.placedListings).toHaveLength(1);
  });

  test('leaves the exposure limit to bids', async () => {
    const market = new FakeMarket();
    const runner = runnerFor(market, [listingTaskJson(), task('punks')], { exposureLimit: '9' });

    await runner.round();

    expect(market.placed.map((bid) => bid.price)).toEqual([eth('8.01')]);
  });

  test('cancel-all halts listing tasks without touching their listings', async () => {
    const market = new FakeMarket();
    const runner = runnerFor(market, [listingTaskJson()]);
    await runner.round();

    await runner.cancelAll();

    expect(market.ownListings.every((listing) => listing.active)).toBe(true);
    expect(runner.states().get('pudgy-3950')).toEqual({ status: 'halted', reason: 'cancelledAll' });
  });
});

describe('Runner loop', () => {
  test('a stop during a round schedules no further round', async () => {
    const runner = runnerFor(new FakeMarket(), [task('punks')], { pollSeconds: 5 });
    const scheduled = spyOn(globalThis, 'setTimeout');

    runner.start();
    runner.stop();
    await new Promise((resolve) => setImmediate(resolve));

    expect(scheduled.mock.calls.filter(([, delay]) => delay === 5_000)).toEqual([]);
    scheduled.mockRestore();
  });

  test('cancel-all waits out a round under way before withdrawing', async () => {
    const market = new FakeMarket();
    const runner = runnerFor(market, [task('punks')]);

    runner.start();
    await runner.cancelAll();

    expect(market.ownBids).toEqual([]);
    expect(market.cancelled).toEqual(['100']);
  });
});

describe('Runner with an inventory listing', () => {
  const inventory = () => listingTaskJson({ id: 'pudgy-all', tokenId: undefined });

  test('lists every item the wallet holds, each against the cheapest other listing', async () => {
    const market = new FakeMarket();
    market.heldTokenIds = [1n, 2n];

    await runnerFor(market, [inventory()]).round();

    expect(market.placedListings.map((listing) => listing.scope.tokenId)).toEqual([1n, 2n]);
    expect(market.placedListings.map((listing) => listing.price)).toEqual([
      eth('9.99'),
      eth('9.99'),
    ]);
  });

  test('picks up an item the bot bought and drops one that sold, without halting', async () => {
    const market = new FakeMarket();
    market.heldTokenIds = [1n];
    const runner = runnerFor(market, [inventory()]);
    await runner.round();
    market.ownListings[0].executions = 1;
    market.ownListings[0].active = false;
    market.heldTokenIds = [2n];

    await runner.round();

    expect(market.placedListings.map((listing) => listing.scope.tokenId)).toEqual([1n, 2n]);
    expect(runner.states().get('pudgy-all')).toEqual({
      status: 'listingInventory',
      items: [{ tokenId: 2n, state: { status: 'listing', listingId: 101, price: eth('9.99') } }],
    });
  });

  test('reports why an item waits', async () => {
    const market = new FakeMarket();
    market.heldTokenIds = [1n];
    market.listingBook.approved = false;
    const runner = runnerFor(market, [inventory()]);

    await runner.round();

    expect(runner.states().get('pudgy-all')).toEqual({
      status: 'listingInventory',
      items: [{ tokenId: 1n, state: { status: 'waiting', reason: 'notApproved' } }],
    });
  });

  test('reads the collection once a round, however many items it lists', async () => {
    const market = new FakeMarket();
    market.heldTokenIds = [1n, 2n, 3n];

    await runnerFor(market, [inventory()]).round();

    expect(market.listingMarketReads).toBe(1);
    expect(market.placedListings).toHaveLength(3);
  });

  test('an item that fails to read leaves the others listed', async () => {
    const market = new FakeMarket();
    market.heldTokenIds = [1n, 2n, 3n];
    market.failingTokenIds = [2n];
    const runner = runnerFor(market, [inventory()]);

    await runner.round();

    expect(market.placedListings.map((listing) => listing.scope.tokenId)).toEqual([1n, 3n]);
    expect(runner.states().get('pudgy-all')).toEqual({
      status: 'listingInventory',
      items: [
        { tokenId: 1n, state: { status: 'listing', listingId: 100, price: eth('9.99') } },
        { tokenId: 2n, state: { status: 'failing', error: 'Error: API unavailable' } },
        { tokenId: 3n, state: { status: 'listing', listingId: 101, price: eth('9.99') } },
      ],
    });
  });
});

describe('Runner on a crossed book', () => {
  test('posts no listing and shows why', async () => {
    const market = new FakeMarket();
    market.listingBook = {
      ...market.listingBook,
      lowestCompetingAsk: eth('1'),
      bestCompetingBid: eth('8'),
    };
    const runner = runnerFor(market, [listingTaskJson()]);

    await runner.round();

    expect(market.placedListings).toEqual([]);
    expect(runner.states().get('pudgy-3950')).toEqual({ status: 'waiting', reason: 'crossedBook' });
  });

  test('takes the reference floor from the first clean book, not a crossed one', async () => {
    const market = new FakeMarket();
    market.market = { ...market.market, floorPrice: 6n, bestCompetingBid: eth('8') };
    const runner = runnerFor(market, [task('punks', { haltOnFloorMovePercent: 20 })]);

    await runner.round();
    expect(runner.states().get('punks')).toEqual({ status: 'waiting', reason: 'crossedBook' });

    market.market = { ...market.market, floorPrice: eth('10') };
    await runner.round();

    expect(market.placed.map((bid) => bid.price)).toEqual([eth('8.01')]);
    expect(runner.states().get('punks')).toMatchObject({ status: 'bidding' });
  });
});
