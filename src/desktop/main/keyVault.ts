import { readFile, rm, writeFile } from 'node:fs/promises';

import { isHex, type LocalAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** The part of Electron's `safeStorage` the vault uses; tests pass a fake. */
export type Encryption = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

/** The part of Electron's `safeStorage` `secureStorage` wraps. */
export type SafeStorage = Encryption & { getSelectedStorageBackend?(): string };

const INSECURE_LINUX_BACKENDS = new Set(['basic_text', 'unknown']);

/**
 * `safeStorage`, reported unavailable when it would not protect the key: on Linux without a secret
 * store it falls back to the `basic_text` backend, whose password is hardcoded in Electron
 * (https://www.electronjs.org/docs/latest/api/safe-storage#safestoragegetselectedstoragebackend-linux).
 */
export const secureStorage = (storage: SafeStorage, platform: NodeJS.Platform): Encryption => ({
  isEncryptionAvailable: () =>
    storage.isEncryptionAvailable() &&
    !(
      platform === 'linux' &&
      INSECURE_LINUX_BACKENDS.has(storage.getSelectedStorageBackend?.() ?? 'unknown')
    ),
  encryptString: (plainText) => storage.encryptString(plainText),
  decryptString: (encrypted) => storage.decryptString(encrypted),
});

/**
 * One secret encrypted at rest in one file, readable only through `encryption`. It refuses to write
 * at all without secure storage, rather than fall back to something weaker.
 */
export class SecretFile {
  constructor(
    private readonly encryption: Encryption,
    private readonly path: string,
  ) {}

  isEncryptionAvailable() {
    return this.encryption.isEncryptionAvailable();
  }

  async write(secret: string) {
    if (!this.isEncryptionAvailable()) {
      throw new Error('this system offers no secure storage; the key was not saved');
    }
    await writeFile(this.path, this.encryption.encryptString(secret), { mode: 0o600 });
  }

  /** The secret, or `null` when none is stored. */
  async read() {
    const encrypted = await readFile(this.path).catch(() => null);
    return encrypted ? this.encryption.decryptString(encrypted) : null;
  }

  async remove() {
    await rm(this.path, { force: true });
  }
}

/**
 * Keeps the bot wallet's private key encrypted at rest, in one file, and hands main a signing
 * account. The key never leaves this module as a string: callers get the account or its address.
 *
 * IMPLEMENTATION NOTE: encryption is Electron's `safeStorage`, which encrypts with a key held by
 * the operating system: the Keychain on macOS, DPAPI on Windows, and the secret store (kwallet,
 * libsecret) on Linux. `isEncryptionAvailable()` is false when no such store is reachable, and on
 * Linux `safeStorage` can then fall back to a hardcoded plaintext password
 * (https://www.electronjs.org/docs/latest/api/safe-storage), which is why `store` refuses to write
 * at all without it.
 */
export class KeyVault {
  private readonly file: SecretFile;

  constructor(encryption: Encryption, path: string) {
    this.file = new SecretFile(encryption, path);
  }

  isEncryptionAvailable() {
    return this.file.isEncryptionAvailable();
  }

  /** Validates and encrypts `privateKey`, replacing any stored key, and returns its address. */
  async store(privateKey: string) {
    if (!this.isEncryptionAvailable()) {
      throw new Error('this system offers no secure storage; the key was not saved');
    }
    const trimmed = privateKey.trim();
    if (!isHex(trimmed) || trimmed.length !== 66) {
      throw new Error('expected a 0x-prefixed, 32-byte private key');
    }
    const account = privateKeyToAccount(trimmed);
    await this.file.write(trimmed);
    return account.address;
  }

  async remove() {
    await this.file.remove();
  }

  /** The stored key as a signing account, or `null` when none is stored. */
  async account(): Promise<LocalAccount | null> {
    const privateKey = await this.file.read();
    if (privateKey === null) return null;
    if (!isHex(privateKey)) throw new Error('the stored key is corrupt; import it again');
    return privateKeyToAccount(privateKey);
  }
}
