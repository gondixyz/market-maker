import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { describeLoss, describeTaskState } from '../engine/describe';
import type { Venue } from '../engine/market';
import { metricsText } from '../engine/metrics';
import { Runner } from '../engine/runner';
import { marginWarnings, parsePositiveEther, parseTasksFile } from '../engine/task';
import { VenueMarket } from '../engine/venueMarket';
import { GondiApi } from '../gondi/api';
import { type FillModel, runBacktest } from '../gondi/backtest';
import { approveWeth, gondiFor, WETH_SPENDER } from '../gondi/client';
import { approvalOperator, GondiMarket } from '../gondi/market';
import { parsePriceHistory, recordPriceHistory, serializePriceHistory } from '../gondi/replay';
import { OpenSeaMarket } from '../opensea/market';
import { setOpenSeaProfile } from '../opensea/profile';
import { chainFrom, openSeaApiFrom, priceApiFrom, privateKeyFrom } from './environment';
import { pushMetricsEachRound } from './metrics';
import { cancelAllOnShutdown } from './shutdown';

const USAGE = `Usage:
  market-maker run <tasks.json>         keep the file's bids and listings up until interrupted
                                        (Ctrl+C or SIGTERM cancels the bids; listings stay until
                                        they expire)
  market-maker cancel-all <tasks.json>  withdraw every bid the file's tasks placed, once no run is alive
  market-maker approve <amount>         let Seaport spend <amount> WETH (sends a transaction)
  market-maker approve-opensea <amount> let OpenSea's conduit spend <amount> WETH, which OpenSea
                                        bids pay through (sends a transaction)
  market-maker opensea-profile <username> [display name]
                                        sign in to opensea.io as the wallet, accepting OpenSea's
                                        terms, claim <username> and set the name its offers show
                                        (the username unless given; letters, digits, _ and -); a
                                        wallet that has a username keeps it
  market-maker approve-nft <collection> let Seaport (or the collection's Seaport conduit) move its
                                        items, so they can be listed (sends a transaction)
  market-maker record-prices <tasks.json> <history.json> [days]
                                        record the last [days] (default 7) of the file's
                                        collections' floor and best bid, every 15 minutes, from
                                        MARKET_MAKER_PRICE_API_URL (GONDI_API_URL otherwise), to
                                        replay with MARKET_MAKER_PRICE_REPLAY_FILE, and every sale,
                                        to backtest
  market-maker backtest <tasks.json> <history.json> [strict|loose]
                                        trade the file's tasks over a recorded history, filling
                                        orders from its real sales (strict by default; loose
                                        widens both the bids and the listings they fill), and print
                                        the profit; with MARKET_MAKER_METRICS_URL, push every
                                        round's metrics stamped at its replayed moment

Environment:
  MARKET_MAKER_PRIVATE_KEY       the bot wallet's private key (0x...)
  MARKET_MAKER_PRIVATE_KEY_FILE  a file holding that key, instead of MARKET_MAKER_PRIVATE_KEY
  MARKET_MAKER_RPC_URL           an Ethereum RPC endpoint (optional on mainnet; viem's public
                                 default otherwise)
  MARKET_MAKER_CHAIN_ID          the chain id of a local fork to run against (mainnet otherwise)
  GONDI_URL                      the GONDI API the SDK publishes and cancels orders through
  GONDI_API_URL                  the GONDI lending GraphQL endpoint market data is read from
  MARKET_MAKER_PRICE_API_URL     a lending GraphQL endpoint to read market prices from instead (floor,
                                 competing bids and listings, ETH's USD price), such as production's
                                 while trading on a test stack (optional)
  MARKET_MAKER_PRICE_REPLAY_FILE a history record-prices wrote, to read market prices from instead,
                                 played back from its first sample and looping (optional; wins
                                 over MARKET_MAKER_PRICE_API_URL)
  MARKET_MAKER_PRICE_REPLAY_SPEED how many times faster than the wall clock the history plays
                                 (default 168, a week an hour)
  MARKET_MAKER_METRICS_URL       where each round's metrics are POSTed as Prometheus text, such as
                                 VictoriaMetrics' /api/v1/import/prometheus (optional)
  OPENSEA_API_KEY                an OpenSea API key, which tasks with "venue": "opensea" bid
                                 with (optional)`;

const createGondi = async () =>
  gondiFor(
    privateKeyToAccount(await privateKeyFrom(process.env)),
    chainFrom(process.env),
    process.env.MARKET_MAKER_RPC_URL,
  );

const runnerFor = async (tasksPath: string) => {
  const file = parseTasksFile(JSON.parse(await readFile(tasksPath, 'utf8')));
  for (const warning of marginWarnings(file)) console.warn(`warning: ${warning}`);
  const gondi = await createGondi();
  const market = new GondiMarket(gondi, new GondiApi(), await priceApiFrom(process.env));
  const openSeaApi = openSeaApiFrom(process.env);
  const venues = {
    gondi: market,
    opensea: openSeaApi && new OpenSeaMarket(gondi, openSeaApi, new GondiApi()),
  };
  const runner = new Runner(new VenueMarket(market, venues), file);
  runner.on('state', (taskId, state) =>
    console.log(`${new Date().toISOString()} ${taskId} ${describeTaskState(state)}`),
  );
  runner.on('loss', (report) => console.log(`${new Date().toISOString()} ${describeLoss(report)}`));
  return runner;
};

const run = async (tasksPath: string) => {
  const runner = await runnerFor(tasksPath);
  const metricsUrl = process.env.MARKET_MAKER_METRICS_URL;
  if (metricsUrl) pushMetricsEachRound(runner, metricsUrl);
  cancelAllOnShutdown(runner);
  runner.start();
};

const approveVenue = async (amount: string, venue: Venue) => {
  const wei = parsePositiveEther(amount);
  const gondi = await createGondi();
  await approveWeth(gondi, wei, venue);
  console.log(
    `${WETH_SPENDER[venue].name} may now spend ${amount} WETH from ${gondi.account.address}`,
  );
};

const openSeaProfile = async (username: string, displayName: string | undefined) => {
  const account = privateKeyToAccount(await privateKeyFrom(process.env));
  const shown = displayName ?? username;
  const { claimed } = await setOpenSeaProfile({ account, username, displayName: shown });
  console.log(
    claimed
      ? `${account.address} is ${username} on OpenSea, shown as ${shown}`
      : `${account.address} already had an OpenSea username, kept; it is now shown as ${shown}`,
  );
};

const approveNft = async (collection: string) => {
  const gondi = await createGondi();
  const { contractAddress, seaportConduitKey } = await new GondiApi().collectionMarket({
    slug: collection,
  });
  const operator = await approvalOperator(gondi, seaportConduitKey);
  const approval = await gondi.approveNFTForAll({
    nftAddress: contractAddress,
    standard: 'ERC721',
    to: operator,
  });
  await approval.waitTxInBlock();
  console.log(`${operator} may now move ${collection} items from ${gondi.account.address}`);
};

const DEFAULT_RECORD_DAYS = 7;

const recordPrices = async (tasksPath: string, historyPath: string, days: string | undefined) => {
  const file = parseTasksFile(JSON.parse(await readFile(tasksPath, 'utf8')));
  const slugs = [...new Set(file.tasks.map((task) => task.collection))];
  const dayCount = Number(days ?? DEFAULT_RECORD_DAYS);
  if (!(dayCount > 0)) throw new Error('days must be a positive number');
  const history = await recordPriceHistory({
    api: new GondiApi(process.env.MARKET_MAKER_PRICE_API_URL),
    slugs,
    days: dayCount,
  });
  await writeFile(historyPath, serializePriceHistory(history));
  console.log(`recorded ${slugs.join(', ')} into ${historyPath}`);
};

const FILL_MODELS: FillModel[] = ['strict', 'loose'];
const ROUNDS_PER_PUSH = 50;

const eth = (wei: bigint) => Number(formatEther(wei)).toFixed(3);

/**
 * POSTs rounds' metrics to `url` in batches of `ROUNDS_PER_PUSH` rounds, each stamped at its
 * replayed moment. Unlike a live run's push, a failed one throws: a backtest's dashboard with gaps
 * would mislead. `flush` sends what is left.
 */
const timestampedPusher = (url: string) => {
  let batch: string[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const response = await fetch(url, { method: 'POST', body: batch.join('') });
    batch = [];
    if (!response.ok) throw new Error(`could not push metrics: HTTP ${response.status}`);
  };
  const push = async (text: string) => {
    batch.push(text);
    if (batch.length >= ROUNDS_PER_PUSH) await flush();
  };
  return { push, flush };
};

const backtest = async (tasksPath: string, historyPath: string, model: string | undefined) => {
  const fillModel = (model ?? 'strict') as FillModel;
  if (!FILL_MODELS.includes(fillModel))
    throw new Error(`the fill model must be ${FILL_MODELS.join(' or ')}`);
  const file = parseTasksFile(JSON.parse(await readFile(tasksPath, 'utf8')));
  const history = parsePriceHistory(await readFile(historyPath, 'utf8'));
  const metricsUrl = process.env.MARKET_MAKER_METRICS_URL;
  const pusher = metricsUrl ? timestampedPusher(metricsUrl) : undefined;
  const result = await runBacktest({
    history,
    file,
    fillModel,
    onRound: (report, at) => pusher?.push(metricsText(report, at)),
  });
  await pusher?.flush();
  const ethUsd = result.report.pnl?.ethUsd ?? history.ethUsdPrice;
  const usdOf = (wei: bigint) => `$${(Number(formatEther(wei)) * ethUsd).toFixed(0)}`;
  for (const { slug, realized, unrealized } of result.report.pnl?.collections ?? []) {
    const trades = result.fills.filter((fill) => fill.slug === slug);
    const total = realized + (unrealized ?? 0n);
    console.log(
      `${slug}: ${trades.filter((fill) => fill.side === 'buy').length} bought, ` +
        `${trades.filter((fill) => fill.side === 'sell').length} sold, realized ${eth(realized)} ETH, ` +
        `held at the floor ${eth(unrealized ?? 0n)} ETH, total ${eth(total)} ETH (${usdOf(total)})`,
    );
  }
  const total = result.profits.at(-1)?.profit ?? 0n;
  console.log(
    `${fillModel} fills: total ${eth(total)} ETH (${usdOf(total)}), worst drawdown ` +
      `${eth(result.worstDrawdown)} ETH (${usdOf(result.worstDrawdown)}), at $${ethUsd} per ETH`,
  );
};

/** Entry point: `market-maker <command> <argument>`; see `USAGE`. */
const main = async () => {
  const {
    positionals: [command, argument, ...rest],
  } = parseArgs({ allowPositionals: true });
  if (command === 'run' && argument) return run(argument);
  if (command === 'cancel-all' && argument) return (await runnerFor(argument)).cancelAll();
  if (command === 'approve' && argument) return approveVenue(argument, 'gondi');
  if (command === 'approve-opensea' && argument) return approveVenue(argument, 'opensea');
  if (command === 'opensea-profile' && argument) return openSeaProfile(argument, rest[0]);
  if (command === 'approve-nft' && argument) return approveNft(argument);
  if (command === 'record-prices' && argument && rest[0])
    return recordPrices(argument, rest[0], rest[1]);
  if (command === 'backtest' && argument && rest[0]) return backtest(argument, rest[0], rest[1]);
  console.error(USAGE);
  process.exitCode = 1;
};

await main();
