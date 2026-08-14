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
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAppDatabase } from '@neotavern/db';
import { UnavailableSecretStore } from '@neotavern/secret-store';
import { createTestApp } from './helpers.js';
import type { TypedApp } from '../src/types.js';

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
    const { app, database } = await createTestApp({ allowSecretsExposure: true });
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
  });
});

describe('SEC-01: legacy plaintext import', () => {
  it('keeps legacy plaintext intact under a non-persistent (session) backend — no data loss', async () => {
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

    // buildApp runs the idempotent import at bootstrap. A session-only store
    // cannot survive a restart, so the importer must NOT destroy the only
    // durable copy: the row keeps its plaintext value.
    const { database } = await createTestApp({ database: seed, secretMode: 'session' });

    const row = await database.repos.providerSecrets.getFullById(
      providerId,
      '018f0000-0000-7000-8000-0000000000aa',
    );
    expect(row?.value).toBe('sk-legacy-plaintext');
    expect(row?.valueRef).toBeNull();
    // Still unmigrated — a later persistent setup can import it.
    expect(await database.repos.providerSecrets.listUnmigrated()).toHaveLength(1);
  });

  it('moves pre-migration plaintext rows into a persistent (portable) store at bootstrap', async () => {
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
    const { database, secrets } = await createTestApp({
      database: seed,
      secretMode: 'portable',
      secretPassphrase: 'test-passphrase',
    });

    const row = await database.repos.providerSecrets.getFullById(
      providerId,
      '018f0000-0000-7000-8000-0000000000aa',
    );
    expect(row?.value).toBe('');
    expect(row?.valueRef).toMatch(/^portable:provider:/u);
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
});
