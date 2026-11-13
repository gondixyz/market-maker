import { describe, expect, mock, test } from 'bun:test';
import { type Address, HttpRequestError, type LocalAccount, maxUint256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import type { DesktopStatus } from '../../src/desktop/api';
import { INVOKE_CHANNELS } from '../../src/desktop/api';
import { type ControllerDependencies, DesktopController } from '../../src/desktop/main/controller';
import { type HandlerRegistry, registerHandlers } from '../../src/desktop/main/handlers';
import type { Market, Venue } from '../../src/engine/market';
import { VenueMarket } from '../../src/engine/venueMarket';
import { OPENSEA_CONDUIT } from '../../src/opensea/market';
import { bidOf, FakeMarket, listingTaskJson, tasksFileOf } from '../fakeMarket';

const TASK = {
  id: 'pudgy',
  kind: 'collectionBid',
  collection: 'pudgypenguins',
  pricing: { mode: 'outbid' },
  minPrice: '5',
  maxPrice: '9',
};

const AZUKI: Address = '0xED5AF388653567Af2F388E6224dC7C4b3241C544';

const LOSS_LIMITS = { dailyUsd: 1_000, weeklyUsd: 5_000, since: '2029-12-01T00:00:00Z' };

const setup = ({
  account = privateKeyToAccount(generatePrivateKey()),
  confirmed = true,
  unreadable = false,
  tasksFile = tasksFileOf([TASK], { pollSeconds: 3600 }),
  openSeaApiKey = null as string | null,
  rpcUrl = null as string | null,
  rpcChainId = 1,
} = {}) => {
  let stored: LocalAccount | null = account;
  let storedOpenSeaKey = openSeaApiKey;
  let storedRpcUrl = rpcUrl;
  let storedUnreadable = unreadable;
  const market = new FakeMarket();
  const published: DesktopStatus[] = [];
  const dependencies = {
    vault: {
      isEncryptionAvailable: () => true,
      store: mock(async (privateKey: string) => {
        stored = privateKeyToAccount(privateKey as `0x${string}`);
        return stored.address;
      }),
      remove: mock(async () => {
        stored = null;
        storedUnreadable = false;
      }),
      account: async () => {
        if (storedUnreadable) throw new Error('decryption failed');
        return stored;
      },
    },
    tasks: {
      text: async () => '{}',
      save: mock(async () => ({ ok: true as const, warnings: [] })),
      load: async () => tasksFile,
    },
    openSeaKey: {
      write: mock(async (apiKey: string) => {
        storedOpenSeaKey = apiKey;
      }),
      read: async () => storedOpenSeaKey,
      remove: mock(async () => {
        storedOpenSeaKey = null;
      }),
    },
    rpcUrl: {
      write: mock(async (url: string) => {
        storedRpcUrl = url;
      }),
      read: async () => storedRpcUrl,
      remove: mock(async () => {
        storedRpcUrl = null;
      }),
    },
    chainId: 1,
    rpcUrlFromEnvironment: false,
    chainIdAt: mock(async (_url: string) => rpcChainId),
    useRpcUrl: mock((_url: string | null) => undefined),
    marketFor: mock((_account: LocalAccount, _openSeaApiKey: string | null): Market => market),
    sendWethApproval: mock(async () => ({ transactionHash: '0xhash', waitMined: async () => {} })),
    collectionApproval: mock(async (_account: LocalAccount, _slug: string) => ({
      contractAddress: AZUKI,
      operator: OPENSEA_CONDUIT,
      approved: false,
    })),
    sendCollectionApproval: mock(async () => ({
      transactionHash: '0xapproval',
      waitMined: async () => {},
    })),
    activeListings: mock(async (_account: LocalAccount, _slugs: string[]) => [11, 12]),
    cancelListings: mock(async (_account: LocalAccount, _orderIds: number[]) => ['0xcancel']),
    profileOf: mock(async (account: LocalAccount) => ({
      name: `name of ${account.address}`,
      picture: null,
    })),
    pickableCollections: mock(async (_searchTerm?: string) => [
      { slug: 'azuki', name: 'Azuki', image: null },
    ]),
    collectionPricingOf: mock(async (_slug: string, _venue: Venue) => ({
      priceStep: 10_000_000_000_000_000n,
      floor: null as bigint | null,
      topBid: null as bigint | null | undefined,
    })),
    balancesOf: async () => ({ eth: 1_250_000_000_000_000_000n, weth: 300_000_000_000_000_000n }),
    allowancesOf: async () => ({ gondi: 1_500_000_000_000_000_000n, opensea: maxUint256 }),
    confirm: mock(async () => confirmed),
    keepAwake: { start: mock(), stop: mock() },
    notify: mock(),
    publish: (status: DesktopStatus) => published.push(status),
  } satisfies ControllerDependencies;
  return { controller: new DesktopController(dependencies), dependencies, market, published };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('DesktopController', () => {
  test('reports the wallet address but never the key', async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const { controller } = setup({ account });
    const status = await controller.status();
    expect(JSON.stringify(status)).not.toContain(privateKey.slice(2));
    expect(status).toEqual({
      address: account.address,
      keyError: null,
      encryptionAvailable: true,
      openSeaKey: false,
      rpcHost: null,
      rpcUrlFromEnvironment: false,
      running: false,
      loss: null,
      tasks: [],
    });
  });

  test('starts bidding, keeps the computer awake and publishes each state change', async () => {
    const { controller, dependencies, market, published } = setup();

    await controller.start();
    await settle();

    expect(market.placed).toHaveLength(1);
    expect(dependencies.keepAwake.start).toHaveBeenCalled();
    expect(published.at(-1)?.tasks).toEqual([
      { taskId: 'pudgy', status: 'bidding', detail: 'bidding 8.01 WETH (bid 100)' },
    ]);
    await controller.stop();
  });

  test("publishes each round's loss against the loss caps", async () => {
    const { controller, published } = setup({
      tasksFile: tasksFileOf([TASK], { pollSeconds: 3600, lossLimits: LOSS_LIMITS }),
    });

    await controller.start();
    await settle();

    expect(published.at(-1)?.loss).toBe('loss today $0.00, this week $0.00');
    await controller.stop();
  });

  test('stopping leaves the bids up and lets the computer sleep', async () => {
    const { controller, dependencies, market } = setup();
    await controller.start();
    await settle();

    const status = await controller.stop();

    expect(status.running).toBe(false);
    expect(market.cancelled).toEqual([]);
    expect(dependencies.keepAwake.stop).toHaveBeenCalled();
  });

  test('cancel-all withdraws the bids even when the bot is not running', async () => {
    const { controller, market } = setup();
    await controller.start();
    await settle();
    await controller.stop();

    await controller.cancelAll();

    expect(market.cancelled).toEqual(['100']);
  });

  test('cancel-all after a key change acts as the new wallet, not the previous run', async () => {
    const { controller, dependencies } = setup();
    await controller.start();
    await settle();
    await controller.stop();
    const replacement = generatePrivateKey();

    await controller.importKey(replacement);
    await controller.cancelAll();

    expect(dependencies.marketFor.mock.calls.at(-1)?.[0].address).toBe(
      privateKeyToAccount(replacement).address,
    );
  });

  test('a cancel-all that fails to withdraw a bid still shows the bot as stopped', async () => {
    const { controller, dependencies, market } = setup();
    await controller.start();
    await settle();
    market.failNextSnapshot = true;

    await expect(controller.cancelAll()).rejects.toThrow('could not withdraw the bids of pudgy');

    expect((await controller.status()).running).toBe(false);
    expect(dependencies.keepAwake.stop).toHaveBeenCalled();
  });

  test('notifies once when a task starts waiting, not on every round', async () => {
    const { controller, dependencies, market } = setup();
    market.market.balance = 0n;

    await controller.start();
    await settle();
    await controller.stop();

    expect(dependencies.notify).toHaveBeenCalledTimes(1);
    expect(dependencies.notify).toHaveBeenCalledWith('pudgy', 'waiting: insufficientBalance');
  });

  test('reports a stored key it cannot read instead of failing, and lets it be removed', async () => {
    const { controller } = setup({ unreadable: true });

    const status = await controller.status();
    expect(status.address).toBeNull();
    expect(status.keyError).toContain('decryption failed');

    expect((await controller.removeKey()).keyError).toBeNull();
  });

  test('a stop waits out the round under way, so a restart places no second bid', async () => {
    const { controller, market } = setup();
    const placeBid = market.placeBid.bind(market);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    market.placeBid = async (bid) => {
      await gate;
      return placeBid(bid);
    };
    await controller.start();
    await settle();

    let stopped = false;
    const stopping = controller.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    release();
    await stopping;
    await controller.start();
    await settle();

    expect(market.placed).toHaveLength(1);
    await controller.stop();
  });

  test('a second start while one is under way starts one runner', async () => {
    const { controller, market } = setup();

    await Promise.all([controller.start(), controller.start()]);
    await settle();

    expect(market.placed).toHaveLength(1);
    await controller.stop();
  });

  test('refuses to swap the key or the tasks while running', async () => {
    const { controller } = setup();
    await controller.start();

    await expect(controller.importKey(generatePrivateKey())).rejects.toThrow('stop the bot');
    await expect(controller.importOpenSeaKey('a1b2c3d4e5f60718293a4b5c6d7e8f90')).rejects.toThrow(
      'stop the bot',
    );
    expect(await controller.saveTasks('{}')).toEqual({
      ok: false,
      errors: ['stop the bot before changing its tasks'],
    });
    await controller.stop();
  });

  test('reports the wallet balances in ETH', async () => {
    const { controller } = setup();

    expect(await controller.balances()).toEqual({ eth: '1.25', weth: '0.3' });
  });

  test('reports each venue allowance in ETH, and the maximum approval as unlimited', async () => {
    const { controller } = setup();

    expect(await controller.allowances()).toEqual({
      gondi: { kind: 'limited', weth: '1.5' },
      opensea: { kind: 'unlimited' },
    });
  });

  test('has no allowances to report without a key', async () => {
    const { controller, dependencies } = setup();
    await dependencies.vault.remove();

    await expect(controller.allowances()).rejects.toThrow('import the bot wallet key first');
  });

  test("reports the stored wallet's profile", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { controller, dependencies } = setup({ account });

    expect(await controller.profile()).toEqual({
      name: `name of ${account.address}`,
      picture: null,
    });

    expect(dependencies.profileOf).toHaveBeenCalledWith(account);
  });

  test('reads the picker collections once and again after a failed read', async () => {
    const { controller, dependencies } = setup();
    dependencies.pickableCollections.mockImplementationOnce(async () => {
      throw new Error('API down');
    });

    await expect(controller.collections()).rejects.toThrow('API down');
    expect(await controller.collections()).toEqual([{ slug: 'azuki', name: 'Azuki', image: null }]);
    await controller.collections();

    expect(dependencies.pickableCollections).toHaveBeenCalledTimes(2);
  });

  test('searches the picker collections afresh each time, by the trimmed query', async () => {
    const { controller, dependencies } = setup();

    await controller.searchCollections(' pudgy ');
    await controller.searchCollections(' pudgy ');

    expect(dependencies.pickableCollections.mock.calls).toEqual([['pudgy'], ['pudgy']]);
  });

  test('reads the price step, floor and top bid of the trimmed slug in ETH', async () => {
    const { controller, dependencies } = setup();
    dependencies.collectionPricingOf.mockImplementationOnce(async () => ({
      priceStep: 10_000_000_000_000_000n,
      floor: 612_000_000_000_000n,
      topBid: 300_000_000_000_000n,
    }));

    expect(await controller.collectionPricing(' azuki ', 'gondi')).toEqual({
      priceStep: '0.01',
      floor: '0.000612',
      topBid: '0.0003',
    });
    expect(dependencies.collectionPricingOf).toHaveBeenCalledWith('azuki', 'gondi');
  });

  test('reads a collection with nothing listed or bid as having no floor or top bid', async () => {
    const { controller } = setup();

    expect(await controller.collectionPricing('azuki', 'opensea')).toEqual({
      priceStep: '0.01',
      floor: null,
      topBid: null,
    });
  });

  test('keeps a top bid that could not be read apart from having none', async () => {
    const { controller, dependencies } = setup();
    dependencies.collectionPricingOf.mockImplementationOnce(async () => ({
      priceStep: 10_000_000_000_000_000n,
      floor: 612_000_000_000_000n,
      topBid: undefined,
    }));

    const pricing = await controller.collectionPricing('azuki', 'gondi');

    expect(pricing).toMatchObject({ priceStep: '0.01', floor: '0.000612' });
    expect(pricing.topBid).toBeUndefined();
  });

  test('has no balances to report without a key', async () => {
    const { controller, dependencies } = setup();
    await dependencies.vault.remove();

    await expect(controller.balances()).rejects.toThrow('import the bot wallet key first');
  });

  test('cannot start without a key', async () => {
    const { controller, dependencies } = setup();
    await dependencies.vault.remove();

    await expect(controller.start()).rejects.toThrow('import the bot wallet key first');
  });

  test('approves WETH only after the user confirms', async () => {
    const { controller, dependencies } = setup();

    expect(await controller.approveWeth('1.5', 'gondi')).toEqual({
      outcome: 'sent',
      transactionHash: '0xhash',
    });
    expect(dependencies.sendWethApproval).toHaveBeenCalledWith(
      expect.anything(),
      1_500_000_000_000_000_000n,
      'gondi',
    );
  });

  test("names OpenSea's conduit when approving WETH for OpenSea bids", async () => {
    const { controller, dependencies } = setup();

    await controller.approveWeth('1.5', 'opensea');

    expect(dependencies.confirm).toHaveBeenCalledWith(
      expect.stringMatching(/^Let OpenSea's conduit spend/),
    );
  });

  test('approves a collection only after the user confirms, naming its operator', async () => {
    const { controller, dependencies } = setup();

    expect(await controller.approveCollection(' azuki ')).toEqual({
      outcome: 'sent',
      transactionHash: '0xapproval',
    });
    expect(dependencies.collectionApproval).toHaveBeenCalledWith(expect.anything(), 'azuki');
    expect(dependencies.confirm).toHaveBeenCalledWith(
      expect.stringMatching(/^Let OpenSea's conduit move every azuki item/),
    );
    expect(dependencies.sendCollectionApproval).toHaveBeenCalledWith(expect.anything(), {
      contractAddress: AZUKI,
      operator: OPENSEA_CONDUIT,
      approved: false,
    });
    await controller.approvalMined('0xapproval');
  });

  test('asks nothing when the collection is already approved', async () => {
    const { controller, dependencies } = setup();
    dependencies.collectionApproval.mockImplementation(async () => ({
      contractAddress: AZUKI,
      operator: OPENSEA_CONDUIT,
      approved: true,
    }));

    expect(await controller.approveCollection('azuki')).toEqual({ outcome: 'alreadyApproved' });
    expect(dependencies.confirm).not.toHaveBeenCalled();
    expect(dependencies.sendCollectionApproval).not.toHaveBeenCalled();
  });

  test('sends no collection approval when the user declines it', async () => {
    const { controller, dependencies } = setup({ confirmed: false });

    expect(await controller.approveCollection('azuki')).toEqual({ outcome: 'declined' });
    expect(dependencies.sendCollectionApproval).not.toHaveBeenCalled();
  });

  test('rejects a blank collection before reading anything', async () => {
    const { controller, dependencies } = setup();

    await expect(controller.approveCollection('  ')).rejects.toThrow('pick a collection first');
    expect(dependencies.collectionApproval).not.toHaveBeenCalled();
  });

  test('stores the OpenSea API key and only says that it has one', async () => {
    const { controller, dependencies } = setup();
    const apiKey = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

    const status = await controller.importOpenSeaKey(` ${apiKey}\n`);

    expect(dependencies.openSeaKey.write).toHaveBeenCalledWith(apiKey);
    expect(status.openSeaKey).toBe(true);
    expect(JSON.stringify(status)).not.toContain(apiKey);
  });

  test.each(['', 'short', 'has spaces in it but is long enough'])(
    'rejects %p as an OpenSea API key',
    async (apiKey) => {
      const { controller, dependencies } = setup();

      await expect(controller.importOpenSeaKey(apiKey)).rejects.toThrow('OpenSea API key');
      expect(dependencies.openSeaKey.write).not.toHaveBeenCalled();
    },
  );

  test('saves an RPC URL that serves the chain, uses it, and shows only its host', async () => {
    const { controller, dependencies } = setup();
    const url = 'https://eth-mainnet.example.com/v2/secret-key';

    const status = await controller.saveRpcUrl(` ${url}\n`);

    expect(dependencies.chainIdAt).toHaveBeenCalledWith(url);
    expect(dependencies.rpcUrl.write).toHaveBeenCalledWith(url);
    expect(dependencies.useRpcUrl).toHaveBeenCalledWith(url);
    expect(status.rpcHost).toBe('eth-mainnet.example.com');
    expect(JSON.stringify(status)).not.toContain('secret-key');
  });

  test.each([
    ['not a URL', 'eth mainnet', 'expected an RPC URL'],
    ['a websocket URL', 'wss://eth.example.com', 'expected an http(s) RPC URL'],
  ])('refuses %s as an RPC URL', async (_case, url, message) => {
    const { controller, dependencies } = setup();

    await expect(controller.saveRpcUrl(url)).rejects.toThrow(message);
    expect(dependencies.rpcUrl.write).not.toHaveBeenCalled();
  });

  test('refuses an RPC URL of another chain', async () => {
    const { controller, dependencies } = setup({ rpcChainId: 8453 });

    await expect(controller.saveRpcUrl('https://base.example.com')).rejects.toThrow(
      'base.example.com serves chain 8453, not chain 1',
    );
    expect(dependencies.rpcUrl.write).not.toHaveBeenCalled();
  });

  test.each([
    ['an error', (url: string) => new Error(`timed out\nURL: ${url}`), 'no answer'],
    [
      "viem's HTTP error",
      (url: string) => new HttpRequestError({ url, status: 401 }),
      'HTTP request failed.',
    ],
  ])(
    'refuses an RPC URL that answers with %s, without sending its key to the window',
    async (_case, failure, reason) => {
      const { controller, dependencies } = setup();
      const url = 'https://down.example.com/v2/secret-key';
      dependencies.chainIdAt.mockImplementationOnce(async () => {
        throw failure(url);
      });

      const error = await controller.saveRpcUrl(url).catch((rejection: unknown) => rejection);

      expect(String(error)).toContain(
        `down.example.com did not answer as an Ethereum RPC: ${reason}`,
      );
      expect(String(error)).not.toContain('secret-key');
      expect(dependencies.useRpcUrl).not.toHaveBeenCalled();
    },
  );

  test('saves no RPC URL when the bot started while the URL was being checked', async () => {
    const { controller, dependencies } = setup();
    let answer = (_chainId: number) => {};
    dependencies.chainIdAt.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          answer = resolve;
        }),
    );

    const saving = controller.saveRpcUrl('https://slow.example.com');
    await controller.start();
    answer(1);

    await expect(saving).rejects.toThrow('stop the bot before changing the RPC URL');
    expect(dependencies.rpcUrl.write).not.toHaveBeenCalled();
    expect(dependencies.useRpcUrl).not.toHaveBeenCalled();
    await controller.stop();
  });

  test('shows the saved RPC URL by host, and removing it goes back to the default', async () => {
    const { controller, dependencies } = setup({ rpcUrl: 'https://rpc.example.com/key' });

    expect((await controller.status()).rpcHost).toBe('rpc.example.com');
    expect((await controller.removeRpcUrl()).rpcHost).toBeNull();
    expect(dependencies.useRpcUrl).toHaveBeenCalledWith(null);
  });

  test('will not change the RPC URL while the bot runs', async () => {
    const { controller } = setup();
    await controller.start();

    await expect(controller.saveRpcUrl('https://rpc.example.com')).rejects.toThrow(
      'changing the RPC URL',
    );
    await controller.stop();
  });

  test('removes the OpenSea API key', async () => {
    const { controller } = setup({ openSeaApiKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' });

    expect((await controller.removeOpenSeaKey()).openSeaKey).toBe(false);
  });

  test('will not start OpenSea bids without an OpenSea API key', async () => {
    const { controller } = setup({
      tasksFile: tasksFileOf([{ ...TASK, venue: 'opensea', maxItems: 1 }], { pollSeconds: 3600 }),
    });

    await expect(controller.start()).rejects.toThrow('add your OpenSea API key');
  });

  test('cancel-all without an OpenSea API key still withdraws the GONDI bids', async () => {
    const { controller, dependencies, market } = setup({
      tasksFile: tasksFileOf(
        [TASK, { ...TASK, id: 'pudgy-opensea', venue: 'opensea', maxItems: 1 }],
        { pollSeconds: 3600 },
      ),
    });
    dependencies.marketFor.mockImplementation(() => new VenueMarket(market, { gondi: market }));
    market.ownBids.push(bidOf({ id: '7' }));

    await expect(controller.cancelAll()).rejects.toThrow(
      'could not withdraw the bids of pudgy-opensea: Error: bids on opensea',
    );

    expect(market.cancelled).toEqual(['7']);
  });

  test('starts without an OpenSea API key when its OpenSea strategies are disabled', async () => {
    const { controller } = setup({
      tasksFile: tasksFileOf([{ ...TASK, venue: 'opensea', maxItems: 1, enabled: false }], {
        pollSeconds: 3600,
      }),
    });

    expect((await controller.start()).running).toBe(true);
    await controller.stop();
  });

  test('hands the OpenSea API key to the market it runs on', async () => {
    const apiKey = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const { controller, dependencies } = setup({
      openSeaApiKey: apiKey,
      tasksFile: tasksFileOf([{ ...TASK, venue: 'opensea', maxItems: 1 }], { pollSeconds: 3600 }),
    });

    await controller.start();
    await controller.stop();

    expect(dependencies.marketFor).toHaveBeenCalledWith(expect.anything(), apiKey);
  });

  test("cancels the listings of the strategies' collections once confirmed, stopping the bot first", async () => {
    const { controller, dependencies } = setup({
      tasksFile: tasksFileOf([TASK, listingTaskJson({ collection: 'azuki' })], {
        pollSeconds: 3600,
      }),
    });
    await controller.start();

    const result = await controller.cancelAllListings();

    expect({
      result,
      slugs: dependencies.activeListings.mock.calls[0][1],
      cancelled: dependencies.cancelListings.mock.calls[0][1],
      running: (await controller.status()).running,
    }).toEqual({
      result: { outcome: 'cancelled', count: 2, transactionHashes: ['0xcancel'] },
      slugs: ['azuki'],
      cancelled: [11, 12],
      running: false,
    });
    expect(dependencies.confirm).toHaveBeenCalledWith(
      expect.stringMatching(/^Cancel 2 GONDI listings of azuki .*costs gas.*The bot stops first/s),
    );
  });

  test('cancels the listings a running round placed while the dialog was open', async () => {
    const { controller, dependencies } = setup({
      tasksFile: tasksFileOf([listingTaskJson({ collection: 'azuki' })], { pollSeconds: 3600 }),
    });
    dependencies.activeListings
      .mockImplementationOnce(async () => [11, 12])
      .mockImplementationOnce(async () => [11, 12, 13]);
    await controller.start();

    const result = await controller.cancelAllListings();

    expect({ result, cancelled: dependencies.cancelListings.mock.calls[0][1] }).toEqual({
      result: { outcome: 'cancelled', count: 3, transactionHashes: ['0xcancel'] },
      cancelled: [11, 12, 13],
    });
  });

  test('sends nothing when the user declines cancelling the listings', async () => {
    const { controller, dependencies } = setup({ confirmed: false });

    expect(await controller.cancelAllListings()).toEqual({ outcome: 'declined' });
    expect(dependencies.cancelListings).not.toHaveBeenCalled();
  });

  test('asks nothing when no listing is active', async () => {
    const { controller, dependencies } = setup();
    dependencies.activeListings.mockImplementation(async () => []);

    expect(await controller.cancelAllListings()).toEqual({ outcome: 'none' });
    expect(dependencies.confirm).not.toHaveBeenCalled();
  });

  test('approves the maximum WETH allowance after the user confirms an unlimited approval', async () => {
    const { controller, dependencies } = setup();

    expect(await controller.approveUnlimitedWeth('opensea')).toEqual({
      outcome: 'sent',
      transactionHash: '0xhash',
    });
    expect(dependencies.confirm).toHaveBeenCalledWith(
      expect.stringMatching(/^Let OpenSea's conduit spend any amount of WETH .* with no limit/),
    );
    expect(dependencies.sendWethApproval).toHaveBeenCalledWith(
      expect.anything(),
      maxUint256,
      'opensea',
    );
  });

  test('sends nothing when the user declines the unlimited approval', async () => {
    const { controller, dependencies } = setup({ confirmed: false });

    expect(await controller.approveUnlimitedWeth('gondi')).toEqual({ outcome: 'declined' });
    expect(dependencies.sendWethApproval).not.toHaveBeenCalled();
  });

  test('waits for an approval it sent until it is mined, and only once', async () => {
    const { controller, dependencies } = setup();
    let mine = () => {};
    const mined = new Promise<void>((resolve) => {
      mine = resolve;
    });
    dependencies.sendWethApproval.mockImplementationOnce(async () => ({
      transactionHash: '0xpending',
      waitMined: () => mined,
    }));
    await controller.approveWeth('1.5', 'gondi');
    let settled = false;

    const waiting = controller.approvalMined('0xpending').then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    mine();
    await waiting;

    expect(settled).toBe(true);
    await expect(controller.approvalMined('0xpending')).rejects.toThrow('no approval 0xpending');
  });

  test('reports a reverted approval to the window that waits on it', async () => {
    const { controller, dependencies } = setup();
    dependencies.sendWethApproval.mockImplementationOnce(async () => ({
      transactionHash: '0xreverted',
      waitMined: async () => {
        throw new Error('transaction reverted');
      },
    }));
    await controller.approveUnlimitedWeth('gondi');

    await expect(controller.approvalMined('0xreverted')).rejects.toThrow('transaction reverted');
  });

  test('waits on no hash it did not send', async () => {
    const { controller } = setup();

    await expect(controller.approvalMined('0xunknown')).rejects.toThrow('no approval 0xunknown');
  });

  test('sends nothing when the user declines the approval', async () => {
    const { controller, dependencies } = setup({ confirmed: false });

    expect(await controller.approveWeth('1.5', 'gondi')).toEqual({ outcome: 'declined' });
    expect(dependencies.sendWethApproval).not.toHaveBeenCalled();
  });

  test.each(['', '0', '-1', 'lots', '1e18'])(
    'rejects %p as an approval amount before asking',
    async (amount) => {
      const { controller, dependencies } = setup();

      await expect(controller.approveWeth(amount, 'gondi')).rejects.toThrow('positive ETH amount');
      expect(dependencies.confirm).not.toHaveBeenCalled();
    },
  );
});

describe('registerHandlers', () => {
  const recorder = () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const registry: HandlerRegistry = {
      handle: (channel, listener) => handlers.set(channel, listener),
    };
    return { handlers, registry };
  };

  test('handles exactly the declared channels', () => {
    const { handlers, registry } = recorder();
    registerHandlers(registry, setup().controller);
    expect([...handlers.keys()].sort()).toEqual(Object.values(INVOKE_CHANNELS).sort());
  });

  test('passes string arguments through and rejects anything else', async () => {
    const { handlers, registry } = recorder();
    const { controller, dependencies } = setup();
    registerHandlers(registry, controller);
    const saveTasks = handlers.get(INVOKE_CHANNELS.saveTasks)!;

    await saveTasks({}, '{"version":1}');
    expect(dependencies.tasks.save).toHaveBeenCalledWith('{"version":1}');
    expect(() => saveTasks({}, { version: 1 })).toThrow('expected a string argument');
  });

  test('rejects a venue it does not know', () => {
    const { handlers, registry } = recorder();
    registerHandlers(registry, setup().controller);

    expect(() => handlers.get(INVOKE_CHANNELS.approveWeth)!({}, '1', 'blur')).toThrow(
      'expected one of gondi, opensea',
    );
  });
});
