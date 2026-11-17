import { z } from 'zod';

/** The page a newer version downloads from: the public repository's latest release. */
export const LATEST_RELEASE_URL = 'https://github.com/gondixyz/market-maker/releases/latest';

const LATEST_RELEASE_API = 'https://api.github.com/repos/gondixyz/market-maker/releases/latest';
const RELEASE_CHECK_TIMEOUT_MS = 10_000;

/** A `major.minor.patch` version, each part a number, so versions compare part by part. */
type Version = readonly [number, number, number];

const versionSchema = z
  .string()
  .regex(/^v?\d+\.\d+\.\d+$/)
  .transform((text) => text.replace(/^v/, '').split('.').map(Number) as unknown as Version);

const latestReleaseSchema = z.object({ tag_name: versionSchema });

const isNewer = (candidate: Version, current: Version) => {
  const differing = candidate.findIndex((part, index) => part !== current[index]);
  return differing !== -1 && candidate[differing]! > current[differing]!;
};

/**
 * The latest release's version, without its `v`, when it is newer than `currentVersion`; `null`
 * when this app is up to date. Rejects when the release cannot be read.
 *
 * IMPLEMENTATION NOTE: GitHub's "Get the latest release" endpoint answers the newest published,
 * non-draft, non-prerelease release as JSON whose `tag_name` is its tag, `v0.2.1` for this
 * repository's releases (https://docs.github.com/en/rest/releases/releases#get-the-latest-release).
 * Unauthenticated calls are limited to 60 an hour per IP address
 * (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), far above
 * what a check every few hours spends.
 */
export const availableUpdate = async (
  currentVersion: string,
  download: typeof fetch = fetch,
): Promise<string | null> => {
  const response = await download(LATEST_RELEASE_API, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(RELEASE_CHECK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const { tag_name: latest } = latestReleaseSchema.parse(await response.json());
  return isNewer(latest, versionSchema.parse(currentVersion)) ? latest.join('.') : null;
};
