import { cancelAllOnShutdown } from '../../src/cli/shutdown';
import { Runner } from '../../src/engine/runner';
import { FakeMarket, tasksFileOf } from '../fakeMarket';

/**
 * A `run` against the in-memory market, for the shutdown test to signal: prints `bidding` once the
 * bid is up and `cancelled <ids>` when bids are withdrawn. With `FAIL_CANCEL` set, withdrawing fails.
 */
const market = new FakeMarket();
const cancelBids = market.cancelBids.bind(market);
market.cancelBids = async (bids) => {
  if (process.env.FAIL_CANCEL) throw new Error('the API is down');
  await cancelBids(bids);
  console.log(`cancelled ${bids.map((bid) => bid.id).join(',')}`);
};
const runner = new Runner(
  market,
  tasksFileOf([
    {
      id: 'punks',
      kind: 'collectionBid',
      collection: 'pudgypenguins',
      pricing: { mode: 'outbid' },
      minPrice: '5',
      maxPrice: '9',
    },
  ]),
);
runner.on('state', (_taskId, state) => {
  if (state.status === 'bidding') console.log('bidding');
});
cancelAllOnShutdown(runner);
runner.start();
