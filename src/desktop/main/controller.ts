import { BaseError, formatEther, type LocalAccount } from 'viem';

import { describeLoss, describeTaskState } from '../../engine/describe';
import type { Market, Venue } from '../../engine/market';
import { Runner, type TaskState } from '../../engine/runner';
import { bidsOnOpenSea, parsePositiveEther, type TasksFile } from '../../engine/task';
import { WETH_SPENDER } from '../../gondi/client';
import type {
  ApprovalResult,
  CancelListingsResult,
  CollectionOption,
  DesktopApi,
  DesktopStatus,
  SaveTasksResult,
  WalletBalances,
  WalletProfile,
} from '../api';

/** OpenSea API keys are 32 hex characters; this accepts any plausible token without spaces. */
const OPENSEA_API_KEY = /^[\w-]{16,128}$/;

/** What the controller needs from Electron and the network; tests pass fakes. */
export type ControllerDependencies = {
  vault: {
    isEncryptionAvailable(): boolean;
    store(privateKey: string): Promise<string>;
    remove(): Promise<void>;
    account(): Promise<LocalAccount | null>;
  };
  tasks: {
    text(): Promise<string>;
    save(text: string): Promise<SaveTasksResult>;
    load(): Promise<TasksFile>;
  };
  /** The user's OpenSea API key, encrypted at rest; it goes to `marketFor` and nowhere else. */
  openSeaKey: {
    write(apiKey: string): Promise<void>;
    read(): Promise<string | null>;
    remove(): Promise<void>;
  };
  /** The Ethereum RPC URL the user saved, encrypted at rest like the OpenSea key. */
  rpcUrl: {
    write(url: string): Promise<void>;
    read(): Promise<string | null>;
    remove(): Promise<void>;
  };
  /** The chain the bot runs on, which a saved RPC URL must serve. */
  chainId: number;
  /** Whether `MARKET_MAKER_RPC_URL` is set, which takes precedence over a saved URL. */
  rpcUrlFromEnvironment: boolean;
  /** The chain id the RPC at `url` answers with; rejects when it does not answer. */
  chainIdAt(url: string): Promise<number>;
  /**
   * Sends every later chain read and transaction through `url`, or the default with `null`; the
   * environment's URL keeps precedence over either.
   */
  useRpcUrl(url: string | null): void;
  marketFor(account: LocalAccount, openSeaApiKey: string | null): Market;
  approveWeth(account: LocalAccount, amount: bigint, venue: Venue): Promise<string>;
  /** The ids of the account's active GONDI listings on the collections of `slugs`. */
  activeListings(account: LocalAccount, slugs: string[]): Promise<number[]>;
  /** Cancels the listings on-chain; resolves with each mined transaction's hash. */
  cancelListings(account: LocalAccount, orderIds: number[]): Promise<string[]>;
  balancesOf(account: LocalAccount): Promise<{ eth: bigint; weth: bigint }>;
  profileOf(account: LocalAccount): Promise<WalletProfile>;
  /** The picker's collections: the week's most traded, or those `searchTerm` matches. */
  pickableCollections(searchTerm?: string): Promise<CollectionOption[]>;
  /** Asks the user, outside the window, to confirm an on-chain action. */
  confirm(message: string): Promise<boolean>;
  /** Keeps the computer from suspending the app while the bot runs. */
  keepAwake: { start(): void; stop(): void };
  notify(title: string, body: string): void;
  /** Sends the window a fresh status. */
  publish(status: DesktopStatus): void;
};

/** An http(s) URL, the transport the bot reads and sends through; throws on anything else. */
const parseRpcUrl = (url: string) => {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error('expected an RPC URL such as https://eth-mainnet.example.com/v2/<key>');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new Error('expected an http(s) RPC URL');
  return parsed;
};

/**
 * Why an RPC did not answer, without its URL, which carries the provider's key.
 *
 * IMPLEMENTATION NOTE: viem's `HttpRequestError`, `TimeoutError` and `RpcRequestError` append a
 * `URL: …` line to `message`, stripping only basic-auth credentials, so a key in the path is kept;
 * their `shortMessage` is the reason alone
 * (https://github.com/wevm/viem/blob/viem%402.57.16/src/errors/request.ts,
 * https://github.com/wevm/viem/blob/viem%402.57.16/src/errors/utils.ts).
 */
const answerFailure = (error: unknown) =>
  error instanceof BaseError ? error.shortMessage : 'no answer';

const isAlert = (state: TaskState, previous: TaskState | undefined) =>
  state.status === 'failing'
    ? state.failures === 1
    : (state.status === 'halted' || state.status === 'waiting') &&
      describeTaskState(state) !== (previous && describeTaskState(previous));

/**
 * Everything the desktop window can ask main to do, without Electron in it: the IPC handlers call
 * these methods one to one. It owns the running `Runner`, and holds the rule that the key and the
 * tasks only change while the bot is stopped.
 */
export class DesktopController implements Omit<DesktopApi, 'onStatus'> {
  private runner: Runner | undefined;
  private running = false;
  private pendingStart: Promise<DesktopStatus> | undefined;
  private address: string | null | undefined;
  private openSeaKeySaved: boolean | undefined;
  private rpcHost: string | null | undefined;
  private keyError: string | null = null;
  private loss: string | null = null;
  private collectionOptions: Promise<CollectionOption[]> | undefined;

  constructor(private readonly dependencies: ControllerDependencies) {}

  isRunning() {
    return this.running;
  }

  /** Never rejects: a stored key that cannot be read shows as `keyError`, so it can be replaced. */
  async status(): Promise<DesktopStatus> {
    if (this.address === undefined) await this.readAddress();
    this.openSeaKeySaved ??= (await this.dependencies.openSeaKey.read().catch(() => null)) !== null;
    if (this.rpcHost === undefined) {
      const saved = await this.dependencies.rpcUrl.read().catch(() => null);
      this.rpcHost = saved === null ? null : new URL(saved).host;
    }
    const states = this.runner?.states() ?? new Map<string, TaskState>();
    return {
      address: this.address ?? null,
      keyError: this.keyError,
      encryptionAvailable: this.dependencies.vault.isEncryptionAvailable(),
      openSeaKey: this.openSeaKeySaved,
      rpcHost: this.rpcHost,
      rpcUrlFromEnvironment: this.dependencies.rpcUrlFromEnvironment,
      running: this.running,
      loss: this.loss,
      tasks: [...states].map(([taskId, state]) => ({
        taskId,
        status: state.status,
        detail: describeTaskState(state),
      })),
    };
  }

  async importKey(privateKey: string) {
    this.assertStopped('importing a key');
    this.address = await this.dependencies.vault.store(privateKey);
    this.forgetRunner();
    this.keyError = null;
    return this.status();
  }

  async removeKey() {
    this.assertStopped('removing the key');
    await this.dependencies.vault.remove();
    this.forgetRunner();
    this.address = null;
    this.keyError = null;
    return this.status();
  }

  async importOpenSeaKey(apiKey: string) {
    this.assertStopped('changing the OpenSea API key');
    const trimmed = apiKey.trim();
    if (!OPENSEA_API_KEY.test(trimmed)) throw new Error('expected an OpenSea API key');
    await this.dependencies.openSeaKey.write(trimmed);
    this.forgetRunner();
    this.openSeaKeySaved = true;
    return this.status();
  }

  async removeOpenSeaKey() {
    this.assertStopped('removing the OpenSea API key');
    await this.dependencies.openSeaKey.remove();
    this.forgetRunner();
    this.openSeaKeySaved = false;
    return this.status();
  }

  /**
   * Saves `url` once it answers with the bot's chain, so a typo, a provider down or an endpoint of
   * another network is refused rather than found by a failing round.
   */
  async saveRpcUrl(url: string) {
    this.assertStopped('changing the RPC URL');
    const parsed = parseRpcUrl(url);
    const chainId = await this.dependencies.chainIdAt(parsed.href).catch((error: unknown) => {
      throw new Error(`${parsed.host} did not answer as an Ethereum RPC: ${answerFailure(error)}`);
    });
    if (chainId !== this.dependencies.chainId) {
      throw new Error(
        `${parsed.host} serves chain ${chainId}, not chain ${this.dependencies.chainId}`,
      );
    }
    this.assertStopped('changing the RPC URL');
    await this.dependencies.rpcUrl.write(parsed.href);
    this.dependencies.useRpcUrl(parsed.href);
    this.forgetRunner();
    this.rpcHost = parsed.host;
    return this.status();
  }

  async removeRpcUrl() {
    this.assertStopped('removing the RPC URL');
    await this.dependencies.rpcUrl.remove();
    this.dependencies.useRpcUrl(null);
    this.forgetRunner();
    this.rpcHost = null;
    return this.status();
  }

  loadTasks() {
    return this.dependencies.tasks.text();
  }

  async saveTasks(text: string): Promise<SaveTasksResult> {
    if (this.running) return { ok: false, errors: ['stop the bot before changing its tasks'] };
    return this.dependencies.tasks.save(text);
  }

  /** Starts bidding from the saved tasks; bids a previous run left are adopted, not duplicated. */
  start() {
    this.pendingStart ??= this.launch().finally(() => {
      this.pendingStart = undefined;
    });
    return this.pendingStart;
  }

  /**
   * Stops re-checking once the round under way has finished, so a start right after it cannot bid
   * alongside that round. Live bids stay up until they expire, and the next start adopts them.
   */
  async stop() {
    await this.pendingStart?.catch(() => undefined);
    await this.runner?.stop();
    this.halt();
    return this.status();
  }

  /**
   * The kill switch: withdraws every bid the saved tasks placed, running or not. The runner's loop
   * is stopped even when a withdrawal fails, so the bot shows as stopped and the call can be retried.
   */
  async cancelAll() {
    const runner =
      this.runner ??
      (await this.createRunner(
        await this.dependencies.tasks.load(),
        await this.dependencies.openSeaKey.read(),
      ));
    this.runner = runner;
    try {
      await runner.cancelAll();
    } finally {
      this.halt();
    }
    return this.status();
  }

  /**
   * Cancels every active GONDI listing on the collections the saved strategies list, after a
   * native confirmation naming how many and that it costs gas. A running bot is stopped first,
   * since its next round would list the items again, and the listings are read again once it has.
   */
  async cancelAllListings(): Promise<CancelListingsResult> {
    const account = await this.requireAccount();
    const { tasks } = await this.dependencies.tasks.load();
    const slugs = [
      ...new Set(tasks.filter((task) => task.kind === 'listing').map((task) => task.collection)),
    ];
    const orderIds = await this.dependencies.activeListings(account, slugs);
    if (orderIds.length === 0) return { outcome: 'none' };
    const confirmed = await this.dependencies.confirm(
      `Cancel ${orderIds.length} GONDI listing${orderIds.length === 1 ? '' : 's'} of ${slugs.join(', ')} from ${account.address}?\n\nListings only cancel on-chain: this sends a transaction and costs gas.${this.running ? '\n\nThe bot stops first, so it does not list them again.' : ''}`,
    );
    if (!confirmed) return { outcome: 'declined' };
    const toCancel = this.running ? await this.stopAndReadListings(account, slugs) : orderIds;
    if (toCancel.length === 0) return { outcome: 'none' };
    const transactionHashes = await this.dependencies.cancelListings(account, toCancel);
    return { outcome: 'cancelled', count: toCancel.length, transactionHashes };
  }

  /**
   * Stops the bot, waiting out its round, then reads the listings again: a round that ran while
   * the dialog was open may have listed more, and the user confirmed cancelling them all.
   */
  private async stopAndReadListings(account: LocalAccount, slugs: string[]) {
    await this.stop();
    return this.dependencies.activeListings(account, slugs);
  }

  async approveWeth(amount: string, venue: Venue): Promise<ApprovalResult> {
    const wei = parsePositiveEther(amount);
    const account = await this.requireAccount();
    const confirmed = await this.dependencies.confirm(
      `Let ${WETH_SPENDER[venue].name} spend up to ${amount} WETH from ${account.address}?\n\nThis sends a transaction and costs gas.`,
    );
    if (!confirmed) return { outcome: 'declined' };
    const transactionHash = await this.dependencies.approveWeth(account, wei, venue);
    return { outcome: 'approved', transactionHash };
  }

  async balances(): Promise<WalletBalances> {
    const { eth, weth } = await this.dependencies.balancesOf(await this.requireAccount());
    return { eth: formatEther(eth), weth: formatEther(weth) };
  }

  /** Read once per session; a failed read is not kept, so the next call tries again. */
  collections() {
    this.collectionOptions ??= this.dependencies.pickableCollections().catch((error: unknown) => {
      this.collectionOptions = undefined;
      throw error;
    });
    return this.collectionOptions;
  }

  /** The pickable collections `query` matches by name or slug, read afresh each time. */
  searchCollections(query: string) {
    return this.dependencies.pickableCollections(query.trim());
  }

  async profile(): Promise<WalletProfile> {
    return this.dependencies.profileOf(await this.requireAccount());
  }

  private async launch() {
    if (this.running) return this.status();
    const file = await this.dependencies.tasks.load();
    const openSeaApiKey = await this.dependencies.openSeaKey.read();
    if (bidsOnOpenSea(file) && !openSeaApiKey) {
      throw new Error('add your OpenSea API key to bid on OpenSea');
    }
    const runner = await this.createRunner(file, openSeaApiKey);
    this.runner?.removeAllListeners();
    this.runner = runner;
    runner.start();
    this.dependencies.keepAwake.start();
    this.running = true;
    return this.status();
  }

  private async readAddress() {
    try {
      this.address = (await this.dependencies.vault.account())?.address ?? null;
      this.keyError = null;
    } catch (error) {
      this.address = null;
      const reason = error instanceof Error ? error.message : String(error);
      this.keyError = `the stored key cannot be read (${reason}); import it again or remove it`;
    }
  }

  /**
   * Builds a runner over `file`. It refuses nothing about the OpenSea API key: without one, only
   * the OpenSea tasks fail, so cancel-all still withdraws every other task's bids.
   */
  private async createRunner(file: TasksFile, openSeaApiKey: string | null) {
    const account = await this.requireAccount();
    const runner = new Runner(this.dependencies.marketFor(account, openSeaApiKey), file);
    const previous = new Map<string, TaskState>();
    runner.on('state', (taskId, state) => {
      if (isAlert(state, previous.get(taskId))) {
        this.dependencies.notify(taskId, describeTaskState(state));
      }
      previous.set(taskId, state);
      void this.status().then(this.dependencies.publish);
    });
    runner.on('loss', (report) => {
      this.loss = describeLoss(report);
      void this.status().then(this.dependencies.publish);
    });
    return runner;
  }

  private async requireAccount() {
    const account = await this.dependencies.vault.account();
    if (!account) throw new Error('import the bot wallet key first');
    return account;
  }

  /** Drops the previous run's runner, whose market signs as the wallet it was built for. */
  private forgetRunner() {
    this.runner?.removeAllListeners();
    this.runner = undefined;
    this.loss = null;
  }

  private halt() {
    this.dependencies.keepAwake.stop();
    this.running = false;
  }

  private assertStopped(action: string) {
    if (this.running) throw new Error(`stop the bot before ${action}`);
  }
}
