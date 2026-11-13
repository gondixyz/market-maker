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

/**
 * How much WETH a venue's spender may still spend: `unlimited` for the maximum approval, which
 * WETH never draws down, else what is left, in ETH as a decimal string, which each fill lowers.
 */
export type WethAllowance = { kind: 'unlimited' } | { kind: 'limited'; weth: string };

/** The wallet's public GONDI profile; `picture` is a `data:` URL, inlined by main. */
export type WalletProfile = { name: string | null; picture: string | null };

/** A collection the tasks' collection picker offers; `image` is a `data:` URL, inlined by main. */
export type CollectionOption = { slug: string; name: string; image: string | null };

/**
 * What the strategy editor shows about pricing a collection on a venue, in ETH as decimal strings:
 * the smallest price increment the venue takes (`0` when it has none), the collection's floor, its
 * cheapest ETH or WETH listing, and its top bid, the highest WETH collection bid (each `null` when
 * there is none; the top bid `undefined` when it could not be read).
 */
export type CollectionPricing = {
  priceStep: string;
  floor: string | null;
  topBid: string | null | undefined;
};

/** A saved file may still carry warnings, such as a listing that could sell under a bid's ceiling. */
export type SaveTasksResult = { ok: true; warnings: string[] } | { ok: false; errors: string[] };

/** How a cancel of every listing went: nothing listed, declined at the dialog, or mined. */
export type CancelListingsResult =
  | { outcome: 'none' }
  | { outcome: 'declined' }
  | { outcome: 'cancelled'; count: number; transactionHashes: string[] };

/** How an approval went: declined at the dialog, or sent, for `approvalMined` to wait on. */
export type ApprovalResult = { outcome: 'sent'; transactionHash: string } | { outcome: 'declined' };

/** How a collection approval went: already in place (nothing asked or sent), declined, or sent. */
export type CollectionApprovalResult = ApprovalResult | { outcome: 'alreadyApproved' };

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
  /** Lets the venue's spender spend any amount of WETH, with no limit, once confirmed. */
  approveUnlimitedWeth(venue: Venue): Promise<ApprovalResult>;
  /**
   * Resolves once the approval this session sent as `transactionHash` is mined; rejects if it
   * reverts, or if no such approval is pending.
   */
  approvalMined(transactionHash: string): Promise<void>;
  /**
   * Lets the operator GONDI listings of the `slug` collection fill through (Seaport, or the
   * collection's Seaport conduit) move its items, once confirmed; asks nothing when it already may.
   * A sent approval is waited on with `approvalMined`, like a WETH one.
   */
  approveCollection(slug: string): Promise<CollectionApprovalResult>;
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
  /** What each venue's spender may currently spend of the stored key's WETH; rejects without a key. */
  allowances(): Promise<Record<Venue, WethAllowance>>;
  /** The collections the tasks' collection picker offers, most traded first. */
  collections(): Promise<CollectionOption[]>;
  /** The pickable collections whose name or slug `query` matches, most traded first. */
  searchCollections(query: string): Promise<CollectionOption[]>;
  /**
   * The `slug` collection's price step on `venue`, its floor and its top bid; rejects for one GONDI
   * does not know.
   */
  collectionPricing(slug: string, venue: Venue): Promise<CollectionPricing>;
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
  approveUnlimitedWeth: 'market-maker:approve-unlimited-weth',
  approvalMined: 'market-maker:approval-mined',
  approveCollection: 'market-maker:approve-collection',
  cancelAllListings: 'market-maker:cancel-all-listings',
  importOpenSeaKey: 'market-maker:import-opensea-key',
  removeOpenSeaKey: 'market-maker:remove-opensea-key',
  saveRpcUrl: 'market-maker:save-rpc-url',
  removeRpcUrl: 'market-maker:remove-rpc-url',
  balances: 'market-maker:balances',
  allowances: 'market-maker:allowances',
  profile: 'market-maker:profile',
  collections: 'market-maker:collections',
  searchCollections: 'market-maker:search-collections',
  collectionPricing: 'market-maker:collection-pricing',
} as const satisfies Record<Exclude<keyof DesktopApi, 'onStatus'>, string>;

/** Main pushes a fresh `DesktopStatus` on this channel whenever a task changes state. */
export const STATUS_CHANNEL = 'market-maker:status-changed';
