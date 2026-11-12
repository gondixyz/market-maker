import { formatEther } from 'viem';

import type { RoundReport, TaskReport } from './runner';

type Labels = Record<string, string>;

/** One metric: its name, help text and samples, all gauges. */
type Metric = { name: string; help: string; samples: { labels: Labels; value: number }[] };

const toEth = (wei: bigint) => Number(formatEther(wei));

const escapeLabel = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');

const formatLabels = (labels: Labels) => {
  const pairs = Object.entries(labels).map(([key, value]) => `${key}="${escapeLabel(value)}"`);
  return pairs.length === 0 ? '' : `{${pairs.join(',')}}`;
};

const taskLabels = ({ task }: TaskReport): Labels => ({
  task: task.id,
  collection: task.collection,
});

const reasonOf = ({ state }: TaskReport) =>
  state.status === 'waiting' || state.status === 'halted' ? state.reason : '';

const isBidReport = (report: TaskReport) => report.task.kind !== 'listing';

/** The held items at the floor, in ETH, or `undefined` while unread or held without a floor. */
const heldValueOf = ({ held, floorPrice }: TaskReport) => {
  if (held === null || (held > 0 && floorPrice === null)) return undefined;
  return toEth(BigInt(held) * (floorPrice ?? 0n));
};

/** Every sample the round's tasks give `select`, one per task it returns a value for. */
const perTask = (
  report: RoundReport,
  select: (task: TaskReport) => number | undefined,
): Metric['samples'] =>
  report.tasks.flatMap((task) => {
    const value = select(task);
    return value === undefined ? [] : [{ labels: taskLabels(task), value }];
  });

const lossMetrics = ({ loss, lossLimits }: RoundReport): Metric[] => {
  if (!loss || !lossLimits) return [];
  const windows = [
    { window: 'day', limit: lossLimits.dailyUsd },
    { window: 'week', limit: lossLimits.weeklyUsd },
  ];
  const measured = loss.status === 'measured' ? loss : undefined;
  return [
    {
      name: 'market_maker_loss_limit_usd',
      help: 'The loss cap of each window, in USD.',
      samples: windows.map(({ window, limit }) => ({ labels: { window }, value: limit })),
    },
    {
      name: 'market_maker_loss_usd',
      help: "The wallet's loss over the UTC day or the ISO week, in USD; absent while unmeasured.",
      samples: measured
        ? [
            { labels: { window: 'day' }, value: measured.dailyLossUsd },
            { labels: { window: 'week' }, value: measured.weeklyLossUsd },
          ]
        : [],
    },
    {
      name: 'market_maker_loss_measured',
      help: 'Whether the loss could be measured this round; 0 stops the bidding.',
      samples: [{ labels: {}, value: measured ? 1 : 0 }],
    },
    {
      name: 'market_maker_loss_limit_reached',
      help: 'Whether bidding is stopped for the loss: at a cap, or unmeasured.',
      samples: [{ labels: {}, value: !measured || measured.reached ? 1 : 0 }],
    },
  ];
};

const toUsd = (wei: bigint, ethUsd: number) => toEth(wei) * ethUsd;

const pnlMetrics = ({ pnl }: RoundReport): Metric[] => {
  if (!pnl) return [];
  return [
    {
      name: 'market_maker_eth_usd',
      help: 'The price of one ETH in USD the P&L and the loss were valued at.',
      samples: [{ labels: {}, value: pnl.ethUsd }],
    },
    {
      name: 'market_maker_realized_pnl_usd',
      help: "What the collection's sales since lossLimits.since made over their cost, net of fees, in USD.",
      samples: pnl.collections.map(({ slug, realized }) => ({
        labels: { collection: slug },
        value: toUsd(realized, pnl.ethUsd),
      })),
    },
    {
      name: 'market_maker_unrealized_pnl_usd',
      help: "What the collection's held items would make sold at the floor, net of fees, in USD; absent with no floor.",
      samples: pnl.collections.flatMap(({ slug, unrealized }) =>
        unrealized === null
          ? []
          : [{ labels: { collection: slug }, value: toUsd(unrealized, pnl.ethUsd) }],
      ),
    },
  ];
};

const orderMetrics = (report: RoundReport): Metric[] => {
  const orders = report.tasks.flatMap((task) =>
    task.orders.map((order) => ({
      labels: {
        ...taskLabels(task),
        side: order.side,
        token_id: order.tokenId?.toString() ?? '',
      },
      order,
    })),
  );
  return [
    {
      name: 'market_maker_order_price_eth',
      help: 'What each live order of the wallet bids or asks, in ETH.',
      samples: orders.map(({ labels, order }) => ({ labels, value: toEth(order.price) })),
    },
    {
      name: 'market_maker_order_remaining',
      help: 'How many items each live order may still buy or sell.',
      samples: orders.map(({ labels, order }) => ({ labels, value: order.remaining })),
    },
    {
      name: 'market_maker_order_expiration_timestamp_seconds',
      help: 'When each live order expires, in Unix seconds.',
      samples: orders.map(({ labels, order }) => ({
        labels,
        value: order.expiration.getTime() / 1_000,
      })),
    },
  ];
};

const fillMetrics = (report: RoundReport): Metric[] => {
  if (!report.lossLimits) return [];
  const totals = new Map<string, { labels: Labels; count: number; volume: bigint }>();
  for (const fill of report.fills) {
    const key = `${fill.slug}#${fill.side}`;
    const total = totals.get(key) ?? {
      labels: { collection: fill.slug, side: fill.side },
      count: 0,
      volume: 0n,
    };
    total.count += 1;
    total.volume += fill.price;
    totals.set(key, total);
  }
  return [
    {
      name: 'market_maker_fills',
      help: 'Items the wallet bought or sold since lossLimits.since.',
      samples: [...totals.values()].map(({ labels, count }) => ({ labels, value: count })),
    },
    {
      name: 'market_maker_fill_volume_eth',
      help: 'What those fills paid, in ETH, before royalties and fees.',
      samples: [...totals.values()].map(({ labels, volume }) => ({ labels, value: toEth(volume) })),
    },
  ];
};

/** Every metric a round reports, before formatting. */
const metricsOf = (report: RoundReport): Metric[] => [
  {
    name: 'market_maker_round_timestamp_seconds',
    help: 'When the latest round finished, in Unix seconds.',
    samples: [{ labels: {}, value: report.finishedAt.getTime() / 1_000 }],
  },
  {
    name: 'market_maker_round_duration_seconds',
    help: 'How long the latest round took.',
    samples: [{ labels: {}, value: report.durationMs / 1_000 }],
  },
  {
    name: 'market_maker_exposure_limit_eth',
    help: "The most the wallet's live bids may commit at once, in ETH.",
    samples: [{ labels: {}, value: toEth(report.exposureLimit) }],
  },
  {
    name: 'market_maker_task_status',
    help: "1 on the task's current status, with the reason it waits or halted.",
    samples: report.tasks.map((task) => ({
      labels: {
        ...taskLabels(task),
        kind: task.task.kind,
        status: task.state.status,
        reason: reasonOf(task),
      },
      value: 1,
    })),
  },
  {
    name: 'market_maker_task_failures',
    help: 'How many rounds in a row the task has failed; 0 when it is not failing.',
    samples: perTask(report, ({ state }) => (state.status === 'failing' ? state.failures : 0)),
  },
  {
    name: 'market_maker_bid_commitment_eth',
    help: "What the task's live bid commits against the exposure limit, in WETH.",
    samples: perTask(report, (task) => (isBidReport(task) ? toEth(task.commitment) : undefined)),
  },
  {
    name: 'market_maker_floor_price_eth',
    help: "The collection's floor as the task last read it, in ETH.",
    samples: perTask(report, ({ floorPrice }) =>
      floorPrice === null ? undefined : toEth(floorPrice),
    ),
  },
  {
    name: 'market_maker_reference_floor_eth',
    help: 'The floor when the task started, which haltOnFloorMovePercent compares against, in ETH.',
    samples: perTask(report, ({ referenceFloor }) =>
      referenceFloor === null ? undefined : toEth(referenceFloor),
    ),
  },
  {
    name: 'market_maker_held_items',
    help: "The collection's items the wallet held as the task last read it; absent before a read.",
    samples: perTask(report, ({ held }) => held ?? undefined),
  },
  {
    name: 'market_maker_held_value_eth',
    help: 'Those items valued at the floor, as maxHeldValue counts them, in ETH; absent unvalued.',
    samples: perTask(report, heldValueOf),
  },
  {
    name: 'market_maker_max_held_value_eth',
    help: "The task's maxHeldValue, in ETH.",
    samples: perTask(report, ({ task }) =>
      task.kind === 'collectionBid' && task.maxHeldValue !== undefined
        ? toEth(task.maxHeldValue)
        : undefined,
    ),
  },
  {
    name: 'market_maker_best_competing_bid_eth',
    help: "The collection's best bid that is not the wallet's, as the task last read it, in WETH.",
    samples: perTask(report, ({ bestCompetingBid }) =>
      bestCompetingBid === null ? undefined : toEth(bestCompetingBid),
    ),
  },
  {
    name: 'market_maker_lowest_competing_ask_eth',
    help: "The collection's cheapest listing that is not the wallet's, as the task last read it, in ETH.",
    samples: perTask(report, ({ lowestCompetingAsk }) =>
      lowestCompetingAsk === null ? undefined : toEth(lowestCompetingAsk),
    ),
  },
  ...orderMetrics(report),
  ...lossMetrics(report),
  ...pnlMetrics(report),
  ...fillMetrics(report),
];

/**
 * The round as Prometheus text exposition, every metric a gauge. Without `timestamp` the samples
 * carry none, so whatever receives them stamps them on arrival; a backtest passes the replayed
 * moment instead. A metric with no sample this round is left out.
 *
 * IMPLEMENTATION NOTE: the format is one `# HELP` and one `# TYPE` line per metric, then one
 * `name{label="value",...} value [timestamp]` line per sample, the optional timestamp in
 * milliseconds since the epoch, label values escaping `\`, `"` and newlines
 * (https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format).
 */
export const metricsText = (report: RoundReport, timestamp?: Date) =>
  metricsOf(report)
    .filter((metric) => metric.samples.length > 0)
    .map((metric) =>
      [
        `# HELP ${metric.name} ${metric.help}`,
        `# TYPE ${metric.name} gauge`,
        ...metric.samples.map(
          ({ labels, value }) =>
            `${metric.name}${formatLabels(labels)} ${value}` +
            (timestamp === undefined ? '' : ` ${timestamp.getTime()}`),
        ),
      ].join('\n'),
    )
    .join('\n')
    .concat('\n');
