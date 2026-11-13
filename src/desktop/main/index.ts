import { join } from 'node:path';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  powerSaveBlocker,
  safeStorage,
  session,
} from 'electron';
import { createPublicClient, http, type LocalAccount } from 'viem';

import { chainFrom, priceApiFrom } from '../../cli/environment';
import { VenueMarket } from '../../engine/venueMarket';
import { GondiApi } from '../../gondi/api';
import {
  collectionApproval,
  gondiFor,
  sendCollectionApproval,
  sendWethApproval,
  walletBalances,
  wethAllowances,
} from '../../gondi/client';
import { activeListingIds, cancelListings } from '../../gondi/listings';
import { GondiMarket } from '../../gondi/market';
import { OpenSeaApi } from '../../opensea/api';
import { OpenSeaMarket } from '../../opensea/market';
import { STATUS_CHANNEL } from '../api';
import { collectionPricing } from './collectionPricing';
import { pickableCollections } from './collections';
import { DesktopController } from './controller';
import { registerHandlers } from './handlers';
import { KeyVault, SecretFile, secureStorage } from './keyVault';
import { walletProfile } from './profile';
import { TasksStore } from './tasksStore';

/** How long a saved RPC URL has to answer `eth_chainId` before it is refused. */
const RPC_CHECK_TIMEOUT_MS = 10_000;
/**
 * The app's icon, GONDI's spark (`resources/icon.svg`, rendered to `icon.png`), read from the
 * package root.
 *
 * IMPLEMENTATION NOTE: `app.getAppPath()` is the directory holding the app's `package.json`, this
 * package's root under `electron-vite dev` (https://www.electronjs.org/docs/latest/api/app#appgetapppath).
 * `BrowserWindow`'s `icon` sets the window and taskbar icon on Windows and Linux; macOS ignores it
 * and takes the Dock's from `app.dock.setIcon`
 * (https://www.electronjs.org/docs/latest/api/browser-window#new-browserwindowoptions,
 * https://www.electronjs.org/docs/latest/api/dock#docksetIconimage).
 */
const iconPath = () => join(app.getAppPath(), 'resources/icon.png');

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    icon: iconPath(),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return window;
};

const keepAwake = () => {
  let blockerId: number | undefined;
  return {
    start() {
      blockerId ??= powerSaveBlocker.start('prevent-app-suspension');
    },
    stop() {
      if (blockerId !== undefined) powerSaveBlocker.stop(blockerId);
      blockerId = undefined;
    },
  };
};

/**
 * Electron's entry point: one sandboxed window over a `DesktopController` that holds the key and
 * runs the engine in main. Quitting while the bot runs withdraws its bids first, as the CLI does on
 * Ctrl+C.
 *
 * IMPLEMENTATION NOTE: the window follows Electron's security checklist
 * (https://www.electronjs.org/docs/latest/tutorial/security): context isolation, no Node
 * integration, the renderer sandbox, a CSP (in `renderer/index.html`), no new windows or
 * navigation, and every permission request denied. `powerSaveBlocker.start('prevent-app-suspension')`
 * keeps the system from suspending the app while letting the display sleep, and `stop` releases it
 * by the id `start` returned (https://www.electronjs.org/docs/latest/api/power-save-blocker).
 * `ipcMain.handle` answers the preload's `ipcRenderer.invoke` with the handler's resolved value or
 * rejects it with the thrown error (https://www.electronjs.org/docs/latest/api/ipc-main).
 */
const main = async () => {
  app.enableSandbox();
  await app.whenReady();
  app.dock?.setIcon(iconPath());
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (navigation) => navigation.preventDefault());
  });

  const chain = chainFrom(process.env);
  const priceApi = await priceApiFrom(process.env);
  const window = createWindow();
  const userData = app.getPath('userData');
  const encryption = secureStorage(safeStorage, process.platform);
  const rpcUrlFile = new SecretFile(encryption, join(userData, 'rpc-url.key'));
  const environmentRpcUrl = process.env.MARKET_MAKER_RPC_URL || undefined;
  let rpcUrl = environmentRpcUrl ?? (await rpcUrlFile.read().catch(() => null)) ?? undefined;
  const gondiOf = (account: LocalAccount) => gondiFor(account, chain, rpcUrl);
  const controller = new DesktopController({
    vault: new KeyVault(encryption, join(userData, 'wallet.key')),
    openSeaKey: new SecretFile(encryption, join(userData, 'opensea.key')),
    rpcUrl: rpcUrlFile,
    chainId: chain.id,
    rpcUrlFromEnvironment: environmentRpcUrl !== undefined,
    chainIdAt: (url) =>
      createPublicClient({
        transport: http(url, { timeout: RPC_CHECK_TIMEOUT_MS, retryCount: 0 }),
      }).getChainId(),
    useRpcUrl: (url) => {
      rpcUrl = environmentRpcUrl ?? url ?? undefined;
    },
    tasks: new TasksStore(join(userData, 'tasks.json')),
    marketFor: (account, openSeaApiKey) => {
      const market = new GondiMarket(gondiOf(account), new GondiApi(), priceApi);
      return new VenueMarket(market, {
        gondi: market,
        opensea: openSeaApiKey
          ? new OpenSeaMarket(gondiOf(account), new OpenSeaApi(openSeaApiKey), new GondiApi())
          : undefined,
      });
    },
    activeListings: (account, slugs) => activeListingIds(new GondiApi(), account.address, slugs),
    cancelListings: (account, orderIds) => cancelListings(gondiOf(account), orderIds),
    sendWethApproval: (account, amount, venue) => sendWethApproval(gondiOf(account), amount, venue),
    collectionApproval: (account, slug) =>
      collectionApproval(gondiOf(account), new GondiApi(), slug),
    sendCollectionApproval: (account, approval) =>
      sendCollectionApproval(gondiOf(account), approval),
    balancesOf: (account) => walletBalances(gondiOf(account)),
    allowancesOf: (account) => wethAllowances(gondiOf(account)),
    profileOf: (account) => walletProfile(new GondiApi(), account.address),
    pickableCollections: (searchTerm) => pickableCollections(new GondiApi(), { searchTerm }),
    collectionPricingOf: (slug, venue) => collectionPricing(new GondiApi(), slug, venue),
    confirm: async (message) => {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        buttons: ['Cancel', 'Approve'],
        defaultId: 0,
        cancelId: 0,
        message,
      });
      return response === 1;
    },
    keepAwake: keepAwake(),
    notify: (title, body) => {
      if (Notification.isSupported()) new Notification({ title, body }).show();
    },
    publish: (status) => {
      if (!window.isDestroyed()) window.webContents.send(STATUS_CHANNEL, status);
    },
  });
  registerHandlers(ipcMain, controller);

  let withdrawn = false;
  app.on('before-quit', async (event) => {
    if (withdrawn || !controller.isRunning()) return;
    event.preventDefault();
    withdrawn = true;
    await controller
      .cancelAll()
      .catch((error) => dialog.showErrorBox('Bids not withdrawn', String(error)));
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
};

void main();
