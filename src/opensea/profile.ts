import type { LocalAccount } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { z } from 'zod';

const SITE_URL = 'https://opensea.io';
const GRAPHQL_URL = 'https://gql.opensea.io/graphql';
/** What opensea.io asks a wallet to sign; signing it accepts OpenSea's terms, as the site does. */
const STATEMENT =
  'Click to sign in and accept the Platform Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).';
const USER_AGENT = 'gondi-market-maker';

const CLAIM_USERNAME = `mutation ClaimAccountUsername($username: String!) {
  claimAccountUsername(username: $username) {
    __typename
    ... on ClaimAccountUsernameError { reason }
  }
}`;

const UPDATE_PROFILE = `mutation UpdateProfileSettings($address: Address!, $newSettings: ProfileSettingsInput!, $target: ProfileTargetType) {
  updateProfileSettings(address: $address, newSettings: $newSettings, target: $target) { displayName }
}`;

const nonceResponse = z.object({ nonce: z.string() });

const graphqlResponse = z.object({
  data: z.record(z.string(), z.unknown()).nullish(),
  errors: z.array(z.object({ message: z.string() })).nullish(),
});

const claimResult = z.object({ __typename: z.string(), reason: z.string().nullish() });

/** The `name=value` pairs of a response's `Set-Cookie` headers, attributes left out. */
const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

/** The refusal OpenSea gives a wallet whose username is already set: opensea.io moves on from it. */
const ALREADY_CLAIMED = 'ALREADY_HAS_ACCOUNT_PROFILE';

/**
 * Signs in to opensea.io as `account`, claims `username` for it and sets its display name: the name
 * OpenSea shows on the wallet's offers instead of its address. Resolves with whether the username
 * was claimed: a wallet that already has one keeps it and only gets the display name, as on
 * opensea.io. Any other refusal of the username (`USERNAME_TAKEN`, `INVALID_FORMAT`) throws before
 * the display name is touched, and so does a display name outside `[a-zA-Z0-9_-]`.
 *
 * IMPLEMENTATION NOTE: OpenSea's public API has no profile endpoint, so this replays what opensea.io
 * itself sends, read from its JavaScript bundles on 2026-11-11 and checked end to end against
 * production with a throwaway wallet. It is undocumented and may change without notice.
 *
 * - `POST https://opensea.io/__api/auth/siwe/nonce` answers `{ "nonce": "..." }`.
 * - The wallet signs an EIP-4361 message (https://eips.ethereum.org/EIPS/eip-4361) for domain
 *   `opensea.io`, chain 1, with the site's statement; viem's `createSiweMessage` writes it
 *   (https://viem.sh/docs/siwe/utilities/createSiweMessage).
 * - `POST https://opensea.io/__api/auth/siwe/verify` takes `{ message, signature, chainArch:
 *   "EVM", connectorId }`, where `message` is the signed text parsed into its fields, every value
 *   a string; it answers with the user and sets the session as `access_token` and `refresh_token`
 *   cookies.
 * - With those cookies and the header `x-app-id: os2-web`, `POST https://gql.opensea.io/graphql`
 *   runs the site's `claimAccountUsername(username)` mutation, which answers
 *   `ClaimAccountUsernameSuccess` or `ClaimAccountUsernameError { reason }`, and
 *   `updateProfileSettings(address, newSettings: { displayName }, target: ACCOUNT)`.
 */
export const setOpenSeaProfile = async ({
  account,
  username,
  displayName,
  send = fetch,
}: {
  account: LocalAccount;
  username: string;
  displayName: string;
  send?: typeof fetch;
}) => {
  const headers = { 'user-agent': USER_AGENT, origin: SITE_URL, referer: `${SITE_URL}/` };
  const nonceReply = await send(`${SITE_URL}/__api/auth/siwe/nonce`, { method: 'POST', headers });
  if (!nonceReply.ok) throw new Error(`OpenSea refused a sign-in nonce: HTTP ${nonceReply.status}`);
  const { nonce } = nonceResponse.parse(await nonceReply.json());

  const fields = {
    domain: 'opensea.io',
    address: account.address,
    statement: STATEMENT,
    uri: `${SITE_URL}/`,
    version: '1' as const,
    chainId: 1,
    nonce,
    issuedAt: new Date(),
  };
  const signature = await account.signMessage({ message: createSiweMessage(fields) });
  const verify = await send(`${SITE_URL}/__api/auth/siwe/verify`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        ...fields,
        chainId: String(fields.chainId),
        issuedAt: fields.issuedAt.toISOString(),
        accountType: 'Ethereum',
      },
      signature,
      chainArch: 'EVM',
      connectorId: 'io.metamask',
    }),
  });
  if (!verify.ok) throw new Error(`OpenSea refused the sign-in: HTTP ${verify.status}`);
  const cookie = cookiesOf(verify);

  const mutate = async (query: string, variables: object) => {
    const response = await send(GRAPHQL_URL, {
      method: 'POST',
      headers: { ...headers, cookie, 'content-type': 'application/json', 'x-app-id': 'os2-web' },
      body: JSON.stringify({ query, variables }),
    });
    const { data, errors } = graphqlResponse.parse(await response.json());
    if (!response.ok || errors?.length || !data) {
      throw new Error(
        `OpenSea refused the profile change: ${errors?.[0]?.message ?? `HTTP ${response.status}`}`,
      );
    }
    return data;
  };

  const claim = claimResult.parse(
    (await mutate(CLAIM_USERNAME, { username })).claimAccountUsername,
  );
  const claimed = claim.__typename === 'ClaimAccountUsernameSuccess';
  if (!claimed && claim.reason !== ALREADY_CLAIMED) {
    throw new Error(`OpenSea refused the username ${username}: ${claim.reason ?? 'no reason'}`);
  }
  await mutate(UPDATE_PROFILE, {
    address: account.address,
    newSettings: { displayName },
    target: 'ACCOUNT',
  });
  return { claimed };
};
