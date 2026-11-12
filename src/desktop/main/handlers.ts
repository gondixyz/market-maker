import { VENUES } from '../../engine/market';
import { INVOKE_CHANNELS } from '../api';
import type { DesktopController } from './controller';

/** The part of Electron's `ipcMain` the handlers use; tests pass a recorder. */
export type HandlerRegistry = {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

const asString = (value: unknown) => {
  if (typeof value !== 'string') throw new Error('expected a string argument');
  return value;
};

const asVenue = (value: unknown) => {
  const venue = VENUES.find((known) => known === value);
  if (!venue) throw new Error(`expected one of ${VENUES.join(', ')}`);
  return venue;
};

/**
 * Binds each `INVOKE_CHANNELS` channel to its controller method, checking the arguments the few
 * calls that take any receive. Nothing else is reachable over IPC.
 */
export const registerHandlers = (ipc: HandlerRegistry, controller: DesktopController) => {
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
  ipc.handle(INVOKE_CHANNELS.profile, () => controller.profile());
  ipc.handle(INVOKE_CHANNELS.collections, () => controller.collections());
  ipc.handle(INVOKE_CHANNELS.searchCollections, (_event, query) =>
    controller.searchCollections(asString(query)),
  );
  ipc.handle(INVOKE_CHANNELS.cancelAllListings, () => controller.cancelAllListings());
  ipc.handle(INVOKE_CHANNELS.approveWeth, (_event, amount, venue) =>
    controller.approveWeth(asString(amount), asVenue(venue)),
  );
  ipc.handle(INVOKE_CHANNELS.importOpenSeaKey, (_event, apiKey) =>
    controller.importOpenSeaKey(asString(apiKey)),
  );
  ipc.handle(INVOKE_CHANNELS.removeOpenSeaKey, () => controller.removeOpenSeaKey());
  ipc.handle(INVOKE_CHANNELS.saveRpcUrl, (_event, url) => controller.saveRpcUrl(asString(url)));
  ipc.handle(INVOKE_CHANNELS.removeRpcUrl, () => controller.removeRpcUrl());
};
