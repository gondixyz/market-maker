/**
 * Withdraws every bid before the process exits on Ctrl+C (`SIGINT`) or a stop request (`SIGTERM`,
 * what `docker stop` and process managers send). Only the first signal counts: a second one while
 * the bids are being withdrawn does not cut the withdrawal short. A failed withdrawal exits non-zero
 * and points at `cancel-all`.
 */
export const cancelAllOnShutdown = (runner: { cancelAll(): Promise<void> }) => {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('cancelling every bid before exiting; listings stay live until they expire...');
    runner.cancelAll().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(`${String(error)}; run cancel-all to retry`);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};
