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
import { createLogger } from '@neotavern/shared';
import { buildApp } from '../src/app.js';
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

afterEach(async () => {
  await Promise.all(trackedApps.splice(0).map((app) => app.close()));
  for (const database of trackedDatabases.splice(0)) database.close();
  await Promise.all(trackedDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
  const database =
    options.database ??
    (options.useFileDatabase
      ? createAppDatabase(paths.dbFile, { autoBackupDir: paths.backups })
      : createAppDatabase(':memory:'));
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
      providerTimeouts: DEFAULT_PROVIDER_TIMEOUTS,
    },
    logger: createLogger({ level: 'error' }),
    paths,
  });
  trackedApps.push(app);
  return { app, database, providers, contextStrategies, postProcessors, paths, dataDir };
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
