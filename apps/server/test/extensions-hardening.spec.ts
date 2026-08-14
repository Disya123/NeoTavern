/**
 * Phase 10 extension-hardening integration tests (ТЗ §54/§76/§83):
 *   - manifest `engines` enforcement at install + activate; an incompatible
 *     update disables the plugin (event + diagnostic) and keeps the previous
 *     version installed;
 *   - namespaced state kv quota (kvBytes/kvKeys from DEFAULT_PLUGIN_LIMITS);
 *   - per-plugin SecretStore: write-only values, masked list, gated reveal,
 *     capability denial, redaction from state/backup-sidecar/diagnostics;
 *   - previous-major (apiVersion 2) compatibility through the existing gate;
 *   - server/API-level negative tests: denied + revoked grants, oversized
 *     manifest/entrypoint, quota 413;
 *   - the server-registered `extensions.legacyFrontend` settings default.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative as pathRelative } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import * as yazl from 'yazl';
import { createAppDatabase, type AppDatabase } from '@neotavern/db';
import { EventBus, type AppEventMap } from '@neotavern/plugin-sdk';
import { DEFAULT_PROVIDER_TIMEOUTS, ProviderRegistry } from '@neotavern/provider-sdk';
import { createLogger } from '@neotavern/shared';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, resolveDataPaths } from '../src/lib/paths.js';
import { ContextStrategyRegistry } from '../src/pipeline/contextShift.js';
import { PostProcessorRegistry } from '../src/pipeline/postProcess.js';
import type { TypedApp } from '../src/types.js';
import { createTestApp, multipartFile } from './helpers.js';

const KV_BYTES = 1024 * 1024;
const KV_KEYS = 4096;

let app: TypedApp;
let database: AppDatabase;

beforeEach(async () => {
  ({ app, database } = await createTestApp());
});

/** Register a plugin directly in the registry and grant its capabilities. */
function installPlugin(id: string, capabilities: readonly string[]): void {
  database.repos.plugins.install({
    id,
    name: id,
    version: '1.0.0',
    manifest: { id, name: id, version: '1.0.0', apiVersion: 2 },
    requestedPermissions: [...capabilities],
  });
  for (const name of capabilities) {
    database.repos.capabilityGrants.grant({ pluginId: id, name, scope: {} });
  }
}

/** Pack in-memory files into a .stplugin ZIP (yazl, like the other suites). */
function zipArchive(entries: Record<string, string>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [path, contents] of Object.entries(entries)) {
    zip.addBuffer(Buffer.from(contents), path);
  }
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function pluginPackage(
  id: string,
  version: string,
  extra: Record<string, unknown> = {},
): Promise<Buffer> {
  return zipArchive({
    'plugin.json': JSON.stringify({
      id,
      name: id,
      version,
      apiVersion: 2,
      frontend: 'frontend.js',
      ...extra,
    }),
    'frontend.js': 'export default { activate() {} };',
  });
}

function installArchive(
  archive: Buffer,
  filename = 'plugin.stplugin',
): ReturnType<TypedApp['inject']> {
  return app.inject({
    method: 'POST',
    url: '/api/v2/plugins/install',
    ...multipartFile(archive, filename, 'application/zip'),
  });
}

async function pluginFromList(id: string): Promise<Record<string, unknown>> {
  const response = await app.inject({ method: 'GET', url: '/api/v2/plugins' });
  const items = response.json().items as Array<Record<string, unknown>>;
  const found = items.find((item) => item.id === id);
  if (!found) throw new Error(`plugin ${id} not in list`);
  return found;
}

// ── engines enforcement (ТЗ §76) ───────────────────────────────────────────

describe('engines enforcement (ТЗ §76)', () => {
  const ENGINE_PLUGIN = 'test.engine-mismatch';

  it('rejects an install whose engine range does not match the host', async () => {
    const response = await installArchive(
      await pluginPackage(ENGINE_PLUGIN, '1.0.0', { engines: { neotavern: '^99.0.0' } }),
    );
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: 'ENGINE_MISMATCH',
      params: { engine: 'neotavern', required: '^99.0.0', host: '0.1.0' },
    });

    const list = await app.inject({ method: 'GET', url: '/api/v2/plugins' });
    expect(list.json().items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: ENGINE_PLUGIN })]),
    );
  });

  it('accepts an install when every declared engine range matches the host', async () => {
    const response = await installArchive(
      await pluginPackage(ENGINE_PLUGIN, '1.0.0', {
        engines: {
          neotavern: '^0.1.0',
          host: '>=2.0.0 <3',
          sdk: '^3.0.0',
          protocol: '^2.0.0',
        },
      }),
    );
    expect(response.statusCode, response.payload).toBe(200);
  });

  it('rejects activation of a stored manifest whose engines no longer match', async () => {
    database.repos.plugins.install({
      id: ENGINE_PLUGIN,
      name: ENGINE_PLUGIN,
      version: '1.0.0',
      manifest: {
        id: ENGINE_PLUGIN,
        name: ENGINE_PLUGIN,
        version: '1.0.0',
        apiVersion: 2,
        engines: { protocol: '^99.0.0' },
      },
      requestedPermissions: [],
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${ENGINE_PLUGIN}/activate`,
      payload: { grantedPermissions: [] },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: 'ENGINE_MISMATCH',
      params: { engine: 'protocol', required: '^99.0.0', host: '2.0.0' },
    });
  });
});

describe('incompatible update disables the plugin (§76/§83)', () => {
  const ENGINE_PLUGIN = 'test.engine-update-disable';
  let busApp: TypedApp;
  let busDatabase: AppDatabase;
  let bus: EventBus<AppEventMap>;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'neotavern-engine-test-'));
    const paths = resolveDataPaths(dataDir);
    ensureDataDirs(paths);
    busDatabase = createAppDatabase(':memory:');
    bus = new EventBus<AppEventMap>();
    busApp = await buildApp({
      database: busDatabase,
      providers: new ProviderRegistry(),
      contextStrategies: new ContextStrategyRegistry(),
      postProcessors: new PostProcessorRegistry(),
      events: bus,
      config: {
        host: '127.0.0.1',
        port: 0,
        dataDir,
        webDir: null,
        logLevel: 'error',
        corsOrigin: 'http://127.0.0.1:5173',
        remoteAccess: false,
        publicOrigin: 'http://127.0.0.1:5173',
        remoteTokenHash: null,
        secureSessionCookies: false,
        safeMode: false,
        allowSecretsExposure: false,
        pluginNodePath: process.execPath,
        pluginWorkerPath: null,
        pluginLoaderPath: null,
        pluginGitInstall: true,
        pluginRegistryUrl: 'https://registry.npmjs.org',
        pluginDepsMaxPackages: 300,
        pluginDepsMaxBytes: 200 * 1024 * 1024,
        providerTimeouts: DEFAULT_PROVIDER_TIMEOUTS,
      },
      logger: createLogger({ level: 'error' }),
      paths,
    });
  });

  afterEach(async () => {
    await busApp.close();
    busDatabase.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('keeps the previous version installed, disables the plugin and emits plugin.disabled', async () => {
    const install = async (
      version: string,
      extra: Record<string, unknown>,
    ): Promise<ReturnType<TypedApp['inject']>> => {
      const archive = await pluginPackage(ENGINE_PLUGIN, version, extra);
      return busApp.inject({
        method: 'POST',
        url: '/api/v2/plugins/install',
        ...multipartFile(archive, `${ENGINE_PLUGIN}.stplugin`, 'application/zip'),
      });
    };

    // v1 is compatible and activates fine.
    expect((await install('1.0.0', {})).statusCode).toBe(200);
    const activated = await busApp.inject({
      method: 'POST',
      url: `/api/v2/plugins/${ENGINE_PLUGIN}/activate`,
      payload: { grantedPermissions: [] },
    });
    expect(activated.statusCode, activated.payload).toBe(200);

    // v2 declares an engine the host does not provide.
    const disabled = new Promise<unknown>((resolve) => {
      bus.on('plugin.disabled', (payload) => resolve(payload));
    });
    const rejected = await install('2.0.0', { engines: { host: '^99.0.0' } });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({
      code: 'ENGINE_MISMATCH',
      params: { engine: 'host', required: '^99.0.0', host: '2.0.0' },
    });

    // The bus delivered plugin.disabled with the stable diagnostic.
    expect(await disabled).toMatchObject({
      pluginId: ENGINE_PLUGIN,
      reason: 'ENGINE_MISMATCH',
      engine: 'host',
      required: '^99.0.0',
      host: '2.0.0',
    });

    // Previous version intact, plugin disabled with a stable diagnostic.
    const list = await busApp.inject({ method: 'GET', url: '/api/v2/plugins' });
    const items = list.json().items as Array<Record<string, unknown>>;
    const entry = items.find((item) => item.id === ENGINE_PLUGIN);
    expect(entry).toMatchObject({
      version: '1.0.0',
      enabled: false,
      status: 'error',
      lastErrorCode: 'ENGINE_MISMATCH',
    });
  });
});

// ── namespaced state quota (ТЗ §54) ────────────────────────────────────────

describe('namespaced state quota (ТЗ §54)', () => {
  const QUOTA_PLUGIN = 'test.state-quota';

  it('rejects a write over kvBytes with 413 STATE_QUOTA_EXCEEDED', async () => {
    installPlugin(QUOTA_PLUGIN, ['storage.user']);
    const over = { a: 'x'.repeat(KV_BYTES - 8 + 1) }; // serialized length = KV_BYTES + 1

    const response = await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${QUOTA_PLUGIN}/state?scope=user`,
      payload: { data: over },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      code: 'STATE_QUOTA_EXCEEDED',
      params: { limitBytes: KV_BYTES, limitKeys: KV_KEYS },
    });
  });

  it('accepts a write exactly at kvBytes', async () => {
    installPlugin(QUOTA_PLUGIN, ['storage.user']);
    const exact = { a: 'x'.repeat(KV_BYTES - 8) }; // serialized length === KV_BYTES
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(KV_BYTES);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${QUOTA_PLUGIN}/state?scope=user`,
      payload: { data: exact },
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(response.json()).toEqual({ revision: 1 });
  });

  it('rejects a write with more top-level keys than kvKeys', async () => {
    installPlugin(QUOTA_PLUGIN, ['storage.user']);
    const manyKeys: Record<string, unknown> = {};
    for (let i = 0; i < KV_KEYS + 1; i += 1) manyKeys[`k${i}`] = true;

    const response = await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${QUOTA_PLUGIN}/state?scope=user`,
      payload: { data: manyKeys },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      code: 'STATE_QUOTA_EXCEEDED',
      params: { limitKeys: KV_KEYS, keys: KV_KEYS + 1 },
    });
  });

  it('leaves existing rows untouched after a rejected write', async () => {
    installPlugin(QUOTA_PLUGIN, ['storage.user']);
    const ok = await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${QUOTA_PLUGIN}/state?scope=user`,
      payload: { data: { theme: 'dark' } },
    });
    expect(ok.statusCode).toBe(200);

    const rejected = await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${QUOTA_PLUGIN}/state?scope=user`,
      payload: { data: { big: 'x'.repeat(KV_BYTES) } },
    });
    expect(rejected.statusCode).toBe(413);

    const got = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${QUOTA_PLUGIN}/state?scope=user`,
    });
    expect(got.json()).toMatchObject({ revision: 1, data: { theme: 'dark' } });
  });
});

// ── plugin SecretStore (ТЗ §54) ────────────────────────────────────────────

describe('plugin SecretStore (ТЗ §54)', () => {
  const SECRET_PLUGIN = 'test.plugin-secrets';
  const SECRET_VALUE = 'super-secret-value-12345';

  it('stores a secret without echoing its value anywhere in the response', async () => {
    installPlugin(SECRET_PLUGIN, ['secrets.manageOwn']);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${SECRET_PLUGIN}/secrets?scope=user`,
      payload: { key: 'apiKey', value: SECRET_VALUE },
    });
    expect(put.statusCode, put.payload).toBe(200);
    expect(put.json()).toEqual({ ok: true });
    expect(JSON.stringify(put.json())).not.toContain(SECRET_VALUE);
  });

  it('lists keys and masked values only', async () => {
    installPlugin(SECRET_PLUGIN, ['secrets.manageOwn']);
    await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${SECRET_PLUGIN}/secrets?scope=user`,
      payload: { key: 'apiKey', value: SECRET_VALUE },
    });

    const got = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${SECRET_PLUGIN}/secrets`,
    });
    expect(got.statusCode).toBe(200);
    const body = JSON.stringify(got.json());
    expect(body).not.toContain(SECRET_VALUE);
    // The mask derives from the opaque reference (ТЗ §SEC-01) — non-empty,
    // but never a fragment of the actual key.
    const items = got.json().items as Array<{ key: string; scope: string; masked: string }>;
    expect(items).toEqual([expect.objectContaining({ key: 'apiKey', scope: 'user' })]);
    expect(items[0]?.masked.length).toBeGreaterThan(0);
    expect(items[0]?.masked).not.toContain(SECRET_VALUE.slice(-4));
  });

  it('keeps the plaintext behind the exposure gate and the secrets.reveal grant', async () => {
    installPlugin(SECRET_PLUGIN, ['secrets.manageOwn', 'secrets.reveal']);
    await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${SECRET_PLUGIN}/secrets?scope=user`,
      payload: { key: 'apiKey', value: SECRET_VALUE },
    });

    // Exposure disabled (default): 403 even with the reveal grant.
    const disabled = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${SECRET_PLUGIN}/secrets/apiKey/reveal?scope=user`,
    });
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json().code).toBe('SECRETS_EXPOSURE_DISABLED');

    // Exposure enabled: the value is returned.
    const { app: exposingApp, database: exposingDb } = await createTestApp({
      allowSecretsExposure: true,
    });
    exposingDb.repos.plugins.install({
      id: SECRET_PLUGIN,
      name: SECRET_PLUGIN,
      version: '1.0.0',
      manifest: { id: SECRET_PLUGIN, name: SECRET_PLUGIN, version: '1.0.0', apiVersion: 2 },
      requestedPermissions: [],
    });
    for (const name of ['secrets.manageOwn', 'secrets.reveal']) {
      exposingDb.repos.capabilityGrants.grant({ pluginId: SECRET_PLUGIN, name, scope: {} });
    }
    await exposingApp.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${SECRET_PLUGIN}/secrets?scope=user`,
      payload: { key: 'apiKey', value: SECRET_VALUE },
    });
    const revealed = await exposingApp.inject({
      method: 'POST',
      url: `/api/v2/plugins/${SECRET_PLUGIN}/secrets/apiKey/reveal?scope=user`,
    });
    expect(revealed.statusCode, revealed.payload).toBe(200);
    expect(revealed.json()).toEqual({ value: SECRET_VALUE });
  });

  it('deletes a secret', async () => {
    installPlugin(SECRET_PLUGIN, ['secrets.manageOwn']);
    await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${SECRET_PLUGIN}/secrets?scope=user`,
      payload: { key: 'apiKey', value: SECRET_VALUE },
    });

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v2/plugins/${SECRET_PLUGIN}/secrets/apiKey?scope=user`,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });

    const again = await app.inject({
      method: 'DELETE',
      url: `/api/v2/plugins/${SECRET_PLUGIN}/secrets/apiKey?scope=user`,
    });
    expect(again.statusCode).toBe(404);

    const got = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${SECRET_PLUGIN}/secrets`,
    });
    expect(got.json().items).toEqual([]);
  });

  it('denies SecretStore access without the secrets.manageOwn grant', async () => {
    installPlugin(SECRET_PLUGIN, ['storage.user']);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${SECRET_PLUGIN}/secrets?scope=user`,
      payload: { key: 'apiKey', value: 'v' },
    });
    expect(put.statusCode).toBe(403);
    expect(put.json()).toMatchObject({
      code: 'PLUGIN_PERMISSION_DENIED',
      params: { pluginId: SECRET_PLUGIN, capability: 'secrets.manageOwn' },
    });

    const unknown = await app.inject({
      method: 'PUT',
      url: '/api/v2/plugins/nope.not-installed/secrets?scope=user',
      payload: { key: 'k', value: 'v' },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('PLUGIN_NOT_FOUND');
  });

  it('redacts secrets from state, backup namespaces and diagnostics', async () => {
    const {
      app: fileApp,
      database: fileDb,
      paths,
    } = await createTestApp({ useFileDatabase: true });
    fileDb.repos.plugins.install({
      id: SECRET_PLUGIN,
      name: SECRET_PLUGIN,
      version: '1.0.0',
      manifest: { id: SECRET_PLUGIN, name: SECRET_PLUGIN, version: '1.0.0', apiVersion: 2 },
      requestedPermissions: ['secrets.manageOwn', 'storage.user'],
    });
    for (const name of ['secrets.manageOwn', 'storage.user']) {
      fileDb.repos.capabilityGrants.grant({ pluginId: SECRET_PLUGIN, name, scope: {} });
    }
    await fileApp.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${SECRET_PLUGIN}/secrets?scope=user`,
      payload: { key: 'apiKey', value: SECRET_VALUE },
    });
    await fileApp.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${SECRET_PLUGIN}/state?scope=user`,
      payload: { data: { theme: 'dark' } },
    });

    // State body: no secret.
    const state = await fileApp.inject({
      method: 'GET',
      url: `/api/v2/plugins/${SECRET_PLUGIN}/state?scope=user`,
    });
    expect(JSON.stringify(state.json())).not.toContain(SECRET_VALUE);

    // Backup: the namespaced sidecar carries state only.
    const backup = await fileApp.inject({ method: 'POST', url: '/api/v2/backups' });
    expect(backup.statusCode, backup.payload).toBe(200);
    const backupId = backup.json().id as string;
    const sidecar = await readFile(
      join(paths.backups, `${backupId}.plugin-namespaces.json`),
      'utf8',
    );
    const namespaces = JSON.parse(sidecar) as {
      format: string;
      formatVersion: number;
      pluginNamespaces: Array<{ pluginId: string; state: unknown[] }>;
    };
    expect(namespaces.format).toBe('neotavern-plugin-namespaces');
    expect(namespaces.formatVersion).toBe(1);
    const namespace = namespaces.pluginNamespaces.find((item) => item.pluginId === SECRET_PLUGIN);
    expect(namespace).toBeDefined();
    expect(JSON.stringify(namespace?.state)).toContain('theme');
    expect(sidecar).not.toContain(SECRET_VALUE);

    // Restore stays a no-op clobber: state survives the round-trip.
    const restored = await fileApp.inject({
      method: 'POST',
      url: `/api/v2/backups/${backupId}/restore`,
    });
    expect(restored.statusCode, restored.payload).toBe(200);
    const afterRestore = await fileApp.inject({
      method: 'GET',
      url: `/api/v2/plugins/${SECRET_PLUGIN}/state?scope=user`,
    });
    expect(afterRestore.json()).toMatchObject({ revision: 1, data: { theme: 'dark' } });

    // Diagnostics body: aggregate counts only, no secret material.
    const diagnostics = await fileApp.inject({ method: 'GET', url: '/api/v2/diagnostics' });
    expect(diagnostics.statusCode).toBe(200);
    expect(JSON.stringify(diagnostics.json())).not.toContain(SECRET_VALUE);
  });

  it('restores namespaced state without clobbering existing rows (conflict-skip)', () => {
    installPlugin(SECRET_PLUGIN, []);
    const state = database.repos.pluginState;

    const inserted = state.restore({
      pluginId: SECRET_PLUGIN,
      scope: 'user',
      ownerId: null,
      schemaVersion: 1,
      revision: 5,
      data: { a: 1 },
    });
    expect(inserted).toBe(true);

    // A conflicting identity is kept — the backup never clobbers.
    const skipped = state.restore({
      pluginId: SECRET_PLUGIN,
      scope: 'user',
      ownerId: null,
      schemaVersion: 1,
      revision: 5,
      data: { a: 2 },
    });
    expect(skipped).toBe(false);
    const entry = state.get(SECRET_PLUGIN, 'user', null);
    expect(entry?.data).toEqual({ a: 1 });
    expect(entry?.revision).toBe(5);
  });
});

// ── previous-major compatibility (§83) ─────────────────────────────────────

describe('previous-major compatibility (§83)', () => {
  const V2_PLUGIN = 'test.previous-major-v2';

  it('installs and activates an apiVersion 2 plugin through the native-v2 gate', async () => {
    const installed = await installArchive(await pluginPackage(V2_PLUGIN, '1.0.0'));
    expect(installed.statusCode, installed.payload).toBe(200);
    expect(installed.json().plugin).toMatchObject({
      id: V2_PLUGIN,
      apiVersion: 2,
      compatibilityLevel: 'native-v2',
    });

    const activated = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${V2_PLUGIN}/activate`,
      payload: { grantedPermissions: [] },
    });
    expect(activated.statusCode, activated.payload).toBe(200);
    expect(activated.json().plugin).toMatchObject({
      id: V2_PLUGIN,
      apiVersion: 2,
      compatibilityLevel: 'native-v2',
      status: 'active',
      enabled: true,
    });
  });
});

// ── server/API-level negative tests (§83) ──────────────────────────────────

describe('denied and revoked permissions at the API level (§83)', () => {
  const NEG_PLUGIN = 'test.negative-permissions';

  it('denies a privileged route when the plugin has no grant', async () => {
    installPlugin(NEG_PLUGIN, []);

    const state = await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${NEG_PLUGIN}/state?scope=user`,
      payload: { data: { a: 1 } },
    });
    expect(state.statusCode).toBe(403);
    expect(state.json()).toMatchObject({
      code: 'PLUGIN_PERMISSION_DENIED',
      params: { pluginId: NEG_PLUGIN, capability: 'storage.user' },
    });

    const blobs = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${NEG_PLUGIN}/blobs`,
    });
    expect(blobs.statusCode).toBe(403);
    expect(blobs.json().code).toBe('PLUGIN_PERMISSION_DENIED');
  });

  it('stops a route call after the grant is revoked, without reinstalling', async () => {
    installPlugin(NEG_PLUGIN, ['storage.user']);

    const allowed = await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${NEG_PLUGIN}/state?scope=user`,
      payload: { data: { a: 1 } },
    });
    expect(allowed.statusCode).toBe(200);

    // Revoke through the broker as the plugin manager does on deactivation.
    const { createCapabilityBroker } = await import('../src/plugin/capabilityBroker.js');
    const broker = createCapabilityBroker(database.repos.capabilityGrants, new EventBus());
    broker.revoke(NEG_PLUGIN, 'storage.user');

    const denied = await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${NEG_PLUGIN}/state?scope=user`,
      payload: { data: { a: 2 } },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      code: 'PLUGIN_PERMISSION_DENIED',
      params: { pluginId: NEG_PLUGIN, capability: 'storage.user' },
    });

    // Still installed: revocation is not an uninstall.
    const entry = await pluginFromList(NEG_PLUGIN);
    expect(entry.id).toBe(NEG_PLUGIN);
  });
});

describe('package size caps at the API level (§83)', () => {
  const CAP_PLUGIN = 'test.size-caps';

  it('rejects an oversized manifest with PLUGIN_INVALID', async () => {
    const oversized = await zipArchive({
      'plugin.json': JSON.stringify({
        id: CAP_PLUGIN,
        name: CAP_PLUGIN,
        version: '1.0.0',
        apiVersion: 2,
        padding: 'x'.repeat(300 * 1024),
      }),
    });
    const response = await installArchive(oversized);
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('PLUGIN_INVALID');
  });

  it('rejects an oversized entrypoint with PLUGIN_INVALID', async () => {
    const oversized = await zipArchive({
      'plugin.json': JSON.stringify({
        id: CAP_PLUGIN,
        name: CAP_PLUGIN,
        version: '1.0.0',
        apiVersion: 2,
        frontend: 'frontend.js',
      }),
      'frontend.js': 'x'.repeat(10 * 1024 * 1024 + 1),
    });
    const response = await installArchive(oversized);
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('PLUGIN_INVALID');
  });
});

// ── extensions.legacyFrontend server setting ───────────────────────────────

describe('extensions.legacyFrontend setting', () => {
  it('is registered server-side with default false and exposed via the settings API', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v2/settings' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ 'extensions.legacyFrontend': false });
  });
});

// ── package trust (ТЗ §SEC-05) ─────────────────────────────────────────────

const TRUST_PLUGIN = 'test.trust';

function trustKeyPair(): { publicKey: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return { publicKey: Buffer.from(jwk.x, 'base64url').toString('base64'), privateKey };
}

/** Sign every file under `root` (excluding signature/) into signature/*. */
async function signDirectory(root: string, privateKey: KeyObject): Promise<void> {
  const digests: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = pathRelative(root, full).split('\\').join('/');
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && !rel.startsWith('signature/')) {
        digests[rel] = createHash('sha256')
          .update(await readFile(full))
          .digest('hex');
      }
    }
  };
  await walk(root);
  const manifestBytes = Buffer.from(
    JSON.stringify(
      {
        format: 'neotavern.package-signature.v1',
        algorithm: 'ed25519',
        hash: 'sha256',
        files: digests,
      },
      null,
      2,
    ),
    'utf8',
  );
  await mkdir(join(root, 'signature'), { recursive: true });
  await writeFile(join(root, 'signature', 'manifest.json'), manifestBytes);
  await writeFile(join(root, 'signature', 'package.sig'), sign(null, manifestBytes, privateKey));
}

/** Materialize, optionally sign, and zip a package directory. */
async function trustPackage(
  id: string,
  version: string,
  signWith: KeyObject | null,
  mutate: (root: string) => Promise<void> = async () => undefined,
): Promise<Buffer> {
  const root = await mkdir(join(tmpdir(), `neotavern-trust-pkg-${Date.now()}-${Math.random()}`), {
    recursive: true,
  });
  try {
    await writeFile(
      join(root, 'plugin.json'),
      JSON.stringify({ id, name: id, version, apiVersion: 2, frontend: 'frontend.js' }),
    );
    await writeFile(join(root, 'frontend.js'), 'export default {}');
    // Sign first, then let `mutate` tamper with the signed tree — so the
    // signature manifest covers the original bytes and any later change to a
    // signed file is a digest mismatch at verification time.
    if (signWith !== null) await signDirectory(root, signWith);
    await mutate(root);
    const zip = new yazl.ZipFile();
    const add = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await add(full, rel);
        else zip.addFile(full, rel);
      }
    };
    await add(root, '');
    zip.end();
    return await new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
      zip.outputStream.on('error', reject);
      zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('package trust (ТЗ §SEC-05)', () => {
  it('verifies a publisher-signed package at install and records verified-publisher', async () => {
    const { publicKey, privateKey } = trustKeyPair();
    const trusted = await createTestApp({ pluginPublisherKeys: [publicKey] });
    const archive = await trustPackage(TRUST_PLUGIN, '1.0.0', privateKey);

    const response = await trusted.app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install',
      ...multipartFile(archive, `${TRUST_PLUGIN}.stplugin`, 'application/zip'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().plugin).toMatchObject({ trust: 'verified-publisher' });
    expect(response.json().plugin.publisherKeyId).toEqual(expect.stringMatching(/^[0-9a-f]{16}$/u));
  });

  it('rejects a package signed by an unknown publisher (fail-closed)', async () => {
    const { privateKey } = trustKeyPair();
    const trusted = await createTestApp({ pluginPublisherKeys: [] });
    const archive = await trustPackage(TRUST_PLUGIN, '1.0.0', privateKey);

    const response = await trusted.app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install',
      ...multipartFile(archive, `${TRUST_PLUGIN}.stplugin`, 'application/zip'),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'PLUGIN_SIGNATURE_UNTRUSTED' });
  });

  it('rejects a tampered signed package (per-file digest mismatch)', async () => {
    const { publicKey, privateKey } = trustKeyPair();
    const trusted = await createTestApp({ pluginPublisherKeys: [publicKey] });
    const archive = await trustPackage(TRUST_PLUGIN, '1.0.0', privateKey, async (root) => {
      await writeFile(join(root, 'frontend.js'), 'export default { hacked: true }');
    });

    const response = await trusted.app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install',
      ...multipartFile(archive, `${TRUST_PLUGIN}.stplugin`, 'application/zip'),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'PLUGIN_SIGNATURE_INVALID' });
  });

  it('records unsigned packages honestly and rejects them under requireSignature', async () => {
    const archive = await trustPackage(TRUST_PLUGIN, '1.0.0', null);

    const lax = await createTestApp();
    const accepted = await lax.app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install',
      ...multipartFile(archive, `${TRUST_PLUGIN}.stplugin`, 'application/zip'),
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().plugin).toMatchObject({ trust: 'unsigned-untrusted' });

    const strict = await createTestApp({ pluginRequireSignature: true });
    const refused = await strict.app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install',
      ...multipartFile(archive, `${TRUST_PLUGIN}.stplugin`, 'application/zip'),
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ code: 'PLUGIN_SIGNATURE_REQUIRED' });
  });

  it('records local trust when the user enables an unsigned package via consent', async () => {
    const archive = await trustPackage(TRUST_PLUGIN, '1.0.0', null);

    const installed = await app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install',
      ...multipartFile(archive, `${TRUST_PLUGIN}.stplugin`, 'application/zip'),
    });
    expect(installed.statusCode).toBe(200);
    expect(installed.json().plugin.trust).toBe('unsigned-untrusted');

    const activated = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${TRUST_PLUGIN}/activate`,
      payload: { grantedPermissions: [] },
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().plugin.trust).toBe('locally-trusted');
  });

  it('rejects an entrypoint inside signature/ (would escape the signed digest)', async () => {
    const { publicKey, privateKey } = trustKeyPair();
    const trusted = await createTestApp({ pluginPublisherKeys: [publicKey] });
    // Sign a normal tree, then rewrite plugin.json so the frontend entry
    // points at signature/backend.js — a file excluded from the digest.
    const archive = await trustPackage(TRUST_PLUGIN, '1.0.0', privateKey, async (root) => {
      await writeFile(
        join(root, 'plugin.json'),
        JSON.stringify({
          id: TRUST_PLUGIN,
          name: TRUST_PLUGIN,
          version: '1.0.0',
          apiVersion: 2,
          frontend: 'signature/backend.js',
        }),
      );
      await writeFile(join(root, 'signature', 'backend.js'), 'export default { hacked: true }');
    });

    const response = await trusted.app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install',
      ...multipartFile(archive, `${TRUST_PLUGIN}.stplugin`, 'application/zip'),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'PLUGIN_INVALID' });
  });
});
