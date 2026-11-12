import { describe, expect, test } from 'bun:test';
import { type Hex, verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

import { setOpenSeaProfile } from '../src/opensea/profile';

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

type Sent = { url: string; headers: Headers; body: unknown };

/**
 * A `fetch` standing in for opensea.io: it hands out a nonce and a session cookie, and answers
 * each GraphQL mutation with `claim` and `update`. Every request it gets lands in `sent`.
 */
const fakeOpenSea = ({
  claim = { __typename: 'ClaimAccountUsernameSuccess' } as object,
  verifyStatus = 200,
} = {}) => {
  const sent: Sent[] = [];
  const send = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const body: unknown = init?.body ? JSON.parse(init.body as string) : undefined;
    sent.push({ url, headers: new Headers(init?.headers), body });
    if (url.endsWith('/auth/siwe/nonce')) return Response.json({ nonce: 'abc123nonce' });
    if (url.endsWith('/auth/siwe/verify')) {
      return new Response(JSON.stringify({ user: { address: account.address } }), {
        status: verifyStatus,
        headers: [
          ['set-cookie', 'access_token=token-a; Path=/; HttpOnly'],
          ['set-cookie', 'refresh_token=token-r; Path=/; HttpOnly'],
        ],
      });
    }
    const { query, variables } = body as { query: string; variables: { newSettings?: object } };
    if (query.includes('claimAccountUsername'))
      return Response.json({ data: { claimAccountUsername: claim } });
    return Response.json({ data: { updateProfileSettings: variables.newSettings } });
  }) as typeof fetch;
  return { send, sent };
};

describe('setOpenSeaProfile', () => {
  test('signs in with the wallet, then claims the username and sets the display name', async () => {
    const { send, sent } = fakeOpenSea();

    expect(
      await setOpenSeaProfile({
        account,
        username: 'captain_spread',
        displayName: 'Captain',
        send,
      }),
    ).toEqual({ claimed: true });

    const [, verify, claim, update] = sent;
    const { message, signature, chainArch } = verify.body as {
      message: Record<string, string>;
      signature: Hex;
      chainArch: string;
    };
    expect(message).toMatchObject({
      domain: 'opensea.io',
      address: account.address,
      nonce: 'abc123nonce',
      chainId: '1',
    });
    expect(chainArch).toBe('EVM');
    const signed = createSiweMessage({
      domain: message.domain,
      address: account.address,
      statement: message.statement,
      uri: message.uri,
      version: '1',
      chainId: Number(message.chainId),
      nonce: message.nonce,
      issuedAt: new Date(message.issuedAt),
    });
    expect(await verifyMessage({ address: account.address, message: signed, signature })).toBe(
      true,
    );
    for (const mutation of [claim, update]) {
      expect(mutation.url).toBe('https://gql.opensea.io/graphql');
      expect(mutation.headers.get('cookie')).toBe('access_token=token-a; refresh_token=token-r');
      expect(mutation.headers.get('x-app-id')).toBe('os2-web');
    }
    expect(claim.body).toMatchObject({ variables: { username: 'captain_spread' } });
    expect(update.body).toMatchObject({
      variables: { address: account.address, newSettings: { displayName: 'Captain' } },
    });
  });

  test('stops with the reason when OpenSea refuses the username', async () => {
    const { send, sent } = fakeOpenSea({
      claim: { __typename: 'ClaimAccountUsernameError', reason: 'USERNAME_TAKEN' },
    });

    await expect(
      setOpenSeaProfile({ account, username: 'taken', displayName: 'Taken', send }),
    ).rejects.toThrow('USERNAME_TAKEN');
    expect(sent.filter((request) => request.url.includes('graphql'))).toHaveLength(1);
  });

  test('keeps a username the wallet already has and still sets the display name', async () => {
    const { send, sent } = fakeOpenSea({
      claim: { __typename: 'ClaimAccountUsernameError', reason: 'ALREADY_HAS_ACCOUNT_PROFILE' },
    });

    const result = await setOpenSeaProfile({
      account,
      username: 'new',
      displayName: 'Shown',
      send,
    });

    expect(result).toEqual({ claimed: false });
    expect(sent.at(-1)?.body).toMatchObject({
      variables: { newSettings: { displayName: 'Shown' } },
    });
  });

  test('stops before any mutation when the sign-in is refused', async () => {
    const { send, sent } = fakeOpenSea({ verifyStatus: 401 });

    await expect(
      setOpenSeaProfile({ account, username: 'captain_spread', displayName: 'Captain', send }),
    ).rejects.toThrow('401');
    expect(sent.some((request) => request.url.includes('graphql'))).toBe(false);
  });
});
