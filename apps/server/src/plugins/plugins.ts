/** Plugin package registry, explicit consent lifecycle and sandbox asset delivery. */
import { createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Type } from '@sinclair/typebox';
import {
  PluginActivateRequestSchema,
  PluginDeleteResultSchema,
  PluginGitInstallRequestSchema,
  PluginIdSchema,
  PluginInstallResultSchema,
  PluginLifecycleResultSchema,
  PluginListResponseSchema,
  PluginCapabilitiesResponseSchema,
  PluginCapabilityRequestSchema,
  PluginCapabilityGrantResponseSchema,
  PluginSafeModeResultSchema,
  type InstalledPlugin,
  type CapabilityGrantWire,
  type PluginCapabilitiesResponse,
  type PluginCapabilityGrantResponse,
  type PluginDependencyRecord,
  type PluginGitInstallRequest,
  type PluginInstallResult,
  type PluginListResponse,
  type PluginSource,
} from '@neotavern/contracts';
import { pluginStatus, type PluginRegistryEntry, type PluginRepository } from '@neotavern/db';
import { AppError, ErrorCodes, isAppError, randomToken } from '@neotavern/shared';
import {
  CURRENT_API_VERSION,
  diffPermissions,
  kernel,
  validateManifest,
  type PluginManifest,
} from '@neotavern/plugin-sdk';
import { assertSafeThemeCss } from './themes.js';
import {
  DEFAULT_PACKAGE_ARCHIVE_LIMITS,
  extractPackageArchive,
  validatePackageEntryPath,
} from '../lib/packageArchive.js';
import { extractTarGzArchive } from '../lib/tarballArchive.js';
import { enforceTrustPolicy, verifyPackageTrust } from '../lib/packageTrust.js';
import { DEFAULT_RESOURCE_CONFIG } from '../config.js';
import type { AppContext, TypedApp } from '../types.js';
import { BackendPluginHost } from '../plugin/backendHost.js';
import { ResourceGovernor } from '../plugin/resourceGovernor.js';
import { registerBackendRpcExtensions } from '../plugin/backendRpcExtensions.js';
import { buildSandboxBootstrap } from '../plugin/sandboxBootstrap.js';
import { createCapabilityBroker, type CapabilityBroker } from '../plugin/capabilityBroker.js';
import { createVNextRuntimeService, type VNextRuntimeService } from '../plugin/vnextRuntime.js';
import { registerPluginDataRoutes } from './pluginData.js';
import { registerPluginJobs } from './pluginJobs.js';
import { registerPluginAuthRoutes } from './pluginAuth.js';
import { registerPluginChatRelay } from './pluginChatRelay.js';
import {
  installPluginDependencies,
  readPluginDependencySpecs,
} from '../plugin/dependencyInstaller.js';
import { buildArchiveUrl, downloadRepoArchive, parseGitRepoUrl } from '../plugin/gitSource.js';
import { LegacyServerPluginHost } from '../legacy/host.js';
import { APP_VERSION } from './meta.js';
import { registerPluginSecretRoutes } from './pluginSecrets.js';

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ENTRYPOINT_BYTES = 10 * 1024 * 1024;
const MAX_STYLES_BYTES = 2 * 1024 * 1024;
const MAX_I18N_BYTES = 1024 * 1024;
const FORBIDDEN_PACKAGE_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.node',
  '.bat',
  '.cmd',
  '.ps1',
  '.sh',
]);
const ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

/**
 * Plugin host handshake version (rev4 §A1 `hostVersion`). The web host
 * reports the same value to sandboxed plugins, so server-side `engines.host`
 * enforcement agrees with what a plugin observes at runtime.
 */
const HOST_VERSION = '2.0.0';

/**
 * Host versions that manifest `engines` ranges are resolved against (ТЗ §76,
 * rev4 §A4): `neotavern` = product version, `host` = the plugin host
 * handshake version, `sdk` = the Plugin SDK API major as a semver,
 * `protocol` = the kernel protocol version.
 */
const HOST_ENGINE_VERSIONS = {
  neotavern: APP_VERSION,
  host: HOST_VERSION,
  sdk: `${CURRENT_API_VERSION}.0.0`,
  protocol: kernel.PROTOCOL_VERSION,
} as const;

/**
 * Resolve the manifest `engines` ranges against the current host versions.
 * Returns a typed ENGINE_MISMATCH error naming the failing engine, the
 * required range and the host version, or null when every declared range is
 * satisfied (`engines` is optional — plugins without it are unaffected).
 */
function resolveEngineMismatch(manifest: PluginManifest): AppError | null {
  for (const engine of Object.keys(HOST_ENGINE_VERSIONS) as Array<
    keyof typeof HOST_ENGINE_VERSIONS
  >) {
    const required = manifest.engines?.[engine];
    if (required === undefined) continue;
    const host = HOST_ENGINE_VERSIONS[engine];
    if (!kernel.satisfiesRange(host, required)) {
      return new AppError({
        code: ErrorCodes.ENGINE_MISMATCH,
        params: { engine, required, host },
        message: `Plugin requires ${engine} ${required}, host provides ${host}`,
      });
    }
  }
  return null;
}

function invalidPlugin(reason: string, cause?: unknown): AppError {
  return new AppError({
    code: ErrorCodes.PLUGIN_INVALID,
    params: { reason },
    message: `Invalid plugin package: ${reason}`,
    cause,
  });
}

function manifestRecord(manifest: PluginManifest): Record<string, unknown> {
  return Object.fromEntries(Object.entries(manifest));
}

function toInstalledPlugin(
  entry: PluginRegistryEntry,
  grantedCapabilities: readonly CapabilityGrantWire[] = [],
): InstalledPlugin {
  const validation = validateManifest(entry.manifest);
  if (!validation.ok) throw invalidPlugin('stored manifest failed validation', validation.error);
  const manifest = validation.value;
  return {
    ...entry,
    status: pluginStatus(entry),
    manifest: manifestRecord(manifest),
    apiVersion: manifest.apiVersion,
    source: entry.source ?? undefined,
    dependencies: entry.dependencies ?? undefined,
    requestedPermissions: requestedConsentItems(manifest),
    addedPermissions: diffPermissions(entry.grantedPermissions, requestedConsentItems(manifest))
      .added,
    hasFrontend: Boolean(manifest.frontend),
    hasBackend: Boolean(manifest.backend),
    hasStyles: Boolean(manifest.styles),
    hasLegacyFrontend: Boolean(manifest.legacy?.frontend),
    hasLegacyBackend: Boolean(manifest.legacy?.backend),
    compatibilityLevel: manifest.legacy
      ? 'legacy-trusted'
      : manifest.apiVersion >= 3
        ? 'native-v3'
        : 'native-v2',
    grantedCapabilities: [...grantedCapabilities],
    trust: entry.trust,
    publisherKeyId: entry.publisherKeyId ?? undefined,
  };
}

async function findPackageRoot(extractedRoot: string): Promise<string> {
  if (await exists(join(extractedRoot, 'plugin.json'))) return extractedRoot;
  const entries = await readdir(extractedRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory() && entry.name !== '__MACOSX');
  if (directories.length !== 1) throw invalidPlugin('plugin.json must be at the package root');
  const candidate = join(extractedRoot, directories[0]?.name ?? '');
  if (!(await exists(join(candidate, 'plugin.json')))) {
    throw invalidPlugin('plugin.json must be at the package root');
  }
  return candidate;
}

async function readManifest(packageRoot: string): Promise<PluginManifest> {
  const path = join(packageRoot, 'plugin.json');
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > MAX_MANIFEST_BYTES) {
    throw invalidPlugin('plugin.json is missing or too large');
  }
  let input: unknown;
  try {
    input = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (cause) {
    throw invalidPlugin('plugin.json is not valid JSON', cause);
  }
  const result = validateManifest(input);
  if (!result.ok) throw result.error;
  return result.value;
}

async function validatePackage(packageRoot: string, manifest: PluginManifest): Promise<void> {
  await rejectForbiddenPackageFiles(packageRoot);
  for (const entryPath of [manifest.frontend, manifest.backend]) {
    if (entryPath) await assertRegularFile(packageRoot, entryPath, MAX_ENTRYPOINT_BYTES);
  }
  for (const entryPath of [manifest.legacy?.frontend, manifest.legacy?.backend]) {
    if (entryPath) await assertRegularFile(packageRoot, entryPath, MAX_ENTRYPOINT_BYTES);
  }
  if (manifest.styles) {
    const path = await assertRegularFile(packageRoot, manifest.styles, MAX_STYLES_BYTES);
    assertSafeThemeCss(await readFile(path, 'utf8'));
  }
  for (const localePath of Object.values(manifest.i18n ?? {})) {
    const path = await assertRegularFile(packageRoot, localePath, MAX_I18N_BYTES);
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new TypeError('translation root must be an object');
      }
    } catch (cause) {
      throw invalidPlugin('i18n resources must contain JSON objects', cause);
    }
  }
}

async function readBundledTranslations(
  packageRoot: string,
  manifest: PluginManifest,
): Promise<Record<string, Record<string, unknown>>> {
  const resources: Record<string, Record<string, unknown>> = {};
  for (const [language, localePath] of Object.entries(manifest.i18n ?? {})) {
    const path = await assertRegularFile(packageRoot, localePath, MAX_I18N_BYTES);
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw invalidPlugin('i18n resources must contain JSON objects');
    }
    resources[language] = parsed as Record<string, unknown>;
  }
  return resources;
}

async function assertRegularFile(
  root: string,
  relativePath: string,
  maxBytes: number,
): Promise<string> {
  const path = resolve(root, ...validatePackageEntryPath(relativePath));
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw invalidPlugin(`required package file is missing or exceeds ${maxBytes} bytes`);
  }
  return path;
}

async function rejectForbiddenPackageFiles(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw invalidPlugin('symbolic links are not allowed');
    if (entry.isDirectory()) {
      await rejectForbiddenPackageFiles(path);
    } else if (
      entry.isFile() &&
      FORBIDDEN_PACKAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())
    ) {
      throw invalidPlugin(`native or executable package file is not allowed: ${entry.name}`);
    }
  }
}

/**
 * Consent validation (ТЗ §7.4): the user may grant ANY subset of the
 * permissions a manifest requests — ungranted capabilities are simply never
 * handed to the plugin (every enforcement point checks the granted set).
 * Granting something the manifest never asked for is refused.
 */
function permissionsSubset(requested: readonly string[], granted: readonly string[]): boolean {
  const requestedSet = new Set(requested);
  return granted.every((permission) => requestedSet.has(permission));
}

/**
 * Rev4 §B1/§B2: the consent UI displays one checkbox per requested item, and
 * `grantConsented` issues broker grants by exact name match. Capability names
 * declared in `requiredCapabilities`/`optionalCapabilities` are therefore
 * surfaced alongside the flat `permissions` list so the user can consent to
 * them and the broker can grant them (capability-only manifests would
 * otherwise receive zero grants).
 */
function requestedConsentItems(manifest: PluginManifest): string[] {
  const items = new Set<string>(manifest.permissions ?? []);
  for (const request of [
    ...(manifest.requiredCapabilities ?? []),
    ...(manifest.optionalCapabilities ?? []),
  ]) {
    items.add(request.name);
  }
  return [...items];
}

interface PluginInstallEnvironment {
  ctx: AppContext;
  repo: PluginRepository;
  backendHost: BackendPluginHost;
  legacyHost: LegacyServerPluginHost;
  /** vNext runtime service for v3 backends (Stage A). */
  runtime: VNextRuntimeService;
  /** Runtime safe-mode flag at install time. */
  safeMode: boolean;
  /** Provenance recorded in the plugin registry. */
  source?: PluginSource;
  /** The user explicitly accepted an unsigned package (ТЗ §SEC-05). */
  trustLocal?: boolean;
}

/**
 * Shared install sequence for every package source (ZIP upload, Git archive):
 * validate the extracted package, materialize its npm dependencies, then
 * atomically replace any previous installation with rollback on failure.
 * `extractedRoot` must be on the same volume as the plugins directory.
 */
async function installFromExtractedDir(
  extractedRoot: string,
  env: PluginInstallEnvironment,
): Promise<PluginInstallResult> {
  const { ctx, repo, backendHost, legacyHost, runtime } = env;
  const packageRoot = await findPackageRoot(extractedRoot);
  const manifest = await readManifest(packageRoot);
  await validatePackage(packageRoot, manifest);
  // ТЗ §SEC-05: publisher signature and per-file digests are verified before
  // any consent or filesystem promotion. A broken or untrusted signature
  // rejects the install outright; an unsigned package passes through only if
  // the policy allows it (and records the trust state honestly).
  const trustVerdict = enforceTrustPolicy(
    await verifyPackageTrust(packageRoot, ctx.config.pluginPublisherKeys),
    ctx.config.pluginRequireSignature,
    env.trustLocal === true,
  );

  const existing = repo.getById(manifest.id);
  // ТЗ §76: engines are enforced at install. An incompatible update never
  // replaces the installed version — the previous version stays installed
  // and the plugin is auto-disabled with a stable diagnostic (exit gate
  // "incompatible update откатывается/отключается", §83). A fresh install
  // is simply rejected.
  const engineMismatch = resolveEngineMismatch(manifest);
  if (engineMismatch) {
    if (existing?.enabled) {
      await Promise.all([
        backendHost.deactivate(manifest.id),
        legacyHost.deactivate(manifest.id),
        manifest.apiVersion >= 3 ? runtime.deactivate(manifest.id) : Promise.resolve(),
      ]);
    }
    if (existing) {
      repo.markError(manifest.id, ErrorCodes.ENGINE_MISMATCH);
      ctx.events.emit('plugin.disabled', {
        pluginId: manifest.id,
        reason: ErrorCodes.ENGINE_MISMATCH,
        ...engineMismatch.params,
      });
    }
    throw engineMismatch;
  }

  const dependencies = await installPackageDependencies(packageRoot, ctx);

  if (existing?.enabled) {
    await Promise.all([
      backendHost.deactivate(manifest.id),
      legacyHost.deactivate(manifest.id),
      manifest.apiVersion >= 3 ? runtime.deactivate(manifest.id) : Promise.resolve(),
    ]);
  }
  // rev4 §J2: the update lifecycle is observable — the sandbox receives
  // `beforeUpdate` and can finalize its state before the files swap.
  if (existing) {
    ctx.events.emit('plugin.updating', {
      pluginId: manifest.id,
      version: manifest.version,
      previousVersion: existing.version,
    });
  }

  const pluginRoot = join(ctx.paths.plugins, manifest.id);
  const finalPath = join(pluginRoot, 'package');
  await mkdir(pluginRoot, { recursive: true });
  const incomingPath = join(pluginRoot, `.incoming-${randomToken(10)}`);
  await rename(packageRoot, incomingPath);
  let rollbackPath: string | null = null;
  if (await exists(finalPath)) {
    rollbackPath = join(pluginRoot, `.rollback-${randomToken(10)}`);
    await rename(finalPath, rollbackPath);
  }

  try {
    await rename(incomingPath, finalPath);
    const installed = repo.install({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      manifest: manifestRecord(manifest),
      requestedPermissions: requestedConsentItems(manifest),
      source: env.source,
      dependencies,
      trust: trustVerdict.trust,
      publisherKeyId: trustVerdict.publisherKeyId,
    });
    if (rollbackPath) {
      await rm(rollbackPath, { recursive: true, force: true }).catch(() => undefined);
    }
    // rev4 §J2: consumers of the update lifecycle (the web runtime forwards
    // `afterUpdate` to the live sandbox) rely on this pair of events.
    if (existing) {
      ctx.events.emit('plugin.updated', {
        pluginId: manifest.id,
        version: manifest.version,
        previousVersion: existing.version,
      });
    }
    // rev4 §B2: persist the consented manifest capabilities as broker
    // grants so the kernel handshake and runtime checks see the same set.
    const grants = createCapabilityBroker(
      ctx.database.repos.capabilityGrants,
      ctx.events,
    ).grantConsented(manifest.id, manifest, installed.plugin.grantedPermissions);
    // Safe mode must not load native or legacy entry points — not even
    // for an update installed over an already-enabled plugin (PLUG-51).
    // The enabled flag stays set so the plugin starts when safe mode is
    // exited.
    if (installed.plugin.enabled && !env.safeMode) {
      try {
        await activatePluginBackends(
          manifest,
          finalPath,
          installed.plugin.grantedPermissions,
          backendHost,
          legacyHost,
          env.runtime,
        );
      } catch {
        const failed = repo.markError(manifest.id, ErrorCodes.PLUGIN_LOAD_FAILED);
        if (failed) installed.plugin = failed;
      }
    }
    return {
      plugin: toInstalledPlugin(installed.plugin, grants),
      replaced: installed.replaced,
    };
  } catch (cause) {
    // Rollback must never mask the original install error: every step is
    // contained and its failures are reported separately (a throwing
    // rm/rename/markError here previously replaced `cause` or escaped
    // as an unhandled rejection).
    const rollbackFailure = async (step: string, action: Promise<unknown>): Promise<void> => {
      try {
        await action;
      } catch (rollbackError) {
        ctx.logger.error(
          `plugin install rollback failed at ${step}: ${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`,
        );
      }
    };
    await rollbackFailure('remove-failed', rm(finalPath, { recursive: true, force: true }));
    if (rollbackPath) {
      await rollbackFailure('restore-previous', rename(rollbackPath, finalPath));
      // rev4 §J2: the failed version never ran — consumers (the web runtime)
      // receive `rollback` and the sandbox finalizes accordingly.
      ctx.events.emit('plugin.rollback', {
        pluginId: manifest.id,
        previousVersion: existing?.version,
        failedVersion: manifest.version,
      });
    }
    await rollbackFailure('remove-incoming', rm(incomingPath, { recursive: true, force: true }));
    const previous = repo.getById(manifest.id);
    if (previous?.enabled && rollbackPath) {
      const previousManifest = validatedStoredManifest(previous);
      await rollbackFailure(
        'reactivate-previous',
        activatePluginBackends(
          previousManifest,
          finalPath,
          previous.grantedPermissions,
          backendHost,
          legacyHost,
          env.runtime,
        ).catch(() => {
          repo.markError(previous.id, ErrorCodes.PLUGIN_LOAD_FAILED);
        }),
      );
    }
    throw cause;
  }
}

/**
 * Resolve and materialize the npm dependencies declared in the package's
 * `package.json` into `<packageRoot>/node_modules` (ТЗ plugin install v1).
 * Returns registry records for the installed packages, or [] when the package
 * declares no dependencies (or has no package.json at all).
 */
async function installPackageDependencies(
  packageRoot: string,
  ctx: AppContext,
): Promise<PluginDependencyRecord[]> {
  const packageJsonPath = join(packageRoot, 'package.json');
  const info = await stat(packageJsonPath).catch(() => null);
  if (!info?.isFile() || info.size > MAX_MANIFEST_BYTES) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as unknown;
  } catch (cause) {
    throw invalidPlugin('package.json is not valid JSON', cause);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidPlugin('package.json must contain an object');
  }
  const specs = readPluginDependencySpecs(parsed as Record<string, unknown>);
  if (specs.size === 0) return [];
  const records = await installPluginDependencies(packageRoot, specs, {
    registryUrl: ctx.config.pluginRegistryUrl,
    cacheDir: join(ctx.paths.cache, 'plugin-deps'),
    maxPackages: ctx.config.pluginDepsMaxPackages,
    maxExpandedBytes: ctx.config.pluginDepsMaxBytes,
  });
  return records.map((record) => ({
    name: record.name,
    version: record.version,
    tarball: record.resolved,
    integrity: record.integrity,
  }));
}

export async function registerPluginRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  const repo = ctx.database.repos.plugins;
  const legacyHost = new LegacyServerPluginHost(app);
  // Resource Governor (ТЗ §8, ADR-0026): single owner of the plugin process
  // tree budgets. The host keeps owning every process; the governor only
  // requests terminations, which are executed through the host's own
  // lifecycle locks so no spawn/deactivate race can slip through (PLUG-52).
  const governor = new ResourceGovernor({
    config: ctx.config.resources ?? DEFAULT_RESOURCE_CONFIG,
    logger: ctx.logger,
  });
  governor.onTerminate = (pluginId, reason) => {
    void backendHost.deactivate(pluginId).catch((error) => {
      ctx.logger.warn(
        `resource governor: failed to terminate ${pluginId} (${reason}): ${String(error)}`,
      );
    });
  };
  const backendHost = new BackendPluginHost(app, ctx, legacyHost, governor);
  const broker = createCapabilityBroker(ctx.database.repos.capabilityGrants, ctx.events);
  const vnextRuntime = createVNextRuntimeService(ctx, {
    nodeExecutable: ctx.config.pluginNodePath ?? undefined,
    stderrSink: (line) => ctx.logger.info(`[plugin-runtime] ${line}`),
    // §8.1: built module graphs persist on disk (source digest + Node/SES/
    // Endo/loader versions); the cache is removable and self-rebuilding.
    moduleMapCacheDir: join(ctx.paths.cache, 'plugin-module-maps'),
    // §30 Files API: every files.* operation is confined to the plugin's
    // own data directory (plugins/<id>/data), mirroring the rev4 scope.
    filesRoot: (pluginId) => join(ctx.paths.plugins, pluginId, 'data'),
    // §9.1.1 host log router: plugin console records arrive batched over
    // LOG_BATCH frames; the router attributes them to the plugin and writes
    // them through the server logger. `suppressed` marks the synthetic
    // `[NT] N plugin log records suppressed` record (rule 9).
    logSink: (entry) => {
      const label = entry.pluginId === '<unknown>' ? '[plugin]' : `[plugin:${entry.pluginId}]`;
      if (entry.suppressed !== undefined) {
        ctx.logger.warn(`${label} ${entry.message}`);
        return;
      }
      const text = `${label} ${entry.message}`;
      switch (entry.level) {
        case 'error':
          ctx.logger.error(text);
          break;
        case 'warn':
          ctx.logger.warn(text);
          break;
        case 'debug':
        case 'trace':
          ctx.logger.debug(text);
          break;
        default:
          ctx.logger.info(text);
      }
    },
  });
  let runtimeSafeMode = ctx.config.safeMode;
  backendHost.registerDispatcher();
  governor.start();
  const jobs = await registerPluginJobs(app, ctx, broker, backendHost);
  registerBackendRpcExtensions(backendHost, ctx, broker, jobs);
  registerPluginAuthRoutes(app, ctx, broker, repo, () => runtimeSafeMode);
  await registerPluginDataRoutes(app, ctx, broker);
  await registerPluginSecretRoutes(app, ctx, broker);
  const unregisterChatRelay = registerPluginChatRelay(app, ctx);
  app.addHook('onClose', async () => {
    unregisterChatRelay();
    governor.stop();
    await vnextRuntime.shutdown();
    await Promise.all([backendHost.close(), legacyHost.close()]);
  });

  app.get(
    '/api/v2/plugins',
    { schema: { response: { 200: PluginListResponseSchema } } },
    async (): Promise<PluginListResponse> => ({
      items: repo.list().map((entry) => toInstalledPlugin(entry, broker.activeGrants(entry.id))),
      safeMode: runtimeSafeMode,
    }),
  );

  app.post(
    '/api/v2/plugins/install',
    { schema: { response: { 200: PluginInstallResultSchema } } },
    async (request) => {
      const upload = await request.file({
        throwFileSizeLimit: false,
        limits: { fileSize: DEFAULT_PACKAGE_ARCHIVE_LIMITS.maxArchiveBytes },
      });
      if (!upload) {
        throw new AppError({ code: ErrorCodes.BAD_REQUEST, params: { reason: 'FILE_REQUIRED' } });
      }

      const temporaryRoot = await mkdtemp(join(ctx.paths.plugins, '.install-'));
      const archivePath = join(temporaryRoot, 'source.zip');
      const extractedRoot = join(temporaryRoot, 'extracted');
      try {
        await pipeline(upload.file, createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }));
        if (upload.file.truncated) {
          throw new AppError({
            code: ErrorCodes.FILE_TOO_LARGE,
            params: { limitBytes: DEFAULT_PACKAGE_ARCHIVE_LIMITS.maxArchiveBytes },
          });
        }
        await extractPackageArchive(archivePath, extractedRoot);
        const result = await installFromExtractedDir(extractedRoot, {
          ctx,
          repo,
          backendHost,
          legacyHost,
          runtime: vnextRuntime,
          safeMode: runtimeSafeMode,
          source: { type: 'zip' },
        });
        ctx.events.emit('plugin.installed', { pluginId: result.plugin.id });
        return result;
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  /**
   * Install a plugin from a public Git repository archive (ТЗ plugin install
   * v1). The server downloads the host-provided tar.gz over HTTPS — it never
   * shells out to a `git` binary — then reuses the same validation, consent
   * and rollback path as the ZIP install.
   */
  app.post(
    '/api/v2/plugins/install-git',
    {
      schema: {
        body: PluginGitInstallRequestSchema,
        response: { 200: PluginInstallResultSchema },
      },
    },
    async (request) => {
      if (!ctx.config.pluginGitInstall) {
        throw new AppError({
          code: ErrorCodes.FORBIDDEN,
          params: { reason: 'PLUGIN_GIT_INSTALL_DISABLED' },
        });
      }
      const body: PluginGitInstallRequest = request.body;
      // The request ref wins over a ref embedded in the URL so the UI can
      // always pin an explicit version without re-pasting the link.
      const repoRef = parseGitRepoUrl(body.url);
      if (body.ref) repoRef.ref = body.ref;
      const archiveUrl = buildArchiveUrl(repoRef);
      const source: PluginSource = {
        type: 'git',
        url: body.url,
        ...(repoRef.ref !== undefined ? { ref: repoRef.ref } : {}),
      };

      // The temporary root must live on the same volume as the plugins
      // directory: the shared install path promotes the package with rename().
      const temporaryRoot = await mkdtemp(join(ctx.paths.plugins, '.install-git-'));
      const archivePath = join(temporaryRoot, 'source.tar.gz');
      const extractedRoot = join(temporaryRoot, 'extracted');
      try {
        await downloadRepoArchive(archiveUrl, archivePath, { signal: request.signal });
        await extractTarGzArchive(archivePath, extractedRoot, undefined, request.signal);
        const result = await installFromExtractedDir(extractedRoot, {
          ctx,
          repo,
          backendHost,
          legacyHost,
          runtime: vnextRuntime,
          safeMode: runtimeSafeMode,
          source,
        });
        ctx.events.emit('plugin.installed', { pluginId: result.plugin.id });
        return result;
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  app.post(
    '/api/v2/plugins/:id/activate',
    {
      schema: {
        params: Type.Object({ id: PluginIdSchema }),
        body: PluginActivateRequestSchema,
        response: { 200: PluginLifecycleResultSchema },
      },
    },
    async (request) => {
      const existing = repo.getById(request.params.id);
      if (!existing) {
        throw new AppError({
          code: ErrorCodes.PLUGIN_NOT_FOUND,
          params: { pluginId: request.params.id },
        });
      }
      const manifest = validatedStoredManifest(existing);
      // ТЗ §76: engines are also enforced at activation — a host upgrade (or
      // a registry write that predates the gate) must not let an
      // incompatible plugin start.
      const engineMismatch = resolveEngineMismatch(manifest);
      if (engineMismatch) throw engineMismatch;
      if (!permissionsSubset(requestedConsentItems(manifest), request.body.grantedPermissions)) {
        throw new AppError({
          code: ErrorCodes.PLUGIN_PERMISSION_DENIED,
          params: {
            pluginId: request.params.id,
            requestedPermissions: existing.requestedPermissions,
            grantedPermissions: request.body.grantedPermissions,
            reason: 'GRANTED_EXCEEDS_REQUESTED',
          },
        });
      }
      if (runtimeSafeMode) {
        throw new AppError({
          code: ErrorCodes.FORBIDDEN,
          params: { reason: 'SAFE_MODE_ACTIVE' },
        });
      }
      // Legacy entrypoints execute unmanaged (main-window JS / in-process
      // Express), so a legacy plugin cannot run at all without the separately
      // consented `legacy.trusted` permission — refuse instead of starting a
      // degraded mode that would still require trust (ТЗ §7.5, §8).
      if (manifest.legacy && !request.body.grantedPermissions.includes('legacy.trusted')) {
        throw new AppError({
          code: ErrorCodes.PLUGIN_PERMISSION_DENIED,
          params: {
            pluginId: existing.id,
            permission: 'legacy.trusted',
            reason: 'LEGACY_CONSENT_REQUIRED',
          },
        });
      }
      try {
        await activatePluginBackends(
          manifest,
          join(ctx.paths.plugins, existing.id, 'package'),
          request.body.grantedPermissions,
          backendHost,
          legacyHost,
          vnextRuntime,
        );
      } catch (cause) {
        // Permission denials are consent decisions, not load failures —
        // surface them unchanged instead of masking as PLUGIN_LOAD_FAILED.
        if (isAppError(cause) && cause.code === ErrorCodes.PLUGIN_PERMISSION_DENIED) throw cause;
        repo.markError(existing.id, ErrorCodes.PLUGIN_LOAD_FAILED);
        throw new AppError({
          code: ErrorCodes.PLUGIN_LOAD_FAILED,
          params: { pluginId: existing.id, reason: 'ACTIVATION_FAILED' },
          cause,
        });
      }
      const plugin = repo.grantAndEnable(request.params.id, request.body.grantedPermissions);
      broker.grantConsented(request.params.id, manifest, request.body.grantedPermissions);
      if (!plugin) {
        await Promise.all([
          backendHost.deactivate(request.params.id),
          legacyHost.deactivate(request.params.id),
          vnextRuntime.deactivate(request.params.id),
        ]);
        throw new AppError({
          code: ErrorCodes.PLUGIN_NOT_FOUND,
          params: { pluginId: request.params.id },
        });
      }
      // ТЗ §SEC-05: enabling an unsigned package through the consent flow is
      // an explicit local trust decision — record it so the UI can tell
      // "the user accepted this unsigned package" from "never decided".
      const activatedEntry = repo.markLocallyTrusted(request.params.id) ?? plugin;
      const activated = toInstalledPlugin(activatedEntry, broker.activeGrants(activatedEntry.id));
      ctx.events.emit('plugin.activated', { pluginId: plugin.id });
      return { plugin: activated };
    },
  );

  app.post(
    '/api/v2/plugins/:id/disable',
    {
      schema: {
        params: Type.Object({ id: PluginIdSchema }),
        response: { 200: PluginLifecycleResultSchema },
      },
    },
    async (request) => {
      await Promise.all([
        backendHost.deactivate(request.params.id),
        legacyHost.deactivate(request.params.id),
        vnextRuntime.deactivate(request.params.id),
      ]);
      broker.revokeAll(request.params.id);
      const plugin = repo.disable(request.params.id);
      if (!plugin) {
        throw new AppError({
          code: ErrorCodes.PLUGIN_NOT_FOUND,
          params: { pluginId: request.params.id },
        });
      }
      const disabled = toInstalledPlugin(plugin, broker.activeGrants(plugin.id));
      ctx.events.emit('plugin.disabled', { pluginId: plugin.id });
      return { plugin: disabled };
    },
  );

  app.delete(
    '/api/v2/plugins/:id',
    {
      schema: {
        params: Type.Object({ id: PluginIdSchema }),
        response: { 200: PluginDeleteResultSchema },
      },
    },
    async (request) => {
      // rev4 §J2: the sandbox receives `uninstall` and can clean up
      // long-lived state before the plugin disappears.
      ctx.events.emit('plugin.uninstalling', { pluginId: request.params.id });
      await Promise.all([
        backendHost.deactivate(request.params.id),
        legacyHost.deactivate(request.params.id),
        vnextRuntime.deactivate(request.params.id),
      ]);
      broker.revokeAll(request.params.id);
      const pluginRoot = join(ctx.paths.plugins, request.params.id);
      const removalPath = join(ctx.paths.plugins, `.remove-${randomToken(10)}`);
      const hadFiles = await exists(pluginRoot);
      if (hadFiles) await rename(pluginRoot, removalPath);
      let deleted: boolean;
      try {
        deleted = repo.delete(request.params.id);
      } catch (cause) {
        if (hadFiles && (await exists(removalPath))) await rename(removalPath, pluginRoot);
        throw cause;
      }
      if (deleted || hadFiles) {
        await rm(removalPath, { recursive: true, force: true }).catch(() => undefined);
        ctx.events.emit('plugin.deleted', { pluginId: request.params.id });
      }
      return { deleted };
    },
  );

  app.post(
    '/api/v2/plugins/runtime/safe-mode',
    { schema: { response: { 200: PluginSafeModeResultSchema } } },
    async () => {
      runtimeSafeMode = true;
      await Promise.all([backendHost.close(), legacyHost.close(), vnextRuntime.shutdown()]);
      return { safeMode: true };
    },
  );

  app.delete(
    '/api/v2/plugins/runtime/safe-mode',
    { schema: { response: { 200: PluginSafeModeResultSchema } } },
    async () => {
      runtimeSafeMode = false;
      await activateEnabledPlugins(repo.list(), backendHost, legacyHost, ctx, broker, vnextRuntime);
      return { safeMode: false };
    },
  );

  app.get(
    '/api/v2/plugins/:id/sandbox',
    {
      schema: {
        params: Type.Object({ id: PluginIdSchema }),
      },
    },
    async (request, reply) => {
      const entry = requireEnabledFrontend(repo.getById(request.params.id), runtimeSafeMode);
      const manifest = validatedStoredManifest(entry);
      const styles = manifest.styles
        ? `<link rel="stylesheet" href="/api/v2/plugins/${encodeURIComponent(entry.id)}/assets/${encodePackagePath(manifest.styles)}">`
        : '';
      const script = `/api/v2/plugins/${encodeURIComponent(entry.id)}/sandbox.js`;
      const assetOrigin = ctx.config.publicOrigin;
      reply.header(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'self' ${assetOrigin} blob: data:; style-src 'self' ${assetOrigin}; img-src 'self' ${assetOrigin} data:; font-src 'self' ${assetOrigin}; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; worker-src blob: data:`,
      );
      reply.header('Cache-Control', 'no-store');
      return reply
        .type('text/html; charset=utf-8')
        .send(
          `<!doctype html><html><head><meta charset="utf-8">${styles}</head><body data-component="plugin-sandbox"><div id="root"></div><script type="module" src="${script}"></script></body></html>`,
        );
    },
  );

  app.get(
    '/api/v2/plugins/:id/sandbox.js',
    {
      config: { cors: { origin: '*', methods: ['GET'] } },
      schema: {
        params: Type.Object({ id: PluginIdSchema }),
      },
    },
    async (request, reply) => {
      const entry = requireEnabledFrontend(repo.getById(request.params.id), runtimeSafeMode);
      const manifest = validatedStoredManifest(entry);
      if (!manifest.frontend) {
        throw new AppError({
          code: ErrorCodes.PLUGIN_NOT_FOUND,
          params: { pluginId: entry.id },
        });
      }
      const entryUrl = `/api/v2/plugins/${encodeURIComponent(entry.id)}/assets/${encodePackagePath(manifest.frontend)}`;
      const packageRoot = join(ctx.paths.plugins, entry.id, 'package');
      const bundledTranslations = await readBundledTranslations(packageRoot, manifest);
      return reply
        .type('text/javascript; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .header('Access-Control-Allow-Origin', '*')
        .header('Cross-Origin-Resource-Policy', 'cross-origin')
        .send(
          buildSandboxBootstrap(
            entry.id,
            entryUrl,
            bundledTranslations,
            broker.activeGrants(entry.id),
          ),
        );
    },
  );

  app.get(
    '/api/v2/plugins/:id/capabilities',
    {
      schema: {
        params: Type.Object({ id: PluginIdSchema }),
        response: { 200: PluginCapabilitiesResponseSchema },
      },
    },
    async (request): Promise<PluginCapabilitiesResponse> => {
      requireEnabledPlugin(repo.getById(request.params.id), runtimeSafeMode);
      return { items: broker.activeGrants(request.params.id) };
    },
  );

  app.post(
    '/api/v2/plugins/:id/capabilities',
    {
      schema: {
        params: Type.Object({ id: PluginIdSchema }),
        body: PluginCapabilityRequestSchema,
        response: { 200: PluginCapabilityGrantResponseSchema },
      },
    },
    async (request): Promise<PluginCapabilityGrantResponse> => {
      // Runtime grant (rev4 §B2 capabilities.request): the user approved the
      // capability in the host consent UI; persist it like a manifest grant.
      const entry = requireEnabledPlugin(repo.getById(request.params.id), runtimeSafeMode);
      const grant = broker.grantRuntime(entry.id, {
        name: request.body.name,
        scope: kernel.parseCapabilityScope(request.body.scope),
      });
      if (!grant) {
        throw new AppError({
          code: ErrorCodes.BAD_REQUEST,
          params: { reason: 'unknown-capability', name: request.body.name },
        });
      }
      return { grant };
    },
  );

  app.get(
    '/api/v2/plugins/:id/legacy.js',
    {
      schema: {
        params: Type.Object({ id: PluginIdSchema }),
      },
    },
    async (request, reply) => {
      const entry = requireEnabledPlugin(repo.getById(request.params.id), runtimeSafeMode);
      const manifest = validatedStoredManifest(entry);
      if (!manifest.legacy?.frontend || !entry.grantedPermissions.includes('legacy.trusted')) {
        throw new AppError({
          code: ErrorCodes.PLUGIN_NOT_FOUND,
          params: { pluginId: entry.id },
        });
      }
      const path = await assertRegularFile(
        join(ctx.paths.plugins, entry.id, 'package'),
        manifest.legacy.frontend,
        MAX_ENTRYPOINT_BYTES,
      );
      return reply
        .type('text/javascript; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .send(createReadStream(path));
    },
  );

  app.get(
    '/api/v2/plugins/:id/assets/*',
    {
      config: { cors: { origin: '*', methods: ['GET'] } },
      schema: {
        params: Type.Object({ id: PluginIdSchema, '*': Type.String({ minLength: 1 }) }),
      },
    },
    async (request, reply) => {
      // Assets of disabled plugins (or any plugin in safe mode) are not
      // served: the sandbox routes already require enabled+!safeMode, and
      // this cross-origin endpoint must not be the easier path (PLUG-59 L8).
      requireEnabledPlugin(repo.getById(request.params.id), runtimeSafeMode);
      const relativePath = request.params['*'];
      const extension = extname(relativePath).toLowerCase();
      const contentType = ASSET_CONTENT_TYPES[extension];
      if (!contentType || FORBIDDEN_PACKAGE_EXTENSIONS.has(extension)) {
        throw new AppError({
          code: ErrorCodes.FILE_TYPE_NOT_ALLOWED,
          params: { extension },
        });
      }
      const path = resolve(
        ctx.paths.plugins,
        request.params.id,
        'package',
        ...validatePackageEntryPath(relativePath),
      );
      const info = await lstat(path).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) {
        throw new AppError({ code: ErrorCodes.FILE_NOT_FOUND, params: { relativePath } });
      }
      return reply
        .type(contentType)
        .header('Cache-Control', 'no-store')
        .header('Access-Control-Allow-Origin', '*')
        .header('Cross-Origin-Resource-Policy', 'cross-origin')
        .send(createReadStream(path));
    },
  );

  app.addHook('onReady', async () => {
    if (!runtimeSafeMode) {
      await activateEnabledPlugins(repo.list(), backendHost, legacyHost, ctx, broker, vnextRuntime);
    }
  });
}

function validatedStoredManifest(entry: PluginRegistryEntry): PluginManifest {
  const result = validateManifest(entry.manifest);
  if (!result.ok) throw result.error;
  return result.value;
}

function requireEnabledFrontend(
  entry: PluginRegistryEntry | null,
  safeMode: boolean,
): PluginRegistryEntry {
  if (!entry || !entry.enabled || safeMode) {
    throw new AppError({
      code: ErrorCodes.PLUGIN_NOT_FOUND,
      params: { pluginId: entry?.id },
    });
  }
  if (!validatedStoredManifest(entry).frontend) {
    throw new AppError({
      code: ErrorCodes.PLUGIN_NOT_FOUND,
      params: { pluginId: entry.id },
    });
  }
  return entry;
}

function requireEnabledPlugin(
  entry: PluginRegistryEntry | null,
  safeMode: boolean,
): PluginRegistryEntry {
  if (!entry || !entry.enabled || safeMode) {
    throw new AppError({
      code: ErrorCodes.PLUGIN_NOT_FOUND,
      params: { pluginId: entry?.id },
    });
  }
  return entry;
}

function encodePackagePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function activateEnabledPlugins(
  entries: readonly PluginRegistryEntry[],
  backendHost: BackendPluginHost,
  legacyHost: LegacyServerPluginHost,
  ctx: AppContext,
  broker: CapabilityBroker,
  runtime: VNextRuntimeService,
): Promise<void> {
  for (const entry of entries.filter((plugin) => plugin.enabled)) {
    const manifest = validatedStoredManifest(entry);
    // rev4 §B2: grants revoked during safe mode are re-issued from the stored
    // consent so the frontend handshake sees the same set as the backend host.
    broker.grantConsented(entry.id, manifest, entry.grantedPermissions);
    // ТЗ §76: a host version change can invalidate an installed plugin —
    // skip activation and record the stable diagnostic instead of loading it.
    const engineMismatch = resolveEngineMismatch(manifest);
    if (engineMismatch) {
      ctx.database.repos.plugins.markError(entry.id, ErrorCodes.ENGINE_MISMATCH);
      ctx.events.emit('plugin.disabled', {
        pluginId: entry.id,
        reason: ErrorCodes.ENGINE_MISMATCH,
        ...engineMismatch.params,
      });
      continue;
    }
    try {
      await activatePluginBackends(
        manifest,
        join(ctx.paths.plugins, entry.id, 'package'),
        entry.grantedPermissions,
        backendHost,
        legacyHost,
        runtime,
      );
    } catch {
      ctx.database.repos.plugins.markError(entry.id, ErrorCodes.PLUGIN_LOAD_FAILED);
    }
  }
}

async function activatePluginBackends(
  manifest: PluginManifest,
  packageRoot: string,
  grantedPermissions: readonly string[],
  backendHost: BackendPluginHost,
  legacyHost: LegacyServerPluginHost,
  runtime: VNextRuntimeService,
): Promise<void> {
  // Compat-гейт (ADR-0027 §3): apiVersion 3 routes to the Node Universal
  // Runtime, which fully replaces `backendHost.ts` for v3 plugins. The
  // worker runs the signed module graph in a hardened SES Compartment with
  // no Node authority; capability calls are decided by the Main Host broker.
  if (manifest.apiVersion >= 3) {
    const entry = manifest.backend;
    if (!entry) {
      throw new AppError({
        code: ErrorCodes.PLUGIN_INVALID,
        params: { pluginId: manifest.id, reason: 'V3_BACKEND_REQUIRED' },
      });
    }
    await runtime.activate({
      pluginId: manifest.id,
      installationId: `${manifest.id}@${manifest.version}`,
      packageRoot,
      entry,
      trustLevel: 'sandbox',
    });
    return;
  }
  try {
    await backendHost.activate(manifest, packageRoot, grantedPermissions);
    await legacyHost.activate(manifest, packageRoot, grantedPermissions);
  } catch (error) {
    await Promise.all([backendHost.deactivate(manifest.id), legacyHost.deactivate(manifest.id)]);
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
