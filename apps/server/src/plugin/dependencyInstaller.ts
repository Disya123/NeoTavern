/**
 * Built-in npm dependency installer for plugins (ТЗ plugin install v1).
 *
 * The server never invokes npm and never executes package install scripts —
 * it downloads registry tarballs over HTTPS and extracts them into a flat
 * `node_modules` inside the plugin package (AGENTS.md §4, §21).
 *
 * Intended use: heavyweight WASM/ML libraries that are impractical to bundle.
 * Authors are strongly encouraged to bundle dependencies with esbuild/rollup
 * instead — see docs/plugin-sdk/README.md. On-the-fly resolution is a
 * convenience for those heavy WASM cases only.
 *
 * Security posture:
 * - registry metadata and tarballs are fetched over HTTPS only;
 * - tarballs are verified against the registry `sha512` integrity when present;
 * - native binaries and executables are rejected after extraction;
 * - install scripts and bin links are never executed or created.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { randomToken, AppError, ErrorCodes } from '@neotavern/shared';
import { extractTarGzArchive } from '../lib/tarballArchive.js';
import { downloadToFile, isForbiddenDestinationHost } from '../lib/httpDownload.js';
import { isValidRange, maxSatisfying } from './semver.js';

export const DEPENDENCY_MARKER_FILE = '.neotavern-deps.json';
export const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org';

/** Files that must never appear inside an installed dependency. */
const FORBIDDEN_FILE_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.node',
  '.bat',
  '.cmd',
  '.ps1',
  '.sh',
  '.msi',
  '.bin',
]);

const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
/** Specs that can never be resolved from a plain registry. */
const UNSUPPORTED_SPEC_PATTERN = /^(?:git\+|git:|file:|link:|workspace:|https?:|github:)/u;
/** Bare dist-tag such as `latest` or `next`. */
const DIST_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

export interface DependencyInstallerOptions {
  registryUrl?: string;
  cacheDir?: string;
  maxPackages?: number;
  maxExpandedBytes?: number;
  maxCacheBytes?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface ResolvedDependency {
  name: string;
  version: string;
  resolved: string;
  integrity: string;
}

interface QueueItem {
  name: string;
  range: string;
  requestedBy: string | null;
}

interface RegistryVersionMeta {
  name?: unknown;
  version?: unknown;
  dependencies?: Record<string, unknown>;
  dist?: { tarball?: unknown; integrity?: unknown };
}

interface RegistryPackument {
  name?: unknown;
  versions?: Record<string, RegistryVersionMeta>;
  'dist-tags'?: Record<string, unknown>;
}

function depsUnsupported(name: string, reason: string): AppError {
  return new AppError({
    code: ErrorCodes.PLUGIN_DEPS_UNSUPPORTED,
    params: { dependency: name, reason },
    message: `Unsupported plugin dependency "${name}": ${reason}`,
  });
}

function depsConflict(name: string, existing: string, requested: string): AppError {
  return new AppError({
    code: ErrorCodes.PLUGIN_DEPS_CONFLICT,
    params: { dependency: name, existingVersion: existing, requestedRange: requested },
    message:
      `Dependency conflict for "${name}": ${existing} is already selected and does not ` +
      `satisfy ${requested}. Bundle this dependency (esbuild/rollup) instead of relying ` +
      `on flat on-the-fly resolution.`,
  });
}

function depsFailed(name: string, reason: string, cause?: unknown): AppError {
  return new AppError({
    code: ErrorCodes.PLUGIN_DEPS_FAILED,
    params: { dependency: name, reason },
    message: `Plugin dependency "${name}" could not be installed: ${reason}`,
    cause,
  });
}

function depsForbidden(name: string, file: string): AppError {
  return new AppError({
    code: ErrorCodes.PLUGIN_DEPS_FORBIDDEN_FILE,
    params: { dependency: name, file },
    message: `Plugin dependency "${name}" contains a forbidden file: ${file}`,
  });
}

function assertPackageName(name: string): void {
  if (!PACKAGE_NAME_PATTERN.test(name)) {
    throw depsUnsupported(name, 'invalid package name');
  }
}

/**
 * Validate the plugin's own dependency map before any network access.
 * Accepts semver ranges and bare dist-tags; rejects git/file/url/workspace
 * specs that a registry cannot serve.
 */
export function readPluginDependencySpecs(
  packageJson: Record<string, unknown>,
): Map<string, string> {
  const raw = packageJson['dependencies'];
  const specs = new Map<string, string>();
  if (raw === undefined || raw === null) return specs;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw depsUnsupported('(package.json)', 'dependencies must be an object');
  }
  for (const [name, version] of Object.entries(raw as Record<string, unknown>)) {
    assertPackageName(name);
    if (typeof version !== 'string' || version.length === 0 || version.length > 200) {
      throw depsUnsupported(name, 'version spec must be a non-empty string');
    }
    if (UNSUPPORTED_SPEC_PATTERN.test(version)) {
      throw depsUnsupported(name, 'git/file/link/workspace/url specs are not supported');
    }
    const isRange = isValidRange(version);
    const isDistTag = DIST_TAG_PATTERN.test(version);
    if (!isRange && !isDistTag) {
      throw depsUnsupported(name, `version spec "${version}" is not a supported range or tag`);
    }
    specs.set(name, version);
  }
  return specs;
}

/**
 * Resolve the full dependency graph (BFS) and install every package into
 * `<packageRoot>/node_modules` (flat hoisting). Writes the
 * `.neotavern-deps.json` marker used by the loader boundary and returns the
 * resolved records for storage in the plugin registry.
 */
export async function installPluginDependencies(
  packageRoot: string,
  specs: ReadonlyMap<string, string>,
  options: DependencyInstallerOptions = {},
): Promise<ResolvedDependency[]> {
  if (specs.size === 0) return [];

  const registryUrl = (options.registryUrl ?? DEFAULT_REGISTRY_URL).replace(/\/+$/u, '');
  const maxPackages = options.maxPackages ?? 300;
  const maxExpandedBytes = options.maxExpandedBytes ?? 200 * 1024 * 1024;
  const fetchImpl = options.fetchImpl ?? fetch;
  const cacheDir = options.cacheDir ?? null;

  // SEC-03: the registry endpoint is operator-configured (trusted), but it
  // must still be HTTPS — a plaintext registry would let a network attacker
  // rewrite packuments and tarball URLs (supply-chain MITM).
  const registryHost = validateRegistryUrl(registryUrl);

  const stagingRoot = join(packageRoot, `.deps-staging-${randomToken(10)}`);
  const stagingModules = join(stagingRoot, 'node_modules');
  const scratch = join(stagingRoot, 'scratch');
  const finalModules = join(packageRoot, 'node_modules');

  const selected = new Map<string, ResolvedDependency>();
  let expandedBytes = 0;

  const queue: QueueItem[] = [...specs.entries()].map(([name, range]) => ({
    name,
    range,
    requestedBy: null,
  }));

  try {
    await mkdir(stagingModules, { recursive: true });
    await mkdir(scratch, { recursive: true });

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      assertPackageName(item.name);

      const existing = selected.get(item.name);
      if (existing) {
        // Flat hoisting: the already-selected version must also satisfy the
        // new request, otherwise nested node_modules would be required.
        if (!versionSatisfies(existing.version, item.range)) {
          throw depsConflict(item.name, existing.version, item.range);
        }
        continue;
      }
      if (selected.size >= maxPackages) {
        throw depsFailed(item.name, 'too many packages in the dependency graph');
      }

      const record = await resolveAndInstall(
        item,
        registryUrl,
        registryHost,
        stagingModules,
        scratch,
        cacheDir,
        options,
        fetchImpl,
      );
      expandedBytes += record.expandedBytes;
      if (expandedBytes > maxExpandedBytes) {
        throw depsFailed(item.name, 'expanded size limit exceeded');
      }
      selected.set(item.name, record.dependency);
      for (const [depName, depSpec] of Object.entries(record.dependencies)) {
        queue.push({ name: depName, range: depSpec, requestedBy: item.name });
      }
    }

    const records = [...selected.values()].sort((a, b) => a.name.localeCompare(b.name));
    const markerPath = join(stagingModules, DEPENDENCY_MARKER_FILE);
    await writeFileAtomic(
      markerPath,
      `${JSON.stringify(
        {
          version: 1,
          registry: registryUrl,
          dependencies: records,
        },
        null,
        2,
      )}\n`,
    );

    if (await exists(finalModules)) {
      await rm(finalModules, { recursive: true, force: true });
    }
    await rename(stagingModules, finalModules);
    return records;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function versionSatisfies(version: string, range: string): boolean {
  // A previously-selected version satisfies a dist-tag request only if it is
  // exactly re-resolvable; conservatively treat tags as "accept any selected".
  if (!isValidRange(range)) return DIST_TAG_PATTERN.test(range);
  return maxSatisfying([version], range) !== null;
}

/**
 * SEC-03: the registry endpoint must be HTTPS — a plaintext registry would
 * let a network attacker rewrite packuments and tarball URLs (supply-chain
 * MITM). Returns the registry hostname, the trust anchor for tarball URLs.
 */
function validateRegistryUrl(registryUrl: string): string {
  let url: URL;
  try {
    url = new URL(registryUrl);
  } catch {
    throw depsFailed('(registry)', 'registry URL is not a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw depsFailed('(registry)', 'registry URL must use https:');
  }
  if (url.hostname.length === 0) {
    throw depsFailed('(registry)', 'registry URL is missing a host');
  }
  return url.hostname.toLowerCase();
}

interface InstallOutcome {
  dependency: ResolvedDependency;
  dependencies: Record<string, string>;
  expandedBytes: number;
}

async function resolveAndInstall(
  item: QueueItem,
  registryUrl: string,
  registryHost: string,
  stagingModules: string,
  scratch: string,
  cacheDir: string | null,
  options: DependencyInstallerOptions,
  fetchImpl: typeof fetch,
): Promise<InstallOutcome> {
  const packument = await fetchPackument(item.name, registryUrl, fetchImpl, options.signal);
  const versions = packument?.versions;
  if (!versions || typeof versions !== 'object') {
    throw depsFailed(item.name, 'registry response is missing versions');
  }

  const chosen = chooseVersion(item, packument, versions);
  const versionMeta = versions[chosen];
  const tarballUrl = versionMeta?.dist?.tarball;
  if (typeof tarballUrl !== 'string' || !tarballUrl.startsWith('https://')) {
    throw depsFailed(item.name, `version ${chosen} is missing an https tarball`);
  }
  const registryIntegrity =
    typeof versionMeta?.dist?.integrity === 'string' ? versionMeta.dist.integrity : '';

  const tarballPath = await obtainTarball(
    tarballUrl,
    registryIntegrity,
    item.name,
    scratch,
    cacheDir,
    registryHost,
    options,
    fetchImpl,
  );

  // Registry tarballs wrap content in a single top-level directory (`package/`).
  const rawDir = join(scratch, `extract-${randomToken(8)}`);
  try {
    await extractTarGzArchive(
      tarballPath,
      rawDir,
      {
        maxArchiveBytes: 64 * 1024 * 1024,
        maxEntries: 20_000,
        maxEntryBytes: 64 * 1024 * 1024,
        maxExpandedBytes: 128 * 1024 * 1024,
      },
      options.signal,
    );
    const packageDir = await findSinglePackageRoot(rawDir, item.name);
    await rejectForbiddenFiles(packageDir, item.name);
    const expandedBytes = await directoryBytes(packageDir);

    const destination = resolve(stagingModules, ...item.name.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await rename(packageDir, destination);

    const dependencies = extractStringMap(versionMeta?.dependencies);
    const sha512 = await hashFile(tarballPath, 'sha512');
    return {
      dependency: {
        name: item.name,
        version: chosen,
        resolved: tarballUrl,
        integrity: registryIntegrity || `sha512-${sha512}`,
      },
      dependencies,
      expandedBytes,
    };
  } finally {
    await rm(rawDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(tarballPath, { force: true }).catch(() => undefined);
  }
}

function chooseVersion(
  item: QueueItem,
  packument: RegistryPackument,
  versions: Record<string, RegistryVersionMeta>,
): string {
  const versionList = Object.keys(versions);
  if (isValidRange(item.range)) {
    const chosen = maxSatisfying(versionList, item.range);
    if (!chosen) {
      throw depsFailed(item.name, `no registry version satisfies "${item.range}"`);
    }
    return chosen;
  }
  // Bare dist-tag (validated earlier).
  const tagged = packument['dist-tags']?.[item.range];
  if (typeof tagged === 'string' && versions[tagged]) return tagged;
  throw depsFailed(item.name, `dist-tag "${item.range}" is not published`);
}

async function fetchPackument(
  name: string,
  registryUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<RegistryPackument> {
  const encoded = name.startsWith('@')
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);
  const url = `${registryUrl}/${encoded}`;
  const combined = combineSignal(signal);
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: combined, redirect: 'follow' });
  } catch (cause) {
    if (combined.aborted) throw new AppError({ code: ErrorCodes.ABORTED });
    throw depsFailed(name, 'registry request failed', cause);
  }
  if (!response.ok) {
    throw depsFailed(name, `registry responded with status ${response.status}`);
  }
  const text = await response.text();
  if (text.length > 32 * 1024 * 1024) {
    throw depsFailed(name, 'registry response is too large');
  }
  try {
    return JSON.parse(text) as RegistryPackument;
  } catch (cause) {
    throw depsFailed(name, 'registry response is not valid JSON', cause);
  }
}

/** Download the tarball (with cache) and verify its integrity. */
async function obtainTarball(
  tarballUrl: string,
  registryIntegrity: string,
  name: string,
  scratch: string,
  cacheDir: string | null,
  registryHost: string,
  options: DependencyInstallerOptions,
  fetchImpl: typeof fetch,
): Promise<string> {
  const tarballPath = join(scratch, `${randomToken(12)}.tgz`);
  const maxBytes = 64 * 1024 * 1024;

  // SEC-03: the tarball URL comes from registry data (untrusted), so it is
  // validated against the same download policy as the hop itself. Hosts on
  // the configured registry are operator-trusted (self-hosted registries may
  // live on private or local addresses); every other host must be HTTPS and
  // outside the always-forbidden ranges (loopback, link-local, multicast).
  let parsedTarball: URL;
  try {
    parsedTarball = new URL(tarballUrl);
  } catch {
    throw depsFailed(name, 'registry returned a malformed tarball URL');
  }
  if (parsedTarball.protocol !== 'https:') {
    throw depsFailed(name, 'tarball URL must use https:');
  }
  if (
    parsedTarball.hostname.toLowerCase() !== registryHost &&
    isForbiddenDestinationHost(parsedTarball.hostname)
  ) {
    throw depsFailed(name, 'tarball URL targets a forbidden destination');
  }

  // Cache key: registry integrity hash when available, else the tarball URL.
  const cacheKey = cacheKeyFor(tarballUrl, registryIntegrity);
  const cachedPath = cacheDir && cacheKey ? join(cacheDir, `${cacheKey}.tgz`) : null;

  if (cachedPath && (await exists(cachedPath))) {
    await copyFile(cachedPath, tarballPath);
  } else {
    await downloadToFile(
      tarballUrl,
      tarballPath,
      {
        maxBytes,
        signal: options.signal,
        fetchImpl,
        // Redirects are re-validated per hop; the registry host stays trusted.
        trustedHop: (url) => url.hostname.toLowerCase() === registryHost,
      },
      (reason, cause) => depsFailed(name, `tarball download failed (${reason})`, cause),
    );
    if (cachedPath && cacheDir) {
      await mkdir(cacheDir, { recursive: true });
      await enforceCacheCap(cacheDir, options.maxCacheBytes ?? 512 * 1024 * 1024);
      await copyFile(tarballPath, cachedPath).catch(() => undefined);
    }
  }

  if (registryIntegrity) {
    await verifyIntegrity(tarballPath, registryIntegrity, name);
  }
  return tarballPath;
}

function cacheKeyFor(tarballUrl: string, integrity: string): string | null {
  const sha512 = /^sha512-([A-Za-z0-9+/=]+)$/u.exec(integrity)?.[1];
  if (sha512) return sha512.replace(/[/+=]/gu, '_');
  const sha256 = /^sha256-([A-Za-z0-9+/=]+)$/u.exec(integrity)?.[1];
  if (sha256) return sha256.replace(/[/+=]/gu, '_');
  try {
    return createHash('sha256').update(tarballUrl).digest('hex');
  } catch {
    return null;
  }
}

async function verifyIntegrity(path: string, integrity: string, name: string): Promise<void> {
  const match = /^sha(256|512)-([A-Za-z0-9+/=]+)$/u.exec(integrity);
  if (!match) {
    throw depsFailed(name, `unsupported integrity algorithm in "${integrity.slice(0, 40)}"`);
  }
  const algorithm = `sha${match[1]}`;
  const expected = match[2];
  const actual = await hashFile(path, algorithm as 'sha256' | 'sha512');
  if (actual !== expected) {
    throw depsFailed(name, 'tarball integrity check failed (hash mismatch)');
  }
}

async function hashFile(path: string, algorithm: 'sha256' | 'sha512'): Promise<string> {
  const handle = await open(path, 'r');
  const hash = createHash(algorithm);
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('base64');
}

async function findSinglePackageRoot(rawDir: string, name: string): Promise<string> {
  const entries = await readdir(rawDir, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  const files = entries.filter((entry) => entry.isFile());
  if (directories.length === 1 && files.length === 0) {
    return join(rawDir, directories[0]?.name ?? '');
  }
  // Some tarballs put files at the root; accept that too.
  if (directories.length === 0 && files.length > 0) return rawDir;
  throw depsFailed(name, 'tarball does not contain a single package root');
}

async function rejectForbiddenFiles(root: string, name: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw depsForbidden(name, `${entry.name} (symbolic link)`);
    }
    if (entry.isDirectory()) {
      await rejectForbiddenFiles(path, name);
    } else if (entry.isFile() && FORBIDDEN_FILE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      throw depsForbidden(name, entry.name);
    }
  }
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
}

/** Keep the tarball cache bounded by deleting the oldest entries first. */
async function enforceCacheCap(cacheDir: string, maxBytes: number): Promise<void> {
  let entries: Array<{ path: string; mtimeMs: number; size: number }>;
  try {
    const dirents = await readdir(cacheDir, { withFileTypes: true });
    entries = [];
    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.endsWith('.tgz')) continue;
      const path = join(cacheDir, dirent.name);
      const info = await stat(path).catch(() => null);
      if (info) entries.push({ path, mtimeMs: info.mtimeMs, size: info.size });
    }
  } catch {
    return;
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= maxBytes) return;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries) {
    if (total <= maxBytes) break;
    await rm(entry.path, { force: true }).catch(() => undefined);
    total -= entry.size;
  }
}

function extractStringMap(raw: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0 && value.length <= 200) {
      result[key] = value;
    }
  }
  return result;
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.partial-${randomToken(8)}`;
  try {
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function combineSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(60_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
