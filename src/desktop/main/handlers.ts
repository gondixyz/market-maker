import { VENUES } from '../../engine/market';
import { type DesktopApi, INVOKE_CHANNELS } from '../api';
import type { DesktopController } from './controller';

/** The part of Electron's `ipcMain` the handlers use; tests pass a recorder. */
export type HandlerRegistry = {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

/** The app's own update check, outside the controller since it touches neither key nor bot. */
export type UpdateHandlers = Pick<DesktopApi, 'availableUpdate' | 'openLatestRelease'>;

/** Anonymous usage statistics, outside the controller since they touch neither key nor bot. */
export type UsageStatisticsHandlers = Pick<
  DesktopApi,
  'usageStatistics' | 'setUsageStatistics' | 'acknowledgeUsageNotice'
>;

const asString = (value: unknown) => {
  if (typeof value !== 'string') throw new Error('expected a string argument');
  return value;
};

const asBoolean = (value: unknown) => {
  if (typeof value !== 'boolean') throw new Error('expected a boolean argument');
  return value;
};

/** A trait bid's `{ type, value }`, or `undefined` for none. */
const asTrait = (value: unknown) => {
  if (value === undefined) return undefined;
  const { type, value: name } = (value ?? {}) as { type?: unknown; value?: unknown };
  return { type: asString(type), value: asString(name) };
};

const asVenue = (value: unknown) => {
  const venue = VENUES.find((known) => known === value);
  if (!venue) throw new Error(`expected one of ${VENUES.join(', ')}`);
  return venue;
};

/**
 * Binds each `INVOKE_CHANNELS` channel to its controller, update or usage statistics method, checking the arguments the few
 * calls that take any receive. Nothing else is reachable over IPC.
 */
export const registerHandlers = (
  ipc: HandlerRegistry,
  controller: DesktopController,
  updates: UpdateHandlers,
  usage: UsageStatisticsHandlers,
) => {
  ipc.handle(INVOKE_CHANNELS.status, () => controller.status());
  ipc.handle(INVOKE_CHANNELS.importKey, (_event, privateKey) =>
    controller.importKey(asString(privateKey)),
  );
  ipc.handle(INVOKE_CHANNELS.removeKey, () => controller.removeKey());
  ipc.handle(INVOKE_CHANNELS.loadTasks, () => controller.loadTasks());
  ipc.handle(INVOKE_CHANNELS.saveTasks, (_event, text) => controller.saveTasks(asString(text)));
  ipc.handle(INVOKE_CHANNELS.start, () => controller.start());
  ipc.handle(INVOKE_CHANNELS.stop, () => controller.stop());
  ipc.handle(INVOKE_CHANNELS.cancelAll, () => controller.cancelAll());
  ipc.handle(INVOKE_CHANNELS.balances, () => controller.balances());
  ipc.handle(INVOKE_CHANNELS.allowances, () => controller.allowances());
  ipc.handle(INVOKE_CHANNELS.profile, () => controller.profile());
  ipc.handle(INVOKE_CHANNELS.collections, () => controller.collections());
  ipc.handle(INVOKE_CHANNELS.searchCollections, (_event, query) =>
    controller.searchCollections(asString(query)),
  );
  ipc.handle(INVOKE_CHANNELS.collectionPricing, (_event, slug, venue, trait) =>
    controller.collectionPricing(asString(slug), asVenue(venue), asTrait(trait)),
  );
  ipc.handle(INVOKE_CHANNELS.collectionTraits, (_event, slug) =>
    controller.collectionTraits(asString(slug)),
  );
  ipc.handle(INVOKE_CHANNELS.cancelAllListings, () => controller.cancelAllListings());
  ipc.handle(INVOKE_CHANNELS.approveWeth, (_event, amount, venue) =>
    controller.approveWeth(asString(amount), asVenue(venue)),
  );
  ipc.handle(INVOKE_CHANNELS.approveUnlimitedWeth, (_event, venue) =>
    controller.approveUnlimitedWeth(asVenue(venue)),
  );
  ipc.handle(INVOKE_CHANNELS.approvalMined, (_event, transactionHash) =>
    controller.approvalMined(asString(transactionHash)),
  );
  ipc.handle(INVOKE_CHANNELS.approveCollection, (_event, slug) =>
    controller.approveCollection(asString(slug)),
  );
  ipc.handle(INVOKE_CHANNELS.importOpenSeaKey, (_event, apiKey) =>
    controller.importOpenSeaKey(asString(apiKey)),
  );
  ipc.handle(INVOKE_CHANNELS.removeOpenSeaKey, () => controller.removeOpenSeaKey());
  ipc.handle(INVOKE_CHANNELS.saveRpcUrl, (_event, url) => controller.saveRpcUrl(asString(url)));
  ipc.handle(INVOKE_CHANNELS.removeRpcUrl, () => controller.removeRpcUrl());
  ipc.handle(INVOKE_CHANNELS.availableUpdate, () => updates.availableUpdate());
  ipc.handle(INVOKE_CHANNELS.openLatestRelease, () => updates.openLatestRelease());
  ipc.handle(INVOKE_CHANNELS.usageStatistics, () => usage.usageStatistics());
  ipc.handle(INVOKE_CHANNELS.setUsageStatistics, (_event, enabled) =>
    usage.setUsageStatistics(asBoolean(enabled)),
  );
  ipc.handle(INVOKE_CHANNELS.acknowledgeUsageNotice, () => usage.acknowledgeUsageNotice());
};
