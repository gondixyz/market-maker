import { formatEther } from 'viem';

import { VENUE_NAMES } from './market';
import type { LossReport } from './pnl';
import type { ExitReport, LendReport, MirrorReport, TaskState, WrapReport } from './runner';

/** A task's state in one line, for the CLI log and the desktop task list. */
export const describeTaskState = (state: TaskState) => {
  switch (state.status) {
    case 'bidding':
      return `bidding ${formatEther(state.price)} WETH (bid ${state.bidId})${
        state.offers > 1 ? `, ${state.offers} offers` : ''
      }${state.resale ? `, resale offer while ${state.resale}` : ''}`;
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
                  : item.status === 'sold'
                    ? `#${tokenId} sold into a ${VENUE_NAMES[item.venue]} bid for ${formatEther(item.netPrice)} ETH`
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

/** A `bidExit` sale, or its failure, in one line, for the CLI log. */
export const describeExit = (report: ExitReport) =>
  report.status === 'sold'
    ? `${report.taskId} sold #${report.tokenId} into a ${VENUE_NAMES[report.venue]} bid for ` +
      `${formatEther(report.netPrice)} ETH before gas (${report.reason === 'profit' ? 'at a profit' : 'stop loss'})`
    : `${report.taskId} could not sell ${report.tokenId === undefined ? 'into bids' : `#${report.tokenId} into a bid`}: ${report.error}`;

/** An `openSeaListing` listing, cancel or failure on OpenSea, in one line, for the CLI log. */
export const describeMirror = (report: MirrorReport) => {
  switch (report.status) {
    case 'listed':
      return `${report.taskId} listed #${report.tokenId} on OpenSea for ${formatEther(report.price)} ETH`;
    case 'cancelled':
      return `${report.taskId} cancelled ${report.count} OpenSea listing${report.count === 1 ? '' : 's'} of #${report.tokenId}`;
    case 'failed':
      return `${report.taskId} could not mirror ${report.tokenId === undefined ? 'its listings' : `#${report.tokenId}`} on OpenSea: ${report.error}`;
  }
};

/** A `loanOffer` offer, hide, wait or failure, in one line, for the CLI log. */
export const describeLend = (report: LendReport) => {
  switch (report.status) {
    case 'offered':
      return (
        `${report.taskId} offered a ${formatEther(report.principal)} WETH loan against #${report.tokenId} ` +
        `at ${Number(report.aprBps) / 100}% APR for ${Number(report.durationSeconds) / 86_400} days, ` +
        `with a ${formatEther(report.fee)} WETH origination fee`
      );
    case 'hidden':
      return `${report.taskId} hid ${report.count} loan offer${report.count === 1 ? '' : 's'} on #${report.tokenId}`;
    case 'waiting':
      return `${report.taskId} offers no loan against #${report.tokenId}: ${report.reason === 'insufficientBalance' ? 'not enough WETH' : 'WETH allowance too low, run approve-loans'}`;
    case 'failed':
      return `${report.taskId} could not offer ${report.tokenId === undefined ? 'its loans' : `a loan against #${report.tokenId}`}: ${report.error}`;
  }
};
