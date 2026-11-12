import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, test } from 'bun:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import {
  type Encryption,
  KeyVault,
  SecretFile,
  secureStorage,
} from '../../src/desktop/main/keyVault';

const reversing = (available = true): Encryption => ({
  isEncryptionAvailable: () => available,
  encryptString: (plainText) => Buffer.from([...plainText].reverse().join('')),
  decryptString: (encrypted) => [...encrypted.toString()].reverse().join(''),
});

let path: string;

beforeEach(async () => {
  path = join(await mkdtemp(join(tmpdir(), 'vault-')), 'wallet.key');
});

describe('KeyVault', () => {
  test('stores the key encrypted and hands back its account', async () => {
    const privateKey = generatePrivateKey();
    const vault = new KeyVault(reversing(), path);

    const address = await vault.store(privateKey);

    expect(address).toBe(privateKeyToAccount(privateKey).address);
    expect((await readFile(path)).toString()).not.toContain(privateKey.slice(2));
    expect((await vault.account())?.address).toBe(address);
  });

  test('has no account until a key is stored, nor after it is removed', async () => {
    const vault = new KeyVault(reversing(), path);
    expect(await vault.account()).toBeNull();

    await vault.store(generatePrivateKey());
    await vault.remove();

    expect(await vault.account()).toBeNull();
  });

  test('refuses to store anything without secure storage', async () => {
    const vault = new KeyVault(reversing(false), path);

    await expect(vault.store(generatePrivateKey())).rejects.toThrow('no secure storage');
    expect(await vault.account()).toBeNull();
  });

  test.each(['', 'not a key', '0x1234', `${generatePrivateKey()}00`])(
    'rejects %p as a key',
    async (privateKey) => {
      await expect(new KeyVault(reversing(), path).store(privateKey)).rejects.toThrow('32-byte');
    },
  );
});

describe('SecretFile', () => {
  test('keeps the secret encrypted and reads it back', async () => {
    const file = new SecretFile(reversing(), path);

    await file.write('opensea-api-key');

    expect((await readFile(path)).toString()).not.toContain('opensea-api-key');
    expect(await file.read()).toBe('opensea-api-key');
  });

  test('refuses to write without secure storage', async () => {
    await expect(new SecretFile(reversing(false), path).write('secret')).rejects.toThrow(
      'no secure storage',
    );
  });
});

describe('secureStorage', () => {
  const storage = (backend: string) => ({
    ...reversing(),
    getSelectedStorageBackend: () => backend,
  });

  test.each(['basic_text', 'unknown'])('treats the Linux %s backend as unavailable', (backend) => {
    expect(secureStorage(storage(backend), 'linux').isEncryptionAvailable()).toBe(false);
  });

  test('accepts a Linux secret store', () => {
    expect(secureStorage(storage('gnome_libsecret'), 'linux').isEncryptionAvailable()).toBe(true);
  });

  test('trusts the operating system store elsewhere', () => {
    expect(secureStorage(reversing(), 'darwin').isEncryptionAvailable()).toBe(true);
  });
});
