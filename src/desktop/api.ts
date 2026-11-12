import type { Venue } from '../engine/market';
import type { TaskState } from '../engine/runner';

/** One task as the window shows it: plain strings, so nothing but display data leaves main. */
export type TaskStateView = { taskId: string; status: TaskState['status']; detail: string };

/** Everything the window shows about the bot. Never carries the key, only its address. */
export type DesktopStatus = {
  address: string | null;
  /** Why a stored key could not be read; the window offers to replace or remove it. */
  keyError: string | null;
  encryptionAvailable: boolean;
  /** Whether an OpenSea API key is stored; the key itself never leaves main. */
  openSeaKey: boolean;
  /**
   * The host of the saved Ethereum RPC URL, which the bot reads and sends through unless the
   * environment sets `MARKET_MAKER_RPC_URL`; `null` with none saved, when it uses that variable or
   * a public endpoint. The URL itself never leaves main: providers put their API key in it.
   */
  rpcHost: string | null;
  /** Whether `MARKET_MAKER_RPC_URL` is set where the app started, which a saved URL gives way to. */
  rpcUrlFromEnvironment: boolean;
  running: boolean;
  /** The latest round's loss against `lossLimits`, in one line; `null` without `lossLimits`. */
  loss: string | null;
  tasks: TaskStateView[];
};

/** The bot wallet's balances, in ETH as decimal strings. */
export type WalletBalances = { eth: string; weth: string };

/** The wallet's public GONDI profile; `picture` is a `data:` URL, inlined by main. */
export type WalletProfile = { name: string | null; picture: string | null };

/** A collection the tasks' collection picker offers; `image` is a `data:` URL, inlined by main. */
export type CollectionOption = { slug: string; name: string; image: string | null };

/** A saved file may still carry warnings, such as a listing that could sell under a bid's ceiling. */
export type SaveTasksResult = { ok: true; warnings: string[] } | { ok: false; errors: string[] };

/** How a cancel of every listing went: nothing listed, declined at the dialog, or mined. */
export type CancelListingsResult =
  | { outcome: 'none' }
  | { outcome: 'declined' }
  | { outcome: 'cancelled'; count: number; transactionHashes: string[] };

export type ApprovalResult =
  | { outcome: 'approved'; transactionHash: string }
  | { outcome: 'declined' };

/** The only calls the window can make into main; `preload` exposes exactly these. */
export interface DesktopApi {
  status(): Promise<DesktopStatus>;
  importKey(privateKey: string): Promise<DesktopStatus>;
  removeKey(): Promise<DesktopStatus>;
  loadTasks(): Promise<string>;
  saveTasks(text: string): Promise<SaveTasksResult>;
  start(): Promise<DesktopStatus>;
  stop(): Promise<DesktopStatus>;
  cancelAll(): Promise<DesktopStatus>;
  /** Lets the venue's spender (Seaport, or OpenSea's conduit) spend `amount` WETH, once confirmed. */
  approveWeth(amount: string, venue: Venue): Promise<ApprovalResult>;
  /**
   * Cancels, on-chain and once confirmed, every active GONDI listing of the strategies'
   * collections; stops the bot first, so it does not list them again.
   */
  cancelAllListings(): Promise<CancelListingsResult>;
  /** Stores the user's OpenSea API key, encrypted like the wallet key; only while stopped. */
  importOpenSeaKey(apiKey: string): Promise<DesktopStatus>;
  removeOpenSeaKey(): Promise<DesktopStatus>;
  /**
   * Saves the Ethereum RPC URL the bot uses, encrypted like the wallet key, once it answers with
   * the chain the bot runs on; only while stopped.
   */
  saveRpcUrl(url: string): Promise<DesktopStatus>;
  removeRpcUrl(): Promise<DesktopStatus>;
  /** The stored key's wallet balances; rejects without a key. */
  balances(): Promise<WalletBalances>;
  /** The collections the tasks' collection picker offers, most traded first. */
  collections(): Promise<CollectionOption[]>;
  /** The pickable collections whose name or slug `query` matches, most traded first. */
  searchCollections(query: string): Promise<CollectionOption[]>;
  /** The stored key's wallet's GONDI name and picture; rejects without a key. */
  profile(): Promise<WalletProfile>;
  onStatus(listener: (status: DesktopStatus) => void): () => void;
}

/** The request/response channels, one per `DesktopApi` call but `onStatus`. */
export const INVOKE_CHANNELS = {
  status: 'market-maker:status',
  importKey: 'market-maker:import-key',
  removeKey: 'market-maker:remove-key',
  loadTasks: 'market-maker:load-tasks',
  saveTasks: 'market-maker:save-tasks',
  start: 'market-maker:start',
  stop: 'market-maker:stop',
  cancelAll: 'market-maker:cancel-all',
  approveWeth: 'market-maker:approve-weth',
  cancelAllListings: 'market-maker:cancel-all-listings',
  importOpenSeaKey: 'market-maker:import-opensea-key',
  removeOpenSeaKey: 'market-maker:remove-opensea-key',
  saveRpcUrl: 'market-maker:save-rpc-url',
  removeRpcUrl: 'market-maker:remove-rpc-url',
  balances: 'market-maker:balances',
  profile: 'market-maker:profile',
  collections: 'market-maker:collections',
  searchCollections: 'market-maker:search-collections',
} as const satisfies Record<Exclude<keyof DesktopApi, 'onStatus'>, string>;

/** Main pushes a fresh `DesktopStatus` on this channel whenever a task changes state. */
export const STATUS_CHANNEL = 'market-maker:status-changed';
