/**
 * SEC-01 integration suite: secrets out of the main database.
 *
 * Verifies the legacy-contour contract: secret values never land in `app.db`
 * (the DB holds opaque references), the plaintext resolves through the
 * SecretStore for the provider runtime and the gated reveal route, a
 * reference whose backend cannot produce the value surfaces the stable
 * `SECRET_UNAVAILABLE_ON_THIS_DEVICE` error (never a plaintext fallback),
 * pre-migration plaintext rows are imported at bootstrap, and backups /
 * exports never contain secret values.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createAppDatabase } from '@neotavern/db';
import { createLogger } from '@neotavern/shared';
import {
  FileEncryptedSecretStore,
  MemorySecretStore,
  UnavailableSecretStore,
} from '@neotavern/secret-store';
import {
  createSecretStoreHandle,
  createSecretStoreHandleForBackend,
} from '../src/lib/secretStore.js';
import { createTestApp } from './helpers.js';
import type { TypedApp } from '../src/types.js';

const logger = createLogger({ level: 'error' });

let providerCounter = 0;

async function makeProvider(app: TypedApp, name = 'SEC provider'): Promise<string> {
  providerCounter += 1;
  const response = await app.inject({
    method: 'POST',
    url: '/api/v2/providers',
    payload: {
      kind: 'openai-compatible',
      name: `${name} ${providerCounter}`,
      baseUrl: 'http://localhost:11434/v1',
    },
  });
  expect(response.statusCode, response.payload).toBe(200);
  return (response.json() as { id: string }).id;
}

/** Read app.db + WAL bytes as latin1 text for plaintext detection. */
async function dumpDatabaseFiles(paths: { dbFile: string }): Promise<string> {
  const parts: string[] = [await readFile(paths.dbFile)];
  try {
    parts.push(await readFile(`${paths.dbFile}-wal`));
  } catch {
    // No WAL yet — fine.
  }
  return Buffer.concat(parts).toString('latin1');
}

describe('SEC-01: provider secrets are stored out-of-band', () => {
  it('stores only an opaque reference in the DB and resolves the value for reveal', async () => {
    const { app, database, secrets } = await createTestApp({ allowSecretsExposure: true });
    const providerId = await makeProvider(app);

    const created = await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets`,
      payload: { value: 'sk-live-key-77', label: 'live' },
    });
    expect(created.statusCode, created.payload).toBe(200);
    const secretId = (created.json() as { id: string }).id;

    // The DB row carries a reference, never the plaintext.
    const ref = await database.repos.providerSecrets.getActiveReference(providerId);
    expect(ref).toMatch(/^session:provider:/u);
    expect(ref).not.toContain('sk-live-key-77');
    const row = await database.repos.providerSecrets.getFullById(providerId, secretId);
    expect(row?.value).toBe('');
    expect(row?.valueRef).toBe(ref);

    // The reveal route resolves through the store.
    const reveal = await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets/${secretId}/reveal`,
    });
    expect(reveal.statusCode, reveal.payload).toBe(200);
    expect(reveal.json()).toEqual({ value: 'sk-live-key-77' });
    expect(await secrets.resolve(ref!)).toBe('sk-live-key-77');
  });

  it('removes the stored value from the SecretStore when the DB row is deleted', async () => {
    const { app, database, secrets } = await createTestApp({ allowSecretsExposure: true });
    const providerId = await makeProvider(app);
    const created = await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets`,
      payload: { value: 'sk-orphan-9e21', label: 'to-delete' },
    });
    const secretId = (created.json() as { id: string }).id;
    const ref = await database.repos.providerSecrets.getActiveReference(providerId);
    expect(ref).toMatch(/^session:/u);
    expect(await secrets.resolve(ref!)).toBe('sk-orphan-9e21');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v2/providers/${providerId}/secrets/${secretId}`,
    });
    expect(del.statusCode, del.payload).toBe(200);

    // The route deleted the store entry together with the row — the value no
    // longer resolves, so no orphaned secret survives in the store.
    expect(await secrets.resolve(ref!)).toBeNull();
  });

  it('keeps the plaintext out of the database file and WAL entirely', async () => {
    const { app, paths } = await createTestApp({ useFileDatabase: true, secretMode: 'portable' });
    const providerId = await makeProvider(app);
    const created = await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets`,
      payload: { value: 'sk-sentinel-4f1c9e', label: 'sentinel' },
    });
    expect(created.statusCode, created.payload).toBe(200);

    const dump = await dumpDatabaseFiles({ dbFile: paths.dbFile });
    expect(dump).not.toContain('sk-sentinel-4f1c9e');
  });

  it('resolves an active key for the provider runtime (getFullConfig)', async () => {
    const { app, database } = await createTestApp();
    const providerId = await makeProvider(app);
    await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets`,
      payload: { value: 'sk-runtime-key', label: 'runtime' },
    });
    const full = await database.repos.providerConfigs.getFullConfig(providerId);
    expect(full?.apiKey).toBe('sk-runtime-key');
  });

  it('surfaces SECRET_UNAVAILABLE_ON_THIS_DEVICE for a ref whose backend cannot produce the value', async () => {
    const { app, database } = await createTestApp({ allowSecretsExposure: true });
    const providerId = await makeProvider(app);
    // A reference that exists in the DB but resolves to nothing (store moved
    // to another device / session ended). The profile is intact — this must
    // look like "re-enter the key", not like data corruption.
    const secretId = await database.repos.providerSecrets.create(
      providerId,
      `portable:provider:${providerId}:missing-record`,
      'portable-bound',
    );

    const reveal = await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets/${secretId}/reveal`,
    });
    expect(reveal.statusCode).toBe(422);
    expect((reveal.json() as { code: string }).code).toBe('SECRET_UNAVAILABLE_ON_THIS_DEVICE');
  });

  it('refuses to store secrets when no backend is available (no plaintext fallback)', async () => {
    const { app } = await createTestApp({ secretStore: new UnavailableSecretStore() });
    const providerId = await makeProvider(app);
    const created = await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets`,
      payload: { value: 'sk-should-not-persist', label: 'x' },
    });
    expect(created.statusCode).toBe(422);
    expect((created.json() as { code: string }).code).toBe('SECRET_UNAVAILABLE_ON_THIS_DEVICE');
  });
});

describe('SEC-01: plugin secrets are stored out-of-band', () => {
  it('stores a reference, masks list, resolves reveal and deletes durably', async () => {
    const { app, database, secrets } = await createTestApp({ allowSecretsExposure: true });
    const pluginId = 'test.sec01';
    await database.repos.plugins.install({
      id: pluginId,
      name: 'sec01',
      version: '1.0.0',
      manifest: {
        id: 'test.sec01',
        name: 'sec01',
        version: '1.0.0',
        apiVersion: 2,
        requiredCapabilities: [{ name: 'secrets.manageOwn' }, { name: 'secrets.reveal' }],
      },
      requestedPermissions: ['secrets.manageOwn', 'secrets.reveal'],
      trust: 'locally-trusted',
    });
    const activate = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${pluginId}/activate`,
      payload: { grantedPermissions: ['secrets.manageOwn', 'secrets.reveal'] },
    });
    expect(activate.statusCode, activate.payload).toBe(200);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${pluginId}/secrets?scope=user`,
      payload: { key: 'api_key', value: 'sk-plugin-secret-99' },
    });
    expect(put.statusCode, put.payload).toBe(200);

    const entry = database.repos.pluginSecrets.get(pluginId, 'user', 'api_key');
    expect(entry?.value).toBe('');
    expect(entry?.valueRef).toMatch(/^session:plugin:/u);
    expect(entry?.valueRef).not.toContain('sk-plugin-secret-99');

    const list = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${pluginId}/secrets`,
    });
    expect(list.statusCode, list.payload).toBe(200);
    const items = (list.json() as { items: Array<{ key: string; masked: string }> }).items;
    expect(items.find((item) => item.key === 'api_key')?.masked).not.toContain(
      'sk-plugin-secret-99',
    );

    const reveal = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${pluginId}/secrets/api_key/reveal?scope=user`,
    });
    expect(reveal.statusCode, reveal.payload).toBe(200);
    expect(reveal.json()).toEqual({ value: 'sk-plugin-secret-99' });

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v2/plugins/${pluginId}/secrets/api_key?scope=user`,
    });
    expect(del.statusCode, del.payload).toBe(200);
    expect(database.repos.pluginSecrets.get(pluginId, 'user', 'api_key')).toBeNull();
    // SEC-01: the stored value is removed with the reference — nothing orphaned.
    expect(await secrets.resolve(entry!.valueRef!)).toBeNull();
  });

  it('revokes plugin secret values when the plugin is uninstalled (cascade, SEC-01)', async () => {
    const { app, database, secrets } = await createTestApp({ allowSecretsExposure: true });
    const pluginId = 'test.sec01.uninstall';
    await database.repos.plugins.install({
      id: pluginId,
      name: 'sec01-uninstall',
      version: '1.0.0',
      manifest: {
        id: pluginId,
        name: 'sec01-uninstall',
        version: '1.0.0',
        apiVersion: 2,
        requiredCapabilities: [{ name: 'secrets.manageOwn' }],
      },
      requestedPermissions: ['secrets.manageOwn'],
      trust: 'locally-trusted',
    });
    await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${pluginId}/activate`,
      payload: { grantedPermissions: ['secrets.manageOwn'] },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${pluginId}/secrets?scope=workspace`,
      payload: { key: 'token', value: 'sk-uninstall-token' },
    });
    const entry = database.repos.pluginSecrets.get(pluginId, 'workspace', 'token');
    expect(entry?.valueRef).toMatch(/^session:plugin:/u);
    expect(await secrets.resolve(entry!.valueRef!)).toBe('sk-uninstall-token');

    const del = await app.inject({ method: 'DELETE', url: `/api/v2/plugins/${pluginId}` });
    expect(del.statusCode, del.payload).toBe(200);

    // The cascade removed the rows AND revoked the values — nothing orphaned.
    expect(database.repos.pluginSecrets.list(pluginId)).toEqual([]);
    expect(await secrets.resolve(entry!.valueRef!)).toBeNull();
  });
});

describe('SEC-01: legacy plaintext import', () => {
  it('moves pre-migration plaintext rows into the store at bootstrap', async () => {
    // Seed a pre-SEC-01 database: a provider config plus a plaintext secret.
    const seed = createAppDatabase(':memory:');
    const providerId = '018f0000-0000-7000-8000-0000000000ff';
    seed.sqlite
      .prepare(
        `INSERT INTO provider_configs (id, kind, name, enabled, settings, created_at, updated_at)
         VALUES (?, 'openai-compatible', 'legacy provider', 1, '{}', 1, 1)`,
      )
      .run(providerId);
    seed.sqlite
      .prepare(
        `INSERT INTO provider_secrets (id, provider_id, label, value, value_ref, active, created_at)
         VALUES ('018f0000-0000-7000-8000-0000000000aa', ?, 'legacy', 'sk-legacy-plaintext', NULL, 1, 1)`,
      )
      .run(providerId);

    // buildApp runs the idempotent import at bootstrap with the live handle.
    const { database, secrets } = await createTestApp({ database: seed });

    const row = await database.repos.providerSecrets.getFullById(
      providerId,
      '018f0000-0000-7000-8000-0000000000aa',
    );
    expect(row?.value).toBe('');
    expect(row?.valueRef).toMatch(/^session:provider:/u);
    expect(await secrets.resolve(row?.valueRef ?? '')).toBe('sk-legacy-plaintext');
    // The import is idempotent: no rows are left unmigrated.
    expect(await database.repos.providerSecrets.listUnmigrated()).toHaveLength(0);
  });
});

describe('SEC-01: backups and exports exclude secrets', () => {
  it('backup archive contains no secret values', async () => {
    const { app, paths } = await createTestApp({ useFileDatabase: true, secretMode: 'portable' });
    const providerId = await makeProvider(app);
    await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets`,
      payload: { value: 'sk-backup-sentinel-0x1', label: 'b' },
    });

    const backup = await app.inject({ method: 'POST', url: '/api/v2/backups' });
    expect(backup.statusCode, backup.payload).toBe(200);
    const backupId = (backup.json() as { id: string }).id;
    const files = await readdir(paths.backups);
    const snapshot = files.find((file) => file.startsWith(backupId) && file.endsWith('.db'));
    expect(snapshot).toBeDefined();
    const bytes = await readFile(join(paths.backups, snapshot!));
    expect(bytes.toString('latin1')).not.toContain('sk-backup-sentinel-0x1');
  });

  it('profile export carries no secrets (logical allowlist)', async () => {
    const { app } = await createTestApp({ allowSecretsExposure: true });
    const providerId = await makeProvider(app);
    await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets`,
      payload: { value: 'sk-export-sentinel-0x2', label: 'e' },
    });

    const exported = await app.inject({ method: 'GET', url: '/api/v2/profiles/export' });
    expect(exported.statusCode, exported.payload.slice(0, 200)).toBe(200);
    expect(exported.rawPayload.toString('latin1')).not.toContain('sk-export-sentinel-0x2');
  });

  it('revokes every SecretStore value when the provider is deleted (cascade, SEC-01)', async () => {
    const { app, database, secrets } = await createTestApp();
    const providerId = await makeProvider(app);
    await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets`,
      payload: { value: 'sk-cascade-1', label: 'a' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets`,
      payload: { value: 'sk-cascade-2', label: 'b' },
    });
    const refs = await database.repos.providerSecrets.listRefsByProvider(providerId);
    expect(refs).toHaveLength(2);
    expect(refs.every((ref) => /^session:/.test(ref))).toBe(true);

    const del = await app.inject({ method: 'DELETE', url: `/api/v2/providers/${providerId}` });
    expect(del.statusCode, del.payload).toBe(200);

    // The cascade deleted the rows AND revoked the stored values — no
    // orphaned secret survives behind a deleted reference.
    expect(await database.repos.providerSecrets.listRefsByProvider(providerId)).toEqual([]);
    for (const ref of refs) {
      expect(await secrets.resolve(ref)).toBeNull();
    }
  });

  it('keeps the DB row when the store revocation fails — the reference survives for a retry (SEC-01)', async () => {
    const { app, database, secrets } = await createTestApp({
      secretMode: 'portable',
      secretPassphrase: 'test-passphrase',
    });
    const providerId = await makeProvider(app);
    const created = await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets`,
      payload: { value: 'sk-locked-cleanup', label: 'x' },
    });
    const secretId = (created.json() as { id: string }).id;
    const ref = await database.repos.providerSecrets.getActiveReference(providerId);
    expect(ref).toMatch(/^portable:/u);

    // Lock the portable store: the revocation must fail, the DELETE must NOT
    // remove the DB row (that would orphan the value behind a lost ref).
    const backend = secrets.backend as FileEncryptedSecretStore;
    await backend.lock();
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v2/providers/${providerId}/secrets/${secretId}`,
    });
    expect(del.statusCode, del.payload).toBe(422);
    expect(database.repos.providerSecrets.getFullById(providerId, secretId)).not.toBeNull();
  });

  it('revokes a portable value by its SAVED ref even after a restart into session mode (owner-aware, SEC-01)', async () => {
    // Phase 1: the value is stored by the PORTABLE backend (secrets.enc file).
    const dir = await mkdtemp(join(tmpdir(), 'neotavern-secret-owner-'));
    const file = join(dir, 'secrets.enc');
    const portable = new FileEncryptedSecretStore(file);
    await portable.create('test-passphrase');
    const handle = createSecretStoreHandleForBackend(portable, portable, logger);
    const ref = await handle.storeValue('provider:p1', 'rec-1', 'sk-portable-owner');
    expect(ref).toMatch(/^portable:/u);
    expect(await handle.resolve(ref)).toBe('sk-portable-owner');

    // Phase 2: the process restarted into SESSION mode — the default backend
    // is now memory, but the config still knows the portable file. The old
    // `deleteValue(namespace, id)` hit only the session store and orphaned
    // the value; `deleteRef` must route to the backend the ref names.
    const session = new MemorySecretStore();
    const restarted = createSecretStoreHandleForBackend(session, portable, logger);
    expect(await restarted.deleteRef(ref)).toBe(true);
    expect(await session.has('provider:p1', 'rec-1')).toBe(false);
    expect(await restarted.resolve(ref)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it('attaches the portable store in session mode for owner-aware revocation (SEC-01, production path)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neotavern-secret-prod-'));
    try {
      // Phase 1: a value is stored by the PORTABLE backend (secrets.enc file).
      const portable = new FileEncryptedSecretStore(join(dir, 'secrets.enc'));
      await portable.create('test-passphrase');
      const seeded = createSecretStoreHandleForBackend(portable, portable, logger);
      const ref = await seeded.storeValue('provider:p1', 'rec-1', 'sk-prod-owner');
      expect(ref).toMatch(/^portable:/u);

      // Phase 2: restart into SESSION mode through the PRODUCTION factory —
      // the active backend is memory, but the handle must attach the existing
      // secrets.enc so the saved `portable:` ref can still be revoked instead
      // of being silently orphaned.
      const restarted = await createSecretStoreHandle('session', 'test-passphrase', dir, logger);
      expect(await restarted.deleteRef(ref)).toBe(true);
      expect(await restarted.resolve(ref)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the portable file cannot be unlocked in session mode (SEC-01)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neotavern-secret-prod-lock-'));
    try {
      const portable = new FileEncryptedSecretStore(join(dir, 'secrets.enc'));
      await portable.create('test-passphrase');
      const seeded = createSecretStoreHandleForBackend(portable, portable, logger);
      const ref = await seeded.storeValue('provider:p1', 'rec-1', 'sk-locked');

      // Wrong passphrase on restart: the store attaches LOCKED, so revocation
      // throws instead of silently orphaning the value; resolve is
      // unavailable (fail-closed, never a plaintext fallback).
      const restarted = await createSecretStoreHandle('session', 'wrong-passphrase', dir, logger);
      await expect(restarted.deleteRef(ref)).rejects.toMatchObject({
        code: 'SECRET_STORE_LOCKED',
      });
      expect(await restarted.resolve(ref)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
