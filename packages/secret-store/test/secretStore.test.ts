/**
 * SecretStore unit tests (ТЗ §SEC-01 / §SEC-01.1): reference format, session
 * and env backends, and the portable encrypted file format — wrong passphrase,
 * corrupted/tampered files, no silent downgrade, nonce freshness, atomic
 * rotation and portability (file + passphrase, no machine identity).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EnvSecretStore,
  FileEncryptedSecretStore,
  MemorySecretStore,
  SecretStoreErrorCodes,
  makeSecretRef,
  parseSecretRef,
  UnavailableSecretStore,
} from '../src/index.js';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'neotavern-secret-store-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('secret references', () => {
  it('round-trips and rejects non-reference strings', () => {
    for (const kind of ['portable', 'session', 'env'] as const) {
      const ref = makeSecretRef(kind, 'provider:openai', 'key-1');
      expect(ref).toBe(`${kind}:provider:openai:key-1`);
      expect(parseSecretRef(ref)).toEqual({ kind, namespace: 'provider:openai', id: 'key-1' });
    }
    expect(parseSecretRef('sk-legacy-plaintext-key-123')).toBeNull();
    expect(parseSecretRef('portable:only-namespace')).toBeNull();
    expect(parseSecretRef('unknown:ns:id')).toBeNull();
    expect(parseSecretRef('portable::')).toBeNull();
  });
});

describe('MemorySecretStore (session-only)', () => {
  it('stores, reads, lists metadata and deletes', async () => {
    const store = new MemorySecretStore(() => 1000);
    expect(store.describe()).toMatchObject({ kind: 'session', persistent: false, available: true });

    await store.put('provider:a', 'k1', 'secret-one');
    await store.put('provider:a', 'k2', 'secret-two');
    expect(await store.get('provider:a', 'k1')).toBe('secret-one');
    expect(await store.has('provider:a', 'k1')).toBe(true);
    expect(await store.list('provider:a')).toEqual([
      { id: 'k1', createdAt: 1000, updatedAt: 1000 },
      { id: 'k2', createdAt: 1000, updatedAt: 1000 },
    ]);
    expect(await store.delete('provider:a', 'k1')).toBe(true);
    expect(await store.get('provider:a', 'k1')).toBeNull();
    expect(await store.delete('provider:a', 'k1')).toBe(false);

    store.clear();
    expect(await store.has('provider:a', 'k2')).toBe(false);
  });

  it('namespaces do not leak into each other', async () => {
    const store = new MemorySecretStore();
    await store.put('provider:a', 'k', 'a-value');
    await store.put('provider:b', 'k', 'b-value');
    expect(await store.get('provider:a', 'k')).toBe('a-value');
    expect(await store.get('provider:b', 'k')).toBe('b-value');
  });
});

describe('EnvSecretStore (headless read-only)', () => {
  it('resolves configured environment names and rejects writes', async () => {
    const env: NodeJS.ProcessEnv = {
      NEOTA_SECRET_provider_openai_API_KEY: 'env-key',
      NEOTA_SECRET_provider_anthropic_API_KEY: 'env-anthropic',
      NEOTA_UNRELATED: 'x',
    };
    const store = new EnvSecretStore('NEOTA_SECRET_', env);
    expect(await store.get('provider_openai', 'API_KEY')).toBe('env-key');
    expect(await store.has('provider_openai', 'API_KEY')).toBe(true);
    expect(await store.get('provider_missing', 'API_KEY')).toBeNull();
    expect(store.describe()).toMatchObject({ kind: 'env', persistent: true, writable: false });

    await expect(store.put('a', 'b', 'c')).rejects.toMatchObject({
      code: SecretStoreErrorCodes.SECRET_READ_ONLY,
    });
  });
});

describe('FileEncryptedSecretStore (secrets.enc)', () => {
  it('persists and reopens on a fresh instance — file + passphrase only', async () => {
    const file = join(tempDir(), 'secrets.enc');
    const first = new FileEncryptedSecretStore(file, () => 42);
    await first.create('correct horse battery staple');
    await first.put('provider:openai', 'key-1', 'sk-live-key');
    await first.put('provider:openai', 'key-2', 'sk-second');
    expect(await first.get('provider:openai', 'key-1')).toBe('sk-live-key');
    expect(first.describe()).toMatchObject({
      kind: 'portable',
      persistent: true,
      writable: true,
      formatVersion: 1,
      kdf: 'scrypt',
      available: true,
      recordCount: 2,
    });

    // A brand-new instance (a different machine) opens with just the file and
    // the passphrase — machine identity plays no part in key derivation.
    const second = new FileEncryptedSecretStore(file);
    await second.open('correct horse battery staple');
    expect(await second.get('provider:openai', 'key-1')).toBe('sk-live-key');
    expect(await second.list('provider:openai')).toEqual([
      { id: 'key-1', createdAt: 42, updatedAt: 42 },
      { id: 'key-2', createdAt: 42, updatedAt: 42 },
    ]);
  });

  it('rejects a wrong passphrase with SECRET_STORE_AUTH_FAILED', async () => {
    const file = join(tempDir(), 'secrets.enc');
    const store = new FileEncryptedSecretStore(file);
    await store.create('real passphrase');
    await store.put('provider:a', 'k', 'value');

    const impostor = new FileEncryptedSecretStore(file);
    await expect(impostor.open('wrong passphrase')).rejects.toMatchObject({
      code: SecretStoreErrorCodes.SECRET_STORE_AUTH_FAILED,
    });
  });

  it('rejects a tampered header with SECRET_STORE_CORRUPT (no silent downgrade)', async () => {
    const file = join(tempDir(), 'secrets.enc');
    const store = new FileEncryptedSecretStore(file);
    await store.create('passphrase');
    await store.put('provider:a', 'k', 'value');

    const bytes = readFileSync(file);
    bytes[8] = 99; // formatVersion 1 → 99 (an unknown/future version)
    const tampered = join(tempDir(), 'tampered.enc');
    writeFileSync(tampered, bytes);

    // The versioned envelope rejects unknown formats outright — a tampered
    // header can never be accepted as a readable store.
    const impostor = new FileEncryptedSecretStore(tampered);
    await expect(impostor.open('passphrase')).rejects.toMatchObject({
      code: SecretStoreErrorCodes.SECRET_STORE_CORRUPT,
    });
  });

  it('rejects a corrupted payload with SECRET_STORE_AUTH_FAILED', async () => {
    const file = join(tempDir(), 'secrets.enc');
    const store = new FileEncryptedSecretStore(file);
    await store.create('passphrase');
    await store.put('provider:a', 'k', 'value');

    const bytes = readFileSync(file);
    bytes[bytes.length - 17] ^= 0xff; // flip a ciphertext byte before the tag
    const tampered = join(tempDir(), 'flipped.enc');
    writeFileSync(tampered, bytes);

    const impostor = new FileEncryptedSecretStore(tampered);
    await expect(impostor.open('passphrase')).rejects.toMatchObject({
      code: SecretStoreErrorCodes.SECRET_STORE_AUTH_FAILED,
    });
  });

  it('uses a fresh nonce on every write (no nonce reuse)', async () => {
    const file = join(tempDir(), 'secrets.enc');
    const store = new FileEncryptedSecretStore(file);
    await store.create('passphrase');
    await store.put('provider:a', 'k', 'v1');
    const firstBytes = readFileSync(file);
    await store.put('provider:a', 'k', 'v2');
    const secondBytes = readFileSync(file);
    // The salt (19..35) is stable for the passphrase; the nonce (35..47)
    // must differ between writes — the tag authenticates the ciphertext, so
    // nonce reuse across distinct plaintexts would be a GCM break.
    expect(firstBytes.subarray(19, 35).equals(secondBytes.subarray(19, 35))).toBe(true);
    expect(firstBytes.subarray(35, 47).equals(secondBytes.subarray(35, 47))).toBe(false);
  });

  it('re-encrypts under a new passphrase without losing records', async () => {
    const file = join(tempDir(), 'secrets.enc');
    const store = new FileEncryptedSecretStore(file);
    await store.create('old passphrase');
    await store.put('provider:a', 'k', 'keep-me');

    await store.reEncrypt('new passphrase');
    expect(await store.get('provider:a', 'k')).toBe('keep-me');

    // The old passphrase no longer opens the file.
    const oldImpostor = new FileEncryptedSecretStore(file);
    await expect(oldImpostor.open('old passphrase')).rejects.toMatchObject({
      code: SecretStoreErrorCodes.SECRET_STORE_AUTH_FAILED,
    });
    const fresh = new FileEncryptedSecretStore(file);
    await fresh.open('new passphrase');
    expect(await fresh.get('provider:a', 'k')).toBe('keep-me');
  });

  it('locks the store: values are unavailable and writes are refused', async () => {
    const file = join(tempDir(), 'secrets.enc');
    const store = new FileEncryptedSecretStore(file);
    await store.create('passphrase');
    await store.put('provider:a', 'k', 'value');
    store.lock();
    expect(store.isAvailable()).toBe(false);
    expect(store.describe().available).toBe(false);
    expect(await store.get('provider:a', 'k')).toBeNull();
    await expect(store.put('provider:a', 'k2', 'x')).rejects.toMatchObject({
      code: SecretStoreErrorCodes.SECRET_STORE_LOCKED,
    });
    // The file still contains the data and reopens with the passphrase.
    const reopened = new FileEncryptedSecretStore(file);
    await reopened.open('passphrase');
    expect(await reopened.get('provider:a', 'k')).toBe('value');
  });

  it('refuses to create over an existing file', async () => {
    const file = join(tempDir(), 'secrets.enc');
    const store = new FileEncryptedSecretStore(file);
    await store.create('passphrase');
    const again = new FileEncryptedSecretStore(file);
    await expect(again.create('other passphrase')).rejects.toMatchObject({
      code: SecretStoreErrorCodes.SECRET_STORE_CORRUPT,
    });
  });

  it('serializes concurrent writes without losing records', async () => {
    const file = join(tempDir(), 'secrets.enc');
    const store = new FileEncryptedSecretStore(file);
    await store.create('passphrase');
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => store.put('provider:a', `k${index}`, `v${index}`)),
    );
    const fresh = new FileEncryptedSecretStore(file);
    await fresh.open('passphrase');
    expect(await fresh.list('provider:a')).toHaveLength(10);
    expect(await fresh.get('provider:a', 'k9')).toBe('v9');
  });

  it('delete removes the record durably', async () => {
    const file = join(tempDir(), 'secrets.enc');
    const store = new FileEncryptedSecretStore(file);
    await store.create('passphrase');
    await store.put('provider:a', 'k', 'value');
    expect(await store.delete('provider:a', 'k')).toBe(true);
    expect(await store.delete('provider:a', 'k')).toBe(false);
    const fresh = new FileEncryptedSecretStore(file);
    await fresh.open('passphrase');
    expect(await fresh.get('provider:a', 'k')).toBeNull();
  });

  it('returns a stable content-free metadata list (no values)', async () => {
    const file = join(tempDir(), 'secrets.enc');
    const store = new FileEncryptedSecretStore(file);
    await store.create('passphrase');
    await store.put('provider:a', 'k', 'very-secret-value');
    const metadata = await store.list('provider:a');
    expect(metadata).toEqual([
      { id: 'k', createdAt: expect.any(Number), updatedAt: expect.any(Number) },
    ]);
    expect(JSON.stringify(metadata)).not.toContain('very-secret-value');
  });
});

describe('UnavailableSecretStore', () => {
  it('reports unavailable and refuses writes (no plaintext fallback)', async () => {
    const store = new UnavailableSecretStore();
    expect(store.isAvailable()).toBe(false);
    await expect(store.put('a', 'b', 'c')).rejects.toMatchObject({
      code: SecretStoreErrorCodes.SECRET_STORE_LOCKED,
    });
    expect(await store.get('a', 'b')).toBeNull();
  });
});
