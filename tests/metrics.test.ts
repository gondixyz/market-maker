import { describe, expect, test } from 'bun:test';

import { metricsText } from '../src/engine/metrics';
import { type RoundReport, Runner } from '../src/engine/runner';
import { eth, FakeMarket, listingTaskJson, tasksFileOf } from './fakeMarket';

const NOW = new Date('2030-01-01T00:00:00Z');

const bidTask = {
  id: 'pudgy-bid',
  kind: 'collectionBid',
  collection: 'pudgypenguins',
  pricing: { mode: 'outbid' },
  minPrice: '5',
  maxPrice: '9',
  maxHeldValue: '30',
};

const LOSS_LIMITS = {
  lossLimits: { dailyUsd: 3_000, weeklyUsd: 10_000, since: '2029-12-01T00:00:00Z' },
};

/** The report of one round over `tasks`, with the wallet holding two items and one buy. */
const reportOf = async (tasks: object[], overrides: object = {}) => {
  const market = new FakeMarket();
  market.market.held = 2;
  market.tradeHistory = [
    { slug: 'pudgypenguins', tokenId: 1n, side: 'buy', price: eth('10.45'), timestamp: NOW },
  ];
  const runner = new Runner(market, tasksFileOf(tasks, overrides), NOW, () => NOW);
  const reports: RoundReport[] = [];
  runner.on('round', (report) => reports.push(report));
  await runner.round();
  return reports[0];
};

const linesOf = (text: string) => text.split('\n').filter((line) => !line.startsWith('#'));

describe('metricsText', () => {
  test('reports a bid with its commitment, the floor and the held value', async () => {
    const lines = linesOf(metricsText(await reportOf([bidTask])));

    const labels = 'task="pudgy-bid",collection="pudgypenguins"';
    expect(lines).toContain(
      `market_maker_task_status{${labels},kind="collectionBid",status="bidding",reason=""} 1`,
    );
    expect(lines).toContain(`market_maker_order_price_eth{${labels},side="bid",token_id=""} 8.01`);
    expect(lines).toContain(`market_maker_bid_commitment_eth{${labels}} 8.01`);
    expect(lines).toContain(`market_maker_held_items{${labels}} 2`);
    expect(lines).toContain(`market_maker_held_value_eth{${labels}} 20`);
    expect(lines).toContain(`market_maker_max_held_value_eth{${labels}} 30`);
    expect(lines).toContain('market_maker_exposure_limit_eth 100');
    expect(lines).toContain('market_maker_round_timestamp_seconds 1893456000');
  });

  test('stamps every sample with the given moment, in milliseconds', async () => {
    const lines = linesOf(metricsText(await reportOf([bidTask]), new Date('2026-11-01T00:00:00Z')));

    expect(lines.filter((line) => line !== '')).not.toBeEmpty();
    for (const line of lines.filter((line) => line !== '')) {
      expect(line).toEndWith(' 1793491200000');
    }
  });

  test('reports the loss against its caps and why the bid withdrew', async () => {
    const report = await reportOf([bidTask], {
      lossLimits: { ...LOSS_LIMITS.lossLimits, dailyUsd: 1_000 },
    });
    const lines = linesOf(metricsText(report));

    expect(lines).toContain(
      'market_maker_task_status{task="pudgy-bid",collection="pudgypenguins",kind="collectionBid",status="waiting",reason="lossLimit"} 1',
    );
    expect(lines).toContain('market_maker_loss_usd{window="day"} 2000');
    expect(lines).toContain('market_maker_loss_limit_usd{window="day"} 1000');
    expect(lines).toContain('market_maker_loss_limit_reached 1');
    expect(lines).toContain('market_maker_fills{collection="pudgypenguins",side="buy"} 1');
    expect(lines).toContain(
      'market_maker_fill_volume_eth{collection="pudgypenguins",side="buy"} 10.45',
    );
    expect(lines.some((line) => line.startsWith('market_maker_order_price_eth'))).toBe(false);
  });

  test('leaves the held value out while the wallet holds items with no floor', async () => {
    const market = new FakeMarket();
    market.market.held = 2;
    market.market.floorPrice = null;
    const runner = new Runner(market, tasksFileOf([bidTask]), NOW, () => NOW);
    const reports: RoundReport[] = [];
    runner.on('round', (report) => reports.push(report));
    await runner.round();
    const lines = linesOf(metricsText(reports[0]));

    expect(lines).toContain(
      'market_maker_held_items{task="pudgy-bid",collection="pudgypenguins"} 2',
    );
    expect(lines.some((line) => line.startsWith('market_maker_held_value_eth'))).toBe(false);
  });

  test('leaves the held items out until a snapshot is read', async () => {
    const market = new FakeMarket();
    market.failNextSnapshot = true;
    const runner = new Runner(market, tasksFileOf([bidTask]), NOW, () => NOW);
    const reports: RoundReport[] = [];
    runner.on('round', (report) => reports.push(report));
    await runner.round();

    expect(metricsText(reports[0])).not.toContain('market_maker_held');
  });

  test('reports a listing by its token', async () => {
    const lines = linesOf(metricsText(await reportOf([listingTaskJson()])));

    expect(lines).toContain(
      'market_maker_order_price_eth{task="pudgy-3950",collection="pudgypenguins",side="listing",token_id="3950"} 9.99',
    );
    expect(lines.some((line) => line.startsWith('market_maker_held_items'))).toBe(false);
  });

  test("reports the book beside the wallet's live bid", async () => {
    const lines = linesOf(metricsText(await reportOf([bidTask])));

    const labels = 'task="pudgy-bid",collection="pudgypenguins"';
    const order = `${labels},side="bid",token_id=""`;
    expect(lines).toContain(`market_maker_best_competing_bid_eth{${labels}} 8`);
    expect(lines).toContain(`market_maker_order_price_eth{${order}} 8.01`);
    expect(lines).toContain(`market_maker_order_remaining{${order}} 1`);
    expect(
      lines.some((line) =>
        line.startsWith(`market_maker_order_expiration_timestamp_seconds{${order}} 18934`),
      ),
    ).toBe(true);
  });

  test("reports the book beside the wallet's live listing", async () => {
    const lines = linesOf(metricsText(await reportOf([listingTaskJson()])));

    const labels = 'task="pudgy-3950",collection="pudgypenguins"';
    expect(lines).toContain(`market_maker_lowest_competing_ask_eth{${labels}} 10`);
    expect(lines).toContain(
      `market_maker_order_remaining{${labels},side="listing",token_id="3950"} 1`,
    );
  });

  test('drops the bid from the live orders once it withdraws', async () => {
    const report = await reportOf([bidTask], {
      lossLimits: { ...LOSS_LIMITS.lossLimits, dailyUsd: 1_000 },
    });

    expect(metricsText(report)).not.toContain('market_maker_order_');
  });

  test("keeps the loss measured when an older sale's collection cannot be read", async () => {
    const market = new FakeMarket();
    const lastMonth = new Date('2029-12-10T00:00:00Z');
    market.tradeHistory = [
      { slug: 'retired', tokenId: 1n, side: 'buy', price: eth('1'), timestamp: lastMonth },
      { slug: 'retired', tokenId: 1n, side: 'sell', price: eth('2'), timestamp: lastMonth },
    ];
    const runner = new Runner(market, tasksFileOf([bidTask], LOSS_LIMITS), NOW, () => NOW);
    const reports: RoundReport[] = [];
    runner.on('round', (report) => reports.push(report));
    await runner.round();
    const lines = linesOf(metricsText(reports[0]));

    expect(lines).toContain('market_maker_loss_measured 1');
    expect(lines.some((line) => line.includes('pnl_usd{collection="retired"}'))).toBe(false);
  });

  test('reports the realized and unrealized P&L per collection, net of fees', async () => {
    const market = new FakeMarket();
    market.tradeHistory = [
      { slug: 'pudgypenguins', tokenId: 1n, side: 'buy', price: eth('8'), timestamp: NOW },
      { slug: 'pudgypenguins', tokenId: 1n, side: 'sell', price: eth('10'), timestamp: NOW },
      { slug: 'pudgypenguins', tokenId: 2n, side: 'buy', price: eth('11'), timestamp: NOW },
    ];
    const runner = new Runner(market, tasksFileOf([bidTask], LOSS_LIMITS), NOW, () => NOW);
    const reports: RoundReport[] = [];
    runner.on('round', (report) => reports.push(report));
    await runner.round();
    const lines = linesOf(metricsText(reports[0]));

    expect(lines).toContain('market_maker_eth_usd 2000');
    expect(lines).toContain('market_maker_realized_pnl_usd{collection="pudgypenguins"} 2900');
    expect(lines).toContain('market_maker_unrealized_pnl_usd{collection="pudgypenguins"} -3100');
  });

  test('leaves the loss out without lossLimits', async () => {
    const text = metricsText(await reportOf([bidTask]));

    expect(text).not.toContain('market_maker_loss');
    expect(text).not.toContain('market_maker_fills');
    expect(text).not.toContain('pnl_usd');
  });

  test('escapes quotes and backslashes in label values', async () => {
    const lines = linesOf(metricsText(await reportOf([{ ...bidTask, id: 'say "hi"\\' }])));

    expect(lines).toContain(
      'market_maker_held_items{task="say \\"hi\\"\\\\",collection="pudgypenguins"} 2',
    );
  });
});
