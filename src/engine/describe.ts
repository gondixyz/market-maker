import { formatEther } from 'viem';

import type { LossReport } from './pnl';
import type { TaskState, WrapReport } from './runner';

/** A task's state in one line, for the CLI log and the desktop task list. */
export const describeTaskState = (state: TaskState) => {
  switch (state.status) {
    case 'bidding':
      return `bidding ${formatEther(state.price)} WETH (bid ${state.bidId})${
        state.offers > 1 ? `, ${state.offers} offers` : ''
      }`;
    case 'listing':
      return `listed at ${formatEther(state.price)} ETH (listing ${state.listingId})`;
    case 'listingInventory':
      return state.items.length === 0
        ? 'holds no items to list'
        : state.items
            .map(({ tokenId, state: item }) =>
              item.status === 'listing'
                ? `#${tokenId} listed at ${formatEther(item.price)} ETH`
                : item.status === 'failing'
                  ? `#${tokenId} failing: ${item.error}`
                  : `#${tokenId} waiting: ${item.reason}`,
            )
            .join(', ');
    case 'waiting':
    case 'halted':
      return `${state.status}: ${state.reason}`;
    case 'failing':
      return `failing (${state.failures}x): ${state.error}`;
    case 'starting':
      return 'starting';
  }
};

const usd = (amount: number) => `$${amount.toFixed(2)}`;

/** A round's loss against `lossLimits` in one line, for the CLI log and the desktop window. */
export const describeLoss = (report: LossReport) => {
  if (report.status === 'unmeasured') return `loss unmeasured, not bidding: ${report.reason}`;
  const loss = `loss today ${usd(report.dailyLossUsd)}, this week ${usd(report.weeklyLossUsd)}`;
  const stale = report.staleReason
    ? ` (as last measured; this read failed: ${report.staleReason})`
    : '';
  return `${report.reached ? `${loss}, at a cap: not bidding` : loss}${stale}`;
};

/** A round's `wrapEth` top-up in one line, for the CLI log. */
export const describeWrap = (report: WrapReport) =>
  report.status === 'wrapped'
    ? `wrapped ${formatEther(report.amount)} ETH into WETH`
    : `could not wrap ETH into WETH: ${report.error}`;
