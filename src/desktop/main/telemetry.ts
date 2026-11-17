import { readFile, writeFile } from 'node:fs/promises';

import { z } from 'zod';

import type { UsageStatistics } from '../api';

/**
 * The token of the app's own PostHog project, which discards client IP addresses. A project token
 * only lets a client send events to the project, never read them, so it is meant to ship inside
 * the app.
 */
const POSTHOG_PROJECT_TOKEN = 'phc_yziycANzRjR3ttEERLnY3mZcykK4JDrqWG8Wyar8Vvrf';
const CAPTURE_URL = 'https://us.i.posthog.com/i/v0/e/';
const CAPTURE_TIMEOUT_MS = 5_000;
const HOUR_MS = 60 * 60 * 1000;

/** How many enabled tasks of each kind and venue a run starts with, and which options it uses. */
export type RunShape = {
  collection_bids: number;
  trait_bids: number;
  listings: number;
  gondi_tasks: number;
  opensea_tasks: number;
  opensea_mirrors: number;
  loss_limits: boolean;
  custom_rpc: boolean;
};

export type RunLength = 'under_1h' | '1h_to_6h' | '6h_to_24h' | 'over_24h';

export type StartFailure = 'no_wallet' | 'missing_opensea_key' | 'other';

/**
 * Every event the app can send, each with only the properties listed here: counts, flags and fixed
 * categories, never a wallet, a collection, a price or a message. The README's "Usage statistics"
 * lists the same.
 */
export type TelemetryEvent =
  | { event: 'market_maker_app_started' }
  | { event: 'market_maker_wallet_imported' }
  | { event: 'market_maker_bot_started'; properties: RunShape }
  | { event: 'market_maker_bot_stopped'; properties: { run_length: RunLength } }
  | { event: 'market_maker_bot_start_failed'; properties: { reason: StartFailure } };

/** What every event says about the install it comes from. */
export type TelemetryContext = {
  appVersion: string;
  os: string;
  arch: string;
  /** Whether this build sends at all, whatever the user chose; see `sendsUsageStatistics`. */
  sending: boolean;
};

const choiceSchema = z.object({
  installId: z.uuid(),
  enabled: z.boolean(),
  noticeShown: z.boolean(),
});

type Choice = z.output<typeof choiceSchema>;

/**
 * Whether a build sends usage statistics: only an installed app, never `dev:desktop`, and never
 * with `DO_NOT_TRACK=1` in its environment (https://consoledonottrack.com).
 */
export const sendsUsageStatistics = (packaged: boolean, environment: NodeJS.ProcessEnv) =>
  packaged && environment.DO_NOT_TRACK !== '1';

/** The bucket a run of `milliseconds` falls in, coarse so a run's length cannot single it out. */
export const runLengthOf = (milliseconds: number): RunLength =>
  milliseconds < HOUR_MS
    ? 'under_1h'
    : milliseconds < 6 * HOUR_MS
      ? '1h_to_6h'
      : milliseconds < 24 * HOUR_MS
        ? '6h_to_24h'
        : 'over_24h';

const startOfUtcDay = (moment: Date) => `${moment.toISOString().slice(0, 10)}T00:00:00.000Z`;

/**
 * The app's anonymous usage statistics: the user's choice and the random install id, kept in one
 * file of the app's data folder, and the events sent to PostHog while the user leaves them on and
 * has seen the notice that says so.
 *
 * IMPLEMENTATION NOTE: each event is one POST of JSON to PostHog's capture endpoint, carrying the
 * project token as `api_key`, the event name, a `distinct_id` and its `properties`
 * (https://posthog.com/docs/api/capture). `distinct_id` is the install id, a random UUID that
 * names no person. `$process_person_profile: false` makes the event anonymous, so PostHog creates
 * no person profile for it (https://posthog.com/docs/data/anonymous-vs-identified-events), and
 * `$geoip_disable: true` skips the location lookup from the request's IP
 * (https://posthog.com/docs/cdp/geoip-enrichment). The project is set to discard client IP data,
 * so the request's IP is not stored with the event
 * (https://posthog.com/docs/privacy/data-collection).
 * `timestamp` is the event's time, which the endpoint accepts in ISO 8601: it is cut to the start of
 * the UTC day, since bids and listings are public and a minute-precise `market_maker_bot_started` could be lined
 * up with a wallet's first bid.
 */
export class Telemetry {
  private choice: Promise<Choice> | undefined;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly path: string,
    private readonly context: TelemetryContext,
    private readonly send: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async usageStatistics(): Promise<UsageStatistics> {
    const { enabled, noticeShown } = await this.read();
    return { enabled, noticeShown };
  }

  /** Turns the statistics on or off; the switch is only offered beside the notice's text. */
  async setEnabled(enabled: boolean): Promise<UsageStatistics> {
    await this.write({ ...(await this.read()), enabled, noticeShown: true });
    return this.usageStatistics();
  }

  /** Hides the notice for good and sends the `market_maker_app_started` this launch held back until it was seen. */
  async acknowledgeNotice(): Promise<UsageStatistics> {
    const choice = await this.read();
    if (!choice.noticeShown) {
      await this.write({ ...choice, noticeShown: true });
      void this.capture({ event: 'market_maker_app_started' });
    }
    return this.usageStatistics();
  }

  /** Sends `event` when allowed; never rejects, so a caller need not wait for it nor handle it. */
  capture(event: TelemetryEvent): Promise<void> {
    const sending = this.deliver(event);
    this.pending.add(sending);
    void sending.finally(() => this.pending.delete(sending));
    return sending;
  }

  /** Waits for every capture still in flight, each capped by the capture timeout; never rejects. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private async deliver(event: TelemetryEvent): Promise<void> {
    try {
      const { installId, enabled, noticeShown } = await this.read();
      if (!this.context.sending || !enabled || !noticeShown) return;
      await this.send(CAPTURE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: POSTHOG_PROJECT_TOKEN,
          event: event.event,
          distinct_id: installId,
          timestamp: startOfUtcDay(this.now()),
          properties: {
            $process_person_profile: false,
            $geoip_disable: true,
            $lib: 'gondi-market-maker',
            app_version: this.context.appVersion,
            os: this.context.os,
            arch: this.context.arch,
            ...('properties' in event ? event.properties : {}),
          },
        }),
        signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
      });
    } catch {
      return;
    }
  }

  /**
   * The stored choice, read once; a missing or malformed file starts a fresh one, kept in memory
   * when it cannot be written.
   */
  private read() {
    this.choice ??= readFile(this.path, 'utf8')
      .then((text) => choiceSchema.parse(JSON.parse(text)))
      .catch(async () => {
        const fresh = { installId: crypto.randomUUID(), enabled: true, noticeShown: false };
        await writeFile(this.path, JSON.stringify(fresh)).catch(() => undefined);
        return fresh;
      });
    return this.choice;
  }

  private async write(choice: Choice) {
    await writeFile(this.path, JSON.stringify(choice));
    this.choice = Promise.resolve(choice);
  }
}
