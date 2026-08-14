/**
 * Shared server test bootstrap (DUP-26).
 *
 * Eight suites used to carry byte-near copies of the buildApp ceremony and
 * had already drifted (allowSecretsExposure, temp-dir cleanup). All of them
 * now create apps through {@link createTestApp}; apps, databases and temp
 * directories are tracked here and torn down in a registered afterEach.
 */
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { createAppDatabase, type AppDatabase } from '@neotavern/db';
import { DEFAULT_PROVIDER_TIMEOUTS, ProviderRegistry } from '@neotavern/provider-sdk';
import { MemorySecretStore, type SecretStore } from '@neotavern/secret-store';
import { createLogger } from '@neotavern/shared';
import { buildApp } from '../src/app.js';
import {
  createSecretStoreHandle,
  createSecretStoreHandleForBackend,
  type SecretStoreHandle,
} from '../src/lib/secretStore.js';
import type { MaintenanceController } from '../src/lib/maintenance.js';
import { ensureDataDirs, resolveDataPaths, type DataPaths } from '../src/lib/paths.js';
import { ContextStrategyRegistry } from '../src/pipeline/contextShift.js';
import { PostProcessorRegistry } from '../src/pipeline/postProcess.js';
import type { TypedApp } from '../src/types.js';

export interface TestAppHandle {
  app: TypedApp;
  database: AppDatabase;
  providers: ProviderRegistry;
  contextStrategies: ContextStrategyRegistry;
  postProcessors: PostProcessorRegistry;
  paths: DataPaths;
  dataDir: string;
  /** The SecretStore handle wired into the app (ТЗ §SEC-01). */
  secrets: SecretStoreHandle;
}

export interface TestAppOptions {
  /** Database to run against. Default: a fresh in-memory database. */
  database?: AppDatabase;
  /**
   * Create a file-backed database inside the temp data directory (with the
   * automatic backup dir wired) instead of the in-memory default. Needed by
   * backup/restore suites.
   */
  useFileDatabase?: boolean;
  allowSecretsExposure?: boolean;
  safeMode?: boolean;
  /** Trusted plugin publisher keys (ТЗ §SEC-05); default: none. */
  pluginPublisherKeys?: string[];
  /** Reject unsigned plugin packages at install (ТЗ §SEC-05); default false. */
  pluginRequireSignature?: boolean;
  /** Pre-built maintenance controller to share with the app (ТЗ §10.4). */
  maintenance?: MaintenanceController;
  /**
   * SecretStore backend (ТЗ §SEC-01). Default: a fresh session (memory) store,
   * so tests assert the DB holds opaque references while values resolve for
   * the same process.
   */
  secretStore?: SecretStore;
  /** SecretStore mode for the app config; default 'session'. */
  secretMode?: 'portable' | 'session' | 'env';
  /** Master passphrase for portable mode (default 'test-passphrase'). */
  secretPassphrase?: string;
  /** Serve the built SPA from this directory (single-process mode, NEOTA_WEB_DIR). */
  webDir?: string | null;
  /** CORS allowlist origin; defaults to the dev Vite origin. */
  corsOrigin?: string;
  /** Customize registries before the app is built (tokenizer/strategy stubs). */
  configureRegistries?: (registries: {
    providers: ProviderRegistry;
    contextStrategies: ContextStrategyRegistry;
    postProcessors: PostProcessorRegistry;
  }) => void;
}

const trackedApps: TypedApp[] = [];
const trackedDatabases: AppDatabase[] = [];
const trackedDirs: string[] = [];

/**
 * Remove a directory with bounded retries. Windows worker child processes may
 * briefly hold file handles after app.close() returns (EBUSY/EPERM/ENOTEMPTY);
 * retry instead of failing the whole suite on a cleanup race.
 */
async function removeDirWithRetry(dir: string, attempts = 12): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY') {
        if (attempt === attempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
        continue;
      }
      throw error;
    }
  }
}

afterEach(async () => {
  await Promise.all(trackedApps.splice(0).map((app) => app.close()));
  for (const database of trackedDatabases.splice(0)) database.close();
  await Promise.all(trackedDirs.splice(0).map((dir) => removeDirWithRetry(dir)));
});

/**
 * Build a fully wired app against a throwaway data directory. Everything
 * created is registered for automatic afterEach teardown.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestAppHandle> {
  const dataDir = mkdtempSync(join(tmpdir(), 'neotavern-test-'));
  trackedDirs.push(dataDir);
  const paths = resolveDataPaths(dataDir);
  ensureDataDirs(paths);
  const secretMode = options.secretMode ?? 'session';
  let secretsHandle: SecretStoreHandle;
  if (options.secretStore) {
    secretsHandle = createSecretStoreHandleForBackend(options.secretStore);
  } else if (secretMode === 'portable') {
    secretsHandle = await createSecretStoreHandle(
      'portable',
      options.secretPassphrase ?? 'test-passphrase',
      dataDir,
      createLogger({ level: 'error' }),
    );
  } else {
    secretsHandle = createSecretStoreHandleForBackend(new MemorySecretStore());
  }
  const secretResolver = (ref: string): Promise<string | null> => secretsHandle.resolve(ref);
  const database =
    options.database ??
    (options.useFileDatabase
      ? createAppDatabase(paths.dbFile, { autoBackupDir: paths.backups, secretResolver })
      : createAppDatabase(':memory:', { secretResolver }));
  if (!options.database) trackedDatabases.push(database);
  const providers = new ProviderRegistry();
  const contextStrategies = new ContextStrategyRegistry();
  const postProcessors = new PostProcessorRegistry();
  options.configureRegistries?.({ providers, contextStrategies, postProcessors });
  const app = await buildApp({
    database,
    providers,
    contextStrategies,
    postProcessors,
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      webDir: options.webDir ?? null,
      logLevel: 'error',
      corsOrigin: options.corsOrigin ?? 'http://127.0.0.1:5173',
      remoteAccess: false,
      publicOrigin: options.corsOrigin ?? 'http://127.0.0.1:5173',
      remoteTokenHash: null,
      secureSessionCookies: false,
      safeMode: options.safeMode ?? false,
      allowSecretsExposure: options.allowSecretsExposure ?? false,
      pluginNodePath: process.execPath,
      pluginWorkerPath: null,
      pluginLoaderPath: null,
      pluginGitInstall: true,
      pluginRegistryUrl: 'https://registry.npmjs.org',
      pluginDepsMaxPackages: 300,
      pluginDepsMaxBytes: 200 * 1024 * 1024,
      pluginPublisherKeys: options.pluginPublisherKeys ?? [],
      pluginRequireSignature: options.pluginRequireSignature ?? false,
      secretMode,
      secretPassphrase: options.secretPassphrase ?? null,
      providerTimeouts: DEFAULT_PROVIDER_TIMEOUTS,
    },
    maintenance: options.maintenance,
    secrets: secretsHandle,
    logger: createLogger({ level: 'error' }),
    paths,
  });
  trackedApps.push(app);
  return {
    app,
    database,
    providers,
    contextStrategies,
    postProcessors,
    paths,
    dataDir,
    secrets: secretsHandle,
  };
}

/** Build a multipart/form-data body with a single file part (inject-friendly). */
export function multipartFile(
  bytes: Buffer,
  filename: string,
  contentType: string,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `neotavern-test-${Math.random().toString(16).slice(2)}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([prefix, bytes, suffix]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
