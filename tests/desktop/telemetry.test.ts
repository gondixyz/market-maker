import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, mock, test } from 'bun:test';

import {
  type RunLength,
  runLengthOf,
  sendsUsageStatistics,
  Telemetry,
  type TelemetryEvent,
} from '../../src/desktop/main/telemetry';

const CONTEXT = { appVersion: '0.3.0', os: 'darwin', arch: 'arm64', sending: true };
const NOW = new Date('2030-03-04T14:03:12.345Z');

const setup = async ({ sending = true, file = undefined as object | string | undefined } = {}) => {
  const path = join(await mkdtemp(join(tmpdir(), 'telemetry-')), 'telemetry.json');
  if (file !== undefined) {
    await writeFile(path, typeof file === 'string' ? file : JSON.stringify(file));
  }
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const send = mock(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response('{}');
  });
  const telemetry = new Telemetry(
    path,
    { ...CONTEXT, sending },
    send as unknown as typeof fetch,
    () => NOW,
  );
  return { telemetry, path, requests, send };
};

const stored = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

const BOT_STARTED: TelemetryEvent = {
  event: 'market_maker_bot_started',
  properties: {
    collection_bids: 2,
    trait_bids: 1,
    listings: 1,
    gondi_tasks: 3,
    opensea_tasks: 1,
    opensea_mirrors: 0,
    loss_limits: true,
    custom_rpc: false,
  },
};

describe('Telemetry', () => {
  test('flush waits for a capture still in flight', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'telemetry-')), 'telemetry.json');
    await writeFile(
      path,
      JSON.stringify({ installId: crypto.randomUUID(), enabled: true, noticeShown: true }),
    );
    let finish: () => void = () => undefined;
    let delivered = false;
    const send = async () => {
      await new Promise<void>((resolve) => (finish = resolve));
      delivered = true;
      return new Response('{}');
    };
    const telemetry = new Telemetry(path, CONTEXT, send as unknown as typeof fetch, () => NOW);

    void telemetry.capture({
      event: 'market_maker_bot_stopped',
      properties: { run_length: 'over_24h' },
    });
    const flushed = telemetry.flush();
    await Bun.sleep(20);
    expect(delivered).toBe(false);
    finish();
    await flushed;

    expect(delivered).toBe(true);
  });

  test('a first read stores a random install id, on, with the notice not yet shown', async () => {
    const { telemetry, path } = await setup();

    expect(await telemetry.usageStatistics()).toEqual({ enabled: true, noticeShown: false });
    const { installId, enabled, noticeShown } = await stored(path);
    expect(installId).toMatch(/^[0-9a-f-]{36}$/);
    expect({ enabled, noticeShown }).toEqual({ enabled: true, noticeShown: false });
  });

  test('a malformed file is replaced by a fresh one', async () => {
    const { telemetry, path } = await setup({ file: '{"installId": 3' });

    expect(await telemetry.usageStatistics()).toEqual({ enabled: true, noticeShown: false });
    expect((await stored(path)).installId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('sends nothing before the notice is acknowledged, then the held back app_started', async () => {
    const { telemetry, requests } = await setup();

    await telemetry.capture({ event: 'market_maker_app_started' });
    expect(requests).toEqual([]);

    expect(await telemetry.acknowledgeNotice()).toEqual({ enabled: true, noticeShown: true });
    await Bun.sleep(0);
    expect(requests.map((request) => request.body.event)).toEqual(['market_maker_app_started']);

    await telemetry.acknowledgeNotice();
    await Bun.sleep(0);
    expect(requests).toHaveLength(1);
  });

  test('sends nothing once turned off, which also counts as the notice seen', async () => {
    const { telemetry, path, requests } = await setup();

    expect(await telemetry.setEnabled(false)).toEqual({ enabled: false, noticeShown: true });
    await telemetry.capture(BOT_STARTED);

    expect(requests).toEqual([]);
    expect(await stored(path)).toMatchObject({ enabled: false, noticeShown: true });
  });

  test('sends nothing from a build that does not send, whatever the choice', async () => {
    const installId = crypto.randomUUID();
    const { telemetry, requests } = await setup({
      sending: false,
      file: { installId, enabled: true, noticeShown: true },
    });

    await telemetry.capture(BOT_STARTED);

    expect(requests).toEqual([]);
  });

  test('sends the event anonymously, with the base properties and a day-precise time', async () => {
    const installId = crypto.randomUUID();
    const { telemetry, requests } = await setup({
      file: { installId, enabled: true, noticeShown: true },
    });

    await telemetry.capture(BOT_STARTED);

    expect(requests).toEqual([
      {
        url: 'https://us.i.posthog.com/i/v0/e/',
        body: {
          api_key: expect.any(String),
          event: 'market_maker_bot_started',
          distinct_id: installId,
          timestamp: '2030-03-04T00:00:00.000Z',
          properties: {
            $process_person_profile: false,
            $geoip_disable: true,
            $lib: 'gondi-market-maker',
            app_version: '0.3.0',
            os: 'darwin',
            arch: 'arm64',
            ...BOT_STARTED.properties,
          },
        },
      },
    ]);
  });

  test('never rejects when PostHog cannot be reached', async () => {
    const { telemetry, send } = await setup({
      file: { installId: crypto.randomUUID(), enabled: true, noticeShown: true },
    });
    send.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });

    await telemetry.capture({ event: 'market_maker_wallet_imported' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('sendsUsageStatistics', () => {
  test.each([
    [true, {}, true],
    [true, { DO_NOT_TRACK: '0' }, true],
    [true, { DO_NOT_TRACK: '1' }, false],
    [false, {}, false],
  ])('packaged %p with %p sends %p', (packaged, environment, expected) => {
    expect(sendsUsageStatistics(packaged, environment)).toBe(expected);
  });
});

describe('runLengthOf', () => {
  const HOUR = 60 * 60 * 1000;
  test.each<[number, RunLength]>([
    [5 * 60 * 1000, 'under_1h'],
    [HOUR, '1h_to_6h'],
    [6 * HOUR - 1, '1h_to_6h'],
    [6 * HOUR, '6h_to_24h'],
    [24 * HOUR, 'over_24h'],
  ])('%p ms is %p', (milliseconds, expected) => {
    expect(runLengthOf(milliseconds)).toBe(expected);
  });
});
