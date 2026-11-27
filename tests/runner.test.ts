import { describe, expect, spyOn, test } from 'bun:test';

import { dayStart } from '../src/engine/pnl';
import { belowBy, nextReference } from '../src/engine/reference';
import { type RoundReport, Runner } from '../src/engine/runner';
import { VenueMarket } from '../src/engine/venueMarket';
import {
  bidOf,
  eth,
  FakeLendingMarket,
  FakeMarket,
  listingTaskJson,
  loanOfferOf,
  tasksFileOf,
} from './fakeMarket';

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

  test('bids a trait task on its trait, as the scope names it', async () => {
    const market = new FakeMarket();
    const trait = { type: 'Background', value: 'Blue' };
    const runner = runnerFor(market, [task('blue', { kind: 'traitBid', trait })]);

    await runner.round();

    expect(market.placed.map((bid) => bid.scope)).toEqual([
      { kind: 'trait', trait, slug: 'pudgypenguins', venue: 'gondi' },
    ]);
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
      eth('7.5'),
      eth('7'),
      eth('8.01'),
    ]);
    expect(runner.states().get('ladder')).toEqual({
      status: 'bidding',
      bidId: '100',
      price: eth('8.01'),
      offers: 3,
    });
  });

  test('counts a GONDI and an OpenSea bid on one collection as the larger one', async () => {
    const gondi = new FakeMarket();
    const openSea = new FakeMarket();
    openSea.market.competingBidLevels = [eth('8.5'), eth('8.2')];
    const runner = new Runner(
      new VenueMarket(gondi, { gondi, opensea: openSea }),
      tasksFileOf(
        [
          task('gondi', { maxItems: 1 }),
          openSeaTask('openSea'),
          task('azuki', { collection: 'azuki' }),
          task('bayc', { collection: 'boredapeyachtclub' }),
        ],
        { exposureLimit: '16.3' },
      ),
      NOW,
      () => NOW,
    );

    const reports: RoundReport[] = [];
    runner.on('round', (report) => reports.push(report));

    await runner.round();

    expect([
      gondi.placed.map((bid) => [bid.scope.slug, bid.price]),
      openSea.placed.map((bid) => bid.price),
      runner.states().get('bayc'),
      reports[0].committed,
    ]).toEqual([
      [
        ['pudgypenguins', eth('8.01')],
        ['azuki', eth('8.01')],
      ],
      [eth('8.2')],
      { status: 'waiting', reason: 'exposureLimit' },
      eth('16.21'),
    ]);
  });

  test('counts an offer a wait leaves up against the exposure limit of the other tasks', async () => {
    const gondi = new FakeMarket();
    const openSea = new FakeMarket();
    openSea.market.competingBidLevels = [eth('8.5'), eth('8.2')];
    const runner = new Runner(
      new VenueMarket(gondi, { gondi, opensea: openSea }),
      tasksFileOf([openSeaTask('ad'), task('punks', { collection: 'azuki' })], {
        exposureLimit: '10',
      }),
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

  test("a collection's own cap withdraws only that collection's bids", async () => {
    const market = new FakeMarket();
    market.tradeHistory = [underwaterBuy(NOW)];
    const runner = runnerFor(market, [task('punks'), task('azuki', { collection: 'azuki' })], {
      lossLimits: {
        perCollection: { dailyFloorPercent: 5, weeklyFloorPercent: 20 },
        since: '2029-12-01T00:00:00Z',
      },
    });

    await runner.round();

    expect(runner.states().get('punks')).toEqual({ status: 'waiting', reason: 'lossLimit' });
    expect(runner.states().get('azuki')).toMatchObject({ status: 'bidding' });
  });

  test.each([
    ['bids on: its loss predates the day and the week', eth('10'), { status: 'bidding' }],
    [
      'stops without the floor the windows started at, counting the whole loss',
      undefined,
      { status: 'waiting', reason: 'lossLimit' },
    ],
  ])('an item bought last week and held underwater since %s', async (_case, floor, state) => {
    const market = new FakeMarket();
    market.historicFloor = floor;
    market.tradeHistory = [underwaterBuy(new Date(NOW.getTime() - 8 * 24 * 60 * 60_000))];
    const runner = runnerFor(market, [task('punks')], LOSS_LIMITS);

    await runner.round();

    expect(runner.states().get('punks')).toMatchObject(state);
  });

  test("counts a carried item's loss when a dust print sits on the window's start", async () => {
    const market = new FakeMarket();
    market.floorHistory = async (_slug, timestamps) =>
      timestamps.map((timestamp) =>
        timestamp.getTime() === dayStart(NOW).getTime() ? eth('0.001') : eth('11'),
      );
    market.tradeHistory = [underwaterBuy(new Date(NOW.getTime() - 8 * 24 * 60 * 60_000))];
    const runner = runnerFor(market, [task('punks')], LOSS_LIMITS);

    await runner.round();

    expect(runner.states().get('punks')).toEqual({ status: 'waiting', reason: 'lossLimit' });
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
        collections: [],
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
      {
        status: 'measured',
        dailyLossUsd: 2_000,
        weeklyLossUsd: 2_000,
        reached: true,
        collections: [
          {
            slug: 'pudgypenguins',
            dailyLoss: eth('1'),
            weeklyLoss: eth('1'),
            dailyLimit: null,
            weeklyLimit: null,
            reached: false,
          },
        ],
      },
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

  test('lowers each item from when this run first found it held', async () => {
    const market = new FakeMarket();
    market.heldTokenIds = [1n];
    let now = NOW;
    const decaying = inventory();
    const file = tasksFileOf([
      {
        ...decaying,
        pricing: { mode: 'fixed', price: '12' },
        decay: { percent: 10, everyHours: 1 },
      },
    ]);
    const runner = new Runner(market, file, NOW, () => now);
    await runner.round();
    now = new Date(NOW.getTime() + 60 * 60_000);
    market.heldTokenIds = [1n, 2n];

    await runner.round();

    expect(market.placedListings.map((listing) => [listing.scope.tokenId, listing.price])).toEqual([
      [1n, eth('12')],
      [1n, eth('10.8')],
      [2n, eth('12')],
    ]);
  });

  test('starts an item that left the wallet and came back at the full price again', async () => {
    const market = new FakeMarket();
    market.heldTokenIds = [1n];
    let now = NOW;
    const file = tasksFileOf([
      {
        ...inventory(),
        pricing: { mode: 'fixed', price: '12' },
        decay: { percent: 10, everyHours: 1 },
      },
    ]);
    const runner = new Runner(market, file, NOW, () => now);
    await runner.round();
    now = new Date(NOW.getTime() + 2 * 60 * 60_000);
    market.heldTokenIds = [];
    await runner.round();
    market.heldTokenIds = [1n];

    await runner.round();

    expect(market.placedListings.at(-1)?.price).toEqual(eth('12'));
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

describe('Runner with an OpenSea listing', () => {
  const mirrored = (openSeaListing: object = {}) =>
    listingTaskJson({ id: 'pudgy-all', tokenId: undefined, openSeaListing });

  test('lists each held item on OpenSea at the markup over its GONDI listing', async () => {
    const gondi = new FakeMarket();
    const openSea = new FakeMarket();
    gondi.heldTokenIds = [1n, 2n];
    const reports: unknown[] = [];
    const runner = venueRunnerFor(gondi, openSea, [mirrored({ markupPercent: 5 })]);
    runner.on('mirror', (report) => reports.push(report));

    await runner.round();

    expect(openSea.placedMirrors.map(({ scope, price }) => [scope.tokenId, price])).toEqual([
      [1n, eth('10.4895')],
      [2n, eth('10.4895')],
    ]);
    expect(reports).toEqual([
      { status: 'listed', taskId: 'pudgy-all', tokenId: 1n, price: eth('10.4895') },
      { status: 'listed', taskId: 'pudgy-all', tokenId: 2n, price: eth('10.4895') },
    ]);
  });

  test('keeps the OpenSea listing while the GONDI one stands', async () => {
    const gondi = new FakeMarket();
    const openSea = new FakeMarket();
    gondi.heldTokenIds = [1n];
    const runner = venueRunnerFor(gondi, openSea, [mirrored()]);
    await runner.round();

    await runner.round();

    expect(openSea.placedMirrors).toHaveLength(1);
    expect(openSea.cancelledMirrors).toEqual([]);
  });

  test('follows a cheaper GONDI listing and cancels the older OpenSea one', async () => {
    const gondi = new FakeMarket();
    const openSea = new FakeMarket();
    gondi.heldTokenIds = [1n];
    const runner = venueRunnerFor(gondi, openSea, [mirrored()]);
    await runner.round();
    gondi.listingBook = { ...gondi.listingBook, lowestCompetingAsk: eth('9.5') };

    await runner.round();

    expect(openSea.placedMirrors.map((listing) => listing.price)).toEqual([
      eth('10.2897'),
      eth('9.7747'),
    ]);
    expect(openSea.cancelledMirrors).toEqual(['mirror-100']);
  });

  test('cancels the OpenSea listing of an item the wallet no longer holds', async () => {
    const gondi = new FakeMarket();
    const openSea = new FakeMarket();
    gondi.heldTokenIds = [1n];
    const runner = venueRunnerFor(gondi, openSea, [mirrored()]);
    await runner.round();
    gondi.heldTokenIds = [];

    await runner.round();

    expect(openSea.cancelledMirrors).toEqual(['mirror-100']);
    expect(openSea.mirrors).toEqual([]);
  });

  test('leaves the OpenSea listing of an item whose GONDI read fails', async () => {
    const gondi = new FakeMarket();
    const openSea = new FakeMarket();
    gondi.heldTokenIds = [1n];
    const runner = venueRunnerFor(gondi, openSea, [mirrored()]);
    await runner.round();
    gondi.failingTokenIds = [1n];

    await runner.round();

    expect(openSea.cancelledMirrors).toEqual([]);
  });

  test('keeps the OpenSea listing when refreshing the live GONDI listing fails', async () => {
    const gondi = new FakeMarket();
    const openSea = new FakeMarket();
    gondi.heldTokenIds = [1n];
    const runner = venueRunnerFor(gondi, openSea, [mirrored()]);
    await runner.round();
    gondi.ownListings[0].expiration = new Date(NOW.getTime() + 60_000);
    gondi.failPlaceListing = true;

    await runner.round();

    expect([openSea.placedMirrors.length, openSea.cancelledMirrors]).toEqual([1, []]);
  });

  test('a failed OpenSea read is reported and leaves the GONDI listings as they are', async () => {
    const gondi = new FakeMarket();
    const openSea = new FakeMarket();
    openSea.failMirrors = true;
    gondi.heldTokenIds = [1n];
    const reports: unknown[] = [];
    const runner = venueRunnerFor(gondi, openSea, [mirrored()]);
    runner.on('mirror', (report) => reports.push(report));

    await runner.round();

    expect(gondi.placedListings).toHaveLength(1);
    expect(reports).toEqual([
      {
        status: 'failed',
        taskId: 'pudgy-all',
        tokenId: undefined,
        error: 'Error: OpenSea unavailable',
      },
    ]);
  });

  test('reads OpenSea for a collection it holds nothing of only while a listing is left there', async () => {
    const gondi = new FakeMarket();
    const openSea = new FakeMarket();
    gondi.heldTokenIds = [1n];
    let reads = 0;
    const read = openSea.mirrorListings.bind(openSea);
    openSea.mirrorListings = async () => {
      reads++;
      return read();
    };
    const runner = venueRunnerFor(gondi, openSea, [mirrored()]);
    await runner.round();
    gondi.heldTokenIds = [];

    await runner.round();
    await runner.round();
    await runner.round();

    expect([reads, openSea.cancelledMirrors]).toEqual([3, ['mirror-100']]);
  });

  test('lists nothing on OpenSea without the option or without a key', async () => {
    const gondi = new FakeMarket();
    const openSea = new FakeMarket();
    gondi.heldTokenIds = [1n];

    await venueRunnerFor(gondi, openSea, [
      listingTaskJson({ id: 'pudgy-all', tokenId: undefined }),
    ]).round();
    await venueRunnerFor(gondi, undefined, [mirrored()]).round();

    expect(openSea.placedMirrors).toEqual([]);
  });
});

describe('Runner with loan offers', () => {
  const lending = (loanOffer: object = {}) =>
    listingTaskJson({ id: 'pudgy-all', tokenId: undefined, loanOffer });
  const THIRTY_DAYS = 30n * 86_400n;

  test('offers a loan against each listed item, a share of its GONDI listing price', async () => {
    const market = new FakeLendingMarket();
    market.heldTokenIds = [1n, 2n];
    const reports: unknown[] = [];
    const runner = runnerFor(market, [
      lending({ principalPercent: 70, aprPercent: 8, originationFeePercent: 1, durationDays: 30 }),
    ]);
    runner.on('lend', (report) => reports.push(report));

    await runner.round();

    expect(market.lending.placed).toEqual([
      {
        scope: { slug: 'pudgypenguins', tokenId: 1n },
        principal: eth('6.99'),
        aprBps: 800n,
        durationSeconds: THIRTY_DAYS,
        fee: eth('0.0699'),
        expiration: new Date(NOW.getTime() + 10 * 60_000),
      },
      {
        scope: { slug: 'pudgypenguins', tokenId: 2n },
        principal: eth('6.99'),
        aprBps: 800n,
        durationSeconds: THIRTY_DAYS,
        fee: eth('0.0699'),
        expiration: new Date(NOW.getTime() + 10 * 60_000),
      },
    ]);
    expect(reports).toEqual([
      {
        status: 'offered',
        taskId: 'pudgy-all',
        tokenId: 1n,
        principal: eth('6.99'),
        aprBps: 800n,
        durationSeconds: THIRTY_DAYS,
        fee: eth('0.0699'),
      },
      {
        status: 'offered',
        taskId: 'pudgy-all',
        tokenId: 2n,
        principal: eth('6.99'),
        aprBps: 800n,
        durationSeconds: THIRTY_DAYS,
        fee: eth('0.0699'),
      },
    ]);
  });

  test('keeps the offer while the listing stands, and reprices with it, hiding the old one', async () => {
    const market = new FakeLendingMarket();
    market.heldTokenIds = [1n];
    const runner = runnerFor(market, [lending()]);
    await runner.round();
    await runner.round();
    market.listingBook = { ...market.listingBook, lowestCompetingAsk: eth('9.5') };

    await runner.round();

    expect([market.lending.placed.map((offer) => offer.principal), market.lending.hidden]).toEqual([
      [eth('8.99'), eth('8.54')],
      ['0xloan:1'],
    ]);
  });

  test('hides the offer of an item the wallet no longer holds, and then stops reading', async () => {
    const market = new FakeLendingMarket();
    market.heldTokenIds = [1n];
    let reads = 0;
    const read = market.lending.loanBook.bind(market.lending);
    market.lending.loanBook = async () => {
      reads++;
      return read();
    };
    const runner = runnerFor(market, [lending()]);
    await runner.round();
    market.heldTokenIds = [];

    await runner.round();
    await runner.round();
    await runner.round();

    expect([market.lending.hidden, reads]).toEqual([['0xloan:1'], 3]);
  });

  test('stops reading once only expired offers are left, which nothing hides', async () => {
    const market = new FakeLendingMarket();
    market.heldTokenIds = [1n];
    let reads = 0;
    const read = market.lending.loanBook.bind(market.lending);
    market.lending.loanBook = async () => {
      reads++;
      return read();
    };
    const runner = runnerFor(market, [lending()]);
    await runner.round();
    market.heldTokenIds = [];
    market.lending.offers = [loanOfferOf({ expiration: NOW })];

    await runner.round();
    await runner.round();

    expect([market.lending.hidden, reads]).toEqual([[], 2]);
  });

  test('leaves the offer of an item whose GONDI read fails', async () => {
    const market = new FakeLendingMarket();
    market.heldTokenIds = [1n];
    const runner = runnerFor(market, [lending()]);
    await runner.round();
    market.failingTokenIds = [1n];

    await runner.round();

    expect(market.lending.hidden).toEqual([]);
  });

  test('reports a missing allowance instead of offering', async () => {
    const market = new FakeLendingMarket();
    market.heldTokenIds = [1n];
    market.lending.allowance = eth('1');
    const reports: unknown[] = [];
    const runner = runnerFor(market, [lending()]);
    runner.on('lend', (report) => reports.push(report));

    await runner.round();

    expect([market.lending.placed, reports]).toEqual([
      [],
      [{ status: 'waiting', taskId: 'pudgy-all', tokenId: 1n, reason: 'insufficientAllowance' }],
    ]);
  });

  test('a failed read is reported and leaves the GONDI listings as they are', async () => {
    const market = new FakeLendingMarket();
    market.heldTokenIds = [1n];
    market.lending.failReads = true;
    const reports: unknown[] = [];
    const runner = runnerFor(market, [lending()]);
    runner.on('lend', (report) => reports.push(report));

    await runner.round();

    expect(market.placedListings).toHaveLength(1);
    expect(reports).toEqual([
      {
        status: 'failed',
        taskId: 'pudgy-all',
        tokenId: undefined,
        error: 'Error: loan offers unavailable',
      },
    ]);
  });

  test('does not draw on exposureLimit', async () => {
    const market = new FakeLendingMarket();
    market.heldTokenIds = [1n];
    const runner = runnerFor(market, [lending(), task('bid')], { exposureLimit: '9' });

    await runner.round();

    expect([market.lending.placed.length, market.ownBids.length]).toEqual([1, 1]);
  });

  test('cancel-all hides the visible offers', async () => {
    const market = new FakeLendingMarket();
    market.lending.offers = [
      loanOfferOf({ id: '0xloan:7' }),
      loanOfferOf({ id: '0xloan:8', hidden: true }),
      loanOfferOf({ id: '0xloan:9', expiration: NOW }),
    ];

    await runnerFor(market, [lending()]).cancelAll();

    expect(market.lending.hidden).toEqual(['0xloan:7']);
  });

  test('offers nothing without the option or on a market that does not lend', async () => {
    const lendingMarket = new FakeLendingMarket();
    lendingMarket.heldTokenIds = [1n];
    const plain = new FakeMarket();
    plain.heldTokenIds = [1n];

    await runnerFor(lendingMarket, [
      listingTaskJson({ id: 'pudgy-all', tokenId: undefined }),
    ]).round();
    await runnerFor(plain, [lending()]).round();

    expect([lendingMarket.lending.placed, plain.placedListings.length]).toEqual([[], 1]);
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

describe('Runner with a bid exit', () => {
  const exitTask = (bidExit: object = {}) =>
    listingTaskJson({ id: 'pudgy-all', tokenId: undefined, bidExit });
  const bought = (tokenId: bigint) => ({
    slug: 'pudgypenguins',
    tokenId,
    side: 'buy' as const,
    price: eth('9.5'),
    timestamp: new Date('2029-12-31T00:00:00Z'),
  });
  const marketHolding = (tokenIds: bigint[]) => {
    const market = new FakeMarket();
    market.heldTokenIds = tokenIds;
    market.tradeHistory = tokenIds.map(bought);
    market.exitBid = { id: '0xoffer', venue: 'opensea', netPrice: eth('9.6') };
    return market;
  };

  test('sells a held item into the offer over its cost instead of listing it, once', async () => {
    const market = marketHolding([1n]);
    const runner = runnerFor(market, [exitTask()], LOSS_LIMITS);
    const exits: unknown[] = [];
    runner.on('exit', (report) => exits.push(report));

    await runner.round();
    await runner.round();

    expect(market.exitSales).toEqual([
      {
        scope: { slug: 'pudgypenguins', tokenId: 1n },
        offer: { id: '0xoffer', venue: 'opensea', netPrice: eth('9.6') },
        minProceeds: eth('9.5'),
      },
    ]);
    expect(market.placedListings).toEqual([]);
    expect(exits).toEqual([
      {
        status: 'sold',
        taskId: 'pudgy-all',
        tokenId: 1n,
        venue: 'opensea',
        netPrice: eth('9.6'),
        reason: 'profit',
      },
    ]);
  });

  test('sells one item a round, and no more than maxPerDay a day', async () => {
    const market = marketHolding([1n, 2n, 3n]);
    const runner = runnerFor(market, [exitTask({ maxPerDay: 2 })], LOSS_LIMITS);

    await runner.round();
    expect(market.exitSales.map((sale) => sale.scope.tokenId)).toEqual([1n]);
    expect(market.placedListings.map((listing) => listing.scope.tokenId)).toEqual([2n, 3n]);
    await runner.round();
    await runner.round();

    expect(market.exitSales.map((sale) => sale.scope.tokenId)).toEqual([1n, 2n]);
  });

  test('counts a failed sale against maxPerDay', async () => {
    const market = marketHolding([1n]);
    market.failExit = true;
    const runner = runnerFor(market, [exitTask({ maxPerDay: 1 })], LOSS_LIMITS);
    await runner.round();
    market.failExit = false;

    await runner.round();

    expect(market.exitSales).toEqual([]);
  });

  test('tries one sale a round, a failed one included', async () => {
    const market = marketHolding([1n, 2n]);
    market.failExit = true;
    const runner = runnerFor(market, [exitTask()], LOSS_LIMITS);
    const exits: unknown[] = [];
    runner.on('exit', (report) => exits.push(report));

    await runner.round();

    expect(exits).toHaveLength(1);
    expect(market.placedListings.map((listing) => listing.scope.tokenId)).toEqual([1n, 2n]);
  });

  test('lists an item whose sale failed, and reports why', async () => {
    const market = marketHolding([1n]);
    market.failExit = true;
    const runner = runnerFor(market, [exitTask()], LOSS_LIMITS);
    const exits: unknown[] = [];
    runner.on('exit', (report) => exits.push(report));

    await runner.round();

    expect(market.placedListings.map((listing) => listing.scope.tokenId)).toEqual([1n]);
    expect(exits).toEqual([
      { status: 'failed', taskId: 'pudgy-all', tokenId: 1n, error: 'Error: reverted' },
    ]);
  });

  test('holds while the wallet’s own bid on the collection would buy the item back dearer', async () => {
    const market = marketHolding([1n]);
    market.market.bestCompetingBid = eth('8.5');
    const bid = task('pudgy-buy', { maxPrice: '9.7', pricing: { mode: 'fixed', price: '9.65' } });

    await runnerFor(market, [bid, exitTask()], LOSS_LIMITS).round();

    expect(market.placed.map((placed) => placed.price)).toEqual([eth('9.65')]);
    expect(market.exitSales).toEqual([]);
  });

  test.each([
    ['holds while the collection’s bids can still buy', [1n], 0],
    ['sells once the collection’s bids hold their maxItems', [1n, 2n], 1],
  ])('with a stop loss in reach, %s', async (_name, tokenIds, sales) => {
    const market = marketHolding(tokenIds);
    market.exitBid = { id: '0xoffer', venue: 'gondi', netPrice: eth('9.45') };
    const bid = task('pudgy-buy', { maxItems: 2 });

    await runnerFor(market, [bid, exitTask()], LOSS_LIMITS).round();

    expect(market.exitSales).toHaveLength(sales);
  });

  test.each([
    [
      'holds under the bid a sale would let the collection place again',
      2,
      eth('100'),
      'maxItemsHeld' as const,
      0,
    ],
    [
      'sells while the bid waits on an allowance no sale restores',
      1,
      0n,
      'insufficientAllowance' as const,
      1,
    ],
  ])('with a stop loss in reach, %s', async (_name, held, allowance, reason, sales) => {
    const market = marketHolding([1n, 2n]);
    market.market.held = held;
    market.market.allowance = allowance;
    market.market.bestCompetingBid = eth('8.5');
    market.exitBid = { id: '0xoffer', venue: 'gondi', netPrice: eth('9.45') };
    const bid = task('pudgy-buy', {
      maxItems: 2,
      maxPrice: '9.7',
      pricing: { mode: 'fixed', price: '9.65' },
    });
    const runner = runnerFor(market, [bid, exitTask()], LOSS_LIMITS);

    await runner.round();

    expect(runner.states().get('pudgy-buy')).toEqual({ status: 'waiting', reason });
    expect(market.exitSales).toHaveLength(sales);
  });

  test('takes a profit under the bid’s target when the sale leaves the collection at maxItems', async () => {
    const market = marketHolding([1n, 2n, 3n]);
    market.market.held = 3;
    market.market.bestCompetingBid = eth('8.5');
    const bid = task('pudgy-buy', {
      maxItems: 2,
      maxPrice: '9.7',
      pricing: { mode: 'fixed', price: '9.65' },
    });

    await runnerFor(market, [bid, exitTask()], LOSS_LIMITS).round();

    expect(market.exitSales).toHaveLength(1);
  });

  test('takes a profit under the target of a bid stopped by lossLimits', async () => {
    const market = marketHolding([1n, 2n]);
    market.tradeHistory = [
      { ...bought(1n), price: eth('10.45') },
      { ...bought(2n), price: eth('9.5') },
    ];
    market.market.bestCompetingBid = eth('8.5');
    const bid = task('pudgy-buy', {
      maxItems: 3,
      maxPrice: '9.7',
      pricing: { mode: 'fixed', price: '9.65' },
    });
    const runner = runnerFor(market, [bid, exitTask()], LOSS_LIMITS);

    await runner.round();

    expect(runner.states().get('pudgy-buy')).toEqual({ status: 'waiting', reason: 'lossLimit' });
    expect(market.exitSales.map((sale) => sale.scope.tokenId)).toEqual([2n]);
  });

  test('sells at a loss once a bid task without maxItems has bought its quantity', async () => {
    const market = marketHolding([1n]);
    market.exitBid = { id: '0xoffer', venue: 'gondi', netPrice: eth('9.45') };
    const runner = runnerFor(market, [task('pudgy-buy'), exitTask()], LOSS_LIMITS);
    await runner.round();
    expect(market.exitSales).toEqual([]);
    market.ownBids[0].executions = 1;
    market.ownBids[0].active = false;

    await runner.round();

    expect(runner.states().get('pudgy-buy')).toEqual({ status: 'halted', reason: 'filled' });
    expect(market.exitSales).toHaveLength(1);
  });

  test('keeps listing an item bought before lossLimits.since, whose cost is unknown', async () => {
    const market = marketHolding([1n]);
    market.tradeHistory = [];

    await runnerFor(market, [exitTask()], LOSS_LIMITS).round();

    expect(market.exitSales).toEqual([]);
    expect(market.placedListings.map((listing) => listing.scope.tokenId)).toEqual([1n]);
  });
});

describe('Runner with a resale bid', () => {
  const exitTask = listingTaskJson({ id: 'pudgy-all', tokenId: undefined, bidExit: {} });
  const resaleTask = (id = 'pudgy-buy', overrides: object = {}) =>
    task(id, { maxPrice: '9.7', maxItems: 1, resaleBid: {}, ...overrides });
  const marketAtMaxItems = (held = 1) => {
    const market = new FakeMarket();
    market.market = { ...market.market, held };
    market.heldTokenIds = [];
    market.exitBid = { id: '0xoffer', venue: 'opensea', netPrice: eth('9.6') };
    return market;
  };
  const resaleRunner = (market: FakeMarket, tasks: object[], resaleLimit = '10') =>
    runnerFor(market, tasks, { ...LOSS_LIMITS, resaleLimit });

  test('keeps one offer at a price the bid exit resells at a profit, apart from exposureLimit', async () => {
    const market = marketAtMaxItems();
    const runner = resaleRunner(market, [resaleTask(), exitTask]);
    const reports: RoundReport[] = [];
    runner.on('round', (report) => reports.push(report));

    await runner.round();

    expect(market.placed.map(({ price, quantity }) => ({ price, quantity }))).toEqual([
      { price: eth('9.41'), quantity: 1 },
    ]);
    expect(runner.states().get('pudgy-buy')).toMatchObject({
      status: 'bidding',
      price: eth('9.41'),
      resale: 'maxItemsHeld',
    });
    expect(reports[0].committed).toBe(0n);
    expect(reports[0].tasks[0].resaleCommitment).toBe(eth('9.41'));
  });

  test.each([
    ['when the price does not fit in resaleLimit', marketAtMaxItems(), '9'],
    ['while an item an earlier offer bought is not sold yet', marketAtMaxItems(2), '10'],
  ])('waits %s', async (_name, market, resaleLimit) => {
    const runner = resaleRunner(market, [resaleTask(), exitTask], resaleLimit);

    await runner.round();

    expect(market.placed).toEqual([]);
    expect(runner.states().get('pudgy-buy')).toEqual({ status: 'waiting', reason: 'maxItemsHeld' });
  });

  test('places no other offer while the item one bought is unsold, under maxHeldValue too', async () => {
    const market = marketAtMaxItems();
    const bid = resaleTask('pudgy-buy', { maxItems: undefined, maxHeldValue: '15' });
    const runner = resaleRunner(market, [bid, exitTask]);
    await runner.round();
    market.ownBids[0].executions = 1;
    market.ownBids[0].active = false;
    market.market = { ...market.market, held: 2 };

    await runner.round();
    expect(market.placed).toHaveLength(1);
    expect(runner.states().get('pudgy-buy')).toEqual({ status: 'waiting', reason: 'maxHeldValue' });

    market.market = { ...market.market, held: 1 };
    await runner.round();
    expect(market.placed).toHaveLength(2);
  });

  test('places no offer on the collection from another task while the item is unsold', async () => {
    const gondi = marketAtMaxItems();
    const openSea = marketAtMaxItems();
    const valueCapped = { maxItems: 10, maxHeldValue: '15' };
    const runner = new Runner(
      new VenueMarket(gondi, { gondi, opensea: openSea }),
      tasksFileOf(
        [
          resaleTask('first', valueCapped),
          resaleTask('second', { ...valueCapped, venue: 'opensea' }),
          exitTask,
        ],
        { ...LOSS_LIMITS, resaleLimit: '10' },
      ),
      NOW,
      () => NOW,
    );
    const holding = (held: number) => {
      gondi.market = { ...gondi.market, held };
      openSea.market = { ...openSea.market, held };
    };
    await runner.round();
    expect([gondi.placed.length, openSea.placed.length]).toEqual([1, 0]);
    gondi.ownBids[0].executions = 1;
    gondi.ownBids[0].active = false;
    holding(2);

    await runner.round();
    expect([gondi.placed.length, openSea.placed.length]).toEqual([1, 0]);

    holding(1);
    await runner.round();
    expect(gondi.placed.length + openSea.placed.length).toBe(2);
  });

  test('leaves the offer to the other venue when the best other bid is on its own', async () => {
    const gondi = marketAtMaxItems();
    const openSea = marketAtMaxItems();
    gondi.exitBid = { id: 'gondi-offer', venue: 'gondi', netPrice: eth('9.6') };
    openSea.exitBid = null;
    const runner = new Runner(
      new VenueMarket(gondi, { gondi, opensea: openSea }),
      tasksFileOf(
        [resaleTask('gondi-buy'), resaleTask('opensea-buy', { venue: 'opensea' }), exitTask],
        { ...LOSS_LIMITS, resaleLimit: '10' },
      ),
      NOW,
      () => NOW,
    );

    await runner.round();

    expect(gondi.placed).toEqual([]);
    expect(openSea.placed.map((placed) => placed.price)).toEqual([eth('9.41')]);
    expect(runner.states().get('gondi-buy')).toEqual({ status: 'waiting', reason: 'maxItemsHeld' });
  });

  test.each([
    ['keeps the resale offer at a loss cap it measured', false, 1],
    ['keeps none at a loss cap it could not measure', true, 0],
  ])('%s', async (_name, failFills, placed) => {
    const market = marketAtMaxItems(0);
    market.tradeHistory = [underwaterBuy(NOW)];
    market.failFills = failFills;

    const runner = resaleRunner(market, [resaleTask('pudgy-buy', { maxItems: 2 }), exitTask]);
    await runner.round();

    expect(market.placed).toHaveLength(placed);
    if (placed) {
      expect(runner.states().get('pudgy-buy')).toMatchObject({ resale: 'lossLimit' });
    }
  });

  test('still stop-loss sells while the resale offer stands in for a measured loss cap', async () => {
    const market = marketAtMaxItems();
    market.heldTokenIds = [1n];
    market.tradeHistory = [underwaterBuy(new Date(NOW.getTime() - 2 * 60 * 60_000))];
    const exit = listingTaskJson({
      id: 'pudgy-all',
      tokenId: undefined,
      bidExit: { afterHours: 1, maxLossPercent: 10 },
    });
    const runner = resaleRunner(market, [resaleTask('pudgy-buy', { maxItems: 2 }), exit]);

    await runner.round();

    expect(runner.states().get('pudgy-buy')).toMatchObject({ resale: 'lossLimit' });
    expect(market.exitSales.map((sale) => sale.scope.tokenId)).toEqual([1n]);
  });

  test('keeps one offer per collection', async () => {
    const market = marketAtMaxItems();

    await resaleRunner(market, [resaleTask('first'), resaleTask('second'), exitTask]).round();

    expect(market.placed).toHaveLength(1);
  });

  test('reads the offer once a round for the resale bid and the bid exit together', async () => {
    const market = marketAtMaxItems();
    const reads = spyOn(market, 'exitOffer');
    market.heldTokenIds = [7n];

    await resaleRunner(market, [resaleTask(), exitTask]).round();

    expect(reads).toHaveBeenCalledTimes(1);
  });

  test('withdraws the resale offer once the task can bid as usual again', async () => {
    const market = marketAtMaxItems();
    const runner = resaleRunner(market, [resaleTask(), exitTask]);
    await runner.round();
    market.market = { ...market.market, held: 0 };

    await runner.round();

    expect(market.placed.map((placed) => placed.price)).toEqual([eth('9.41'), eth('8.01')]);
    expect(market.cancelled).toHaveLength(1);
    expect(market.ownBids.map((bid) => bid.price)).toEqual([eth('8.01')]);
    expect(runner.states().get('pudgy-buy')).not.toHaveProperty('resale');
  });

  test('keeps no resale offer once bidExit has tried its sales for the day', async () => {
    const market = marketAtMaxItems();
    market.heldTokenIds = [7n];
    market.failExit = true;
    market.tradeHistory = [
      {
        slug: 'pudgypenguins',
        tokenId: 7n,
        side: 'buy',
        price: eth('9'),
        timestamp: new Date('2029-12-31T00:00:00Z'),
      },
    ];
    const exit = listingTaskJson({
      id: 'pudgy-all',
      tokenId: undefined,
      bidExit: { maxPerDay: 1 },
    });
    const runner = resaleRunner(market, [exit, resaleTask()]);

    await runner.round();

    expect(market.placed).toEqual([]);
  });
});

describe('Runner with pricing safeguards', () => {
  const floorBid = (overrides: object = {}) =>
    task('pudgy-buy', { pricing: { mode: 'floor', steps: 1 }, maxPrice: '20', ...overrides });

  test("seeds a bid's reference from the floor history, so a jump does not lift the bid", async () => {
    const market = new FakeMarket();
    market.historicFloor = eth('9');

    await runnerFor(market, [floorBid({ reference: { belowPercent: 2 } })]).round();

    expect(market.placed.map((bid) => bid.price)).toEqual([eth('8.84')]);
  });

  test('starts the reference at the first floor without a history', async () => {
    const market = new FakeMarket();

    await runnerFor(market, [floorBid({ reference: { belowPercent: 2 } })]).round();

    expect(market.placed.map((bid) => bid.price)).toEqual([eth('9.8')]);
  });

  test('lists an item at no less than it cost once fees are paid', async () => {
    const market = new FakeMarket();
    market.heldTokenIds = [1n, 2n];
    market.tradeHistory = [underwaterBuy(NOW)];
    const inventory = listingTaskJson({ id: 'pudgy-all', tokenId: undefined, aboveCost: {} });

    await runnerFor(market, [inventory], LOSS_LIMITS).round();

    expect(market.placedListings.map((listing) => [listing.scope.tokenId, listing.price])).toEqual([
      [1n, 11058201058201058202n],
      [2n, eth('9.99')],
    ]);
  });

  test("leaves a crossed book's dust ask out of a listing's reference", async () => {
    const market = new FakeMarket();
    let now = NOW;
    const hoursLater = (hours: number) => new Date(NOW.getTime() + hours * 60 * 60_000);
    const file = tasksFileOf([listingTaskJson({ reference: { maxBelowPercent: 1 } })]);
    const runner = new Runner(market, file, NOW, () => now);
    await runner.round();
    market.listingBook = {
      ...market.listingBook,
      lowestCompetingAsk: eth('0.01'),
      bestCompetingBid: eth('5'),
    };
    for (const hours of [2, 4, 6]) {
      now = hoursLater(hours);
      await runner.round();
    }
    market.listingBook = {
      ...market.listingBook,
      lowestCompetingAsk: eth('9'),
      bestCompetingBid: null,
    };
    market.ownListings = [];
    now = hoursLater(6);

    await runner.round();

    const average = nextReference({ price: eth('10'), at: NOW }, eth('9'), now, 24).price;
    expect(market.placedListings.at(-1)?.price).toBe(belowBy(average, 1));
  });

  test('sits above a cheapest competing listing on GONDI', async () => {
    const market = new FakeMarket();
    market.listingBook = { ...market.listingBook, lowestCompetingAskOnGondi: true };

    await runnerFor(market, [listingTaskJson({ behindGondi: { percent: 1 } })]).round();

    expect(market.placedListings.map((listing) => listing.price)).toEqual([eth('10.1')]);
  });
});
