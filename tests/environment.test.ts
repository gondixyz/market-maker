import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { mainnet } from 'viem/chains';

import { chainFrom, privateKeyFrom } from '../src/cli/environment';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

describe('chainFrom', () => {
  test('targets mainnet when no chain is set', () => {
    expect(chainFrom({})).toBe(mainnet);
  });

  test('takes a fork chain id with its RPC endpoint', () => {
    const chain = chainFrom({ MARKET_MAKER_CHAIN_ID: '31337', MARKET_MAKER_RPC_URL: 'http://x' });

    expect(chain.id).toBe(31337);
    expect(chain.contracts).toEqual(mainnet.contracts);
  });

  test.each([
    ['a fork without an RPC endpoint', { MARKET_MAKER_CHAIN_ID: '31337' }],
    ['a chain id that is not a number', { MARKET_MAKER_CHAIN_ID: 'anvil' }],
  ])('rejects %s', (_case, environment) => {
    expect(() => chainFrom(environment)).toThrow();
  });
});

describe('privateKeyFrom', () => {
  test.each([
    ['alone', {}],
    ['beside an empty inline key', { MARKET_MAKER_PRIVATE_KEY: '' }],
  ])('reads the key from a file %s, ignoring surrounding whitespace', async (_case, inline) => {
    const path = join(await mkdtemp(join(tmpdir(), 'market-maker-')), 'key');
    await writeFile(path, `${KEY}\n`);

    expect(await privateKeyFrom({ ...inline, MARKET_MAKER_PRIVATE_KEY_FILE: path })).toBe(KEY);
  });

  test.each([
    ['neither variable', {}],
    ['both variables', { MARKET_MAKER_PRIVATE_KEY: KEY, MARKET_MAKER_PRIVATE_KEY_FILE: '/key' }],
    ['a key without 0x', { MARKET_MAKER_PRIVATE_KEY: KEY.slice(2) }],
  ])('rejects %s', async (_case, environment) => {
    await expect(privateKeyFrom(environment)).rejects.toThrow();
  });
});
