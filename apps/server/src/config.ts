/**
 * Server configuration loaded from environment variables. Sensible local-first
 * defaults: binds 127.0.0.1 only (ТЗ §13), data under ./data.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import {
  PluginResourceConfigFileSchema,
  type PluginResourceConfigFile,
  type PluginResourcePluginsConfig,
  type PluginResourceProfileName,
  type PluginResourceServerConfig,
} from '@neotavern/contracts';
import { DEFAULT_PROVIDER_TIMEOUTS, type ProviderTimeouts } from '@neotavern/provider-sdk';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_REGISTRY_URL } from './plugin/dependencyInstaller.js';

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  /** Directory with the built web app to serve statically (null = API only). */
  webDir: string | null;
  logLevel: string;
  /** Allowed CORS origin for the dev web server. */
  corsOrigin: string;
  /** Explicit opt-in for access beyond loopback. */
  remoteAccess: boolean;
  /** Trusted browser origin used for Origin/CSRF checks. */
  publicOrigin: string;
  /** SHA-256 of the bootstrap access token; plaintext is discarded. */
  remoteTokenHash: string | null;
  /** Whether the browser session cookie carries the Secure attribute. */
  secureSessionCookies: boolean;
  /** Disable all third-party plugin activation for recovery startup. */
  safeMode: boolean;
  /**
   * Allow revealing stored provider secret values via the API. Off by default;
   * mirrors SillyTavern's `allowKeysExposure`. Secrets stay write-only unless
   * this is explicitly enabled (AGENTS.md §4).
   */
  allowSecretsExposure: boolean;
  /** Node 24 executable used for process-isolated backend plugins. */
  pluginNodePath: string | null;
  /** External worker bridge path for packaged desktop builds. */
  pluginWorkerPath: string | null;
  /** ESM resolver boundary used by process-isolated backend plugins. */
  pluginLoaderPath: string | null;
  /** Allow installing plugins from a Git repository URL. */
  pluginGitInstall: boolean;
  /** npm registry base URL used by the built-in dependency installer. */
  pluginRegistryUrl: string;
  /** Maximum number of packages the dependency installer may resolve. */
  pluginDepsMaxPackages: number;
  /** Maximum expanded bytes across all installed plugin dependencies. */
  pluginDepsMaxBytes: number;
  /** Resource governance profile (ТЗ Plugin SDK vNext §20). */
  resources: PluginResourceConfig;
  /** Headless policy file path (NEOTA_PLUGIN_POLICY_FILE, consumed in stage C). */
  pluginPolicyFile: string | null;
  /** Global trusted-native switch; false for remote/public instances. */
  pluginTrustedNative: boolean;
  /** Deadlines enforced by provider adapters (ТЗ §4.3). */
  providerTimeouts: ProviderTimeouts;
}

/**
 * Resource budgets for the process tree and plugin runtimes (ТЗ §20).
 * All memory values are MiB. `profile` selects the default preset; every
 * number can be overridden via the config file or `NEOTA_*` env aliases.
 */
export interface PluginResourceConfig {
  profile: PluginResourceProfileName;
  server: Required<PluginResourceServerConfig>;
  plugins: Required<PluginResourcePluginsConfig>;
  database: {
    cacheMiB: number;
    maintenancePriority: 'background' | 'interactive';
  };
}

/**
 * Reference preset for 3 GiB RAM / 2 vCPU (ТЗ §4, §8.1, §20). `low-vps-3gb`
 * is the default profile. All memory values are MiB.
 */
const LOW_VPS_3GB_PRESET: Omit<PluginResourceConfig, 'profile'> = {
  server: {
    nodeHeapMiB: 512,
    processTreeRssSoftMiB: 2048,
    processTreeRssHardMiB: 2432,
    // ТЗ §23.2 SLO B01 caps the idle process tree at 500 MiB p95; the main
    // server is the whole tree when no plugin runs, so the target is 450 MiB.
    mainRssTargetMiB: 450,
    mainRssHardMiB: 640,
  },
  plugins: {
    maxActiveBackends: 5,
    maxWarmBackends: 2,
    defaultIdleTimeoutSec: 90,
    aggregateRssSoftMiB: 1152,
    aggregateRssHardMiB: 1536,
    defaultProcessHeapMiB: 96,
    defaultProcessRssSoftMiB: 128,
    defaultProcessRssHardMiB: 192,
    cpuHeavyConcurrency: 1,
    backgroundCpuPercent: 100,
    networkGlobalConcurrency: 12,
    networkPerPluginConcurrency: 3,
    serviceGlobalConcurrency: 12,
    servicePerPluginConcurrency: 3,
    serviceInFlightMiBPerPlugin: 4,
    jobsGlobalConcurrency: 2,
    jobsPerPluginConcurrency: 1,
    eventReplayBytesMiB: 16,
    eventReplayBytesPerNameMiB: 4,
    ipcInFlightBytesMiB: 32,
    ipcInFlightBytesPerPluginMiB: 4,
    installConcurrency: 1,
    dependencyUnpackedMiBPerPlugin: 96,
  },
  database: { cacheMiB: 64, maintenancePriority: 'background' },
};

/**
 * Frozen compatibility preset for existing 2 GiB installs (ТЗ MIG-05):
 * upgrading the core must not silently grant 3 GiB budgets. An explicit
 * `low-vps-2gb` (or the legacy alias `low-vps`) keeps these numbers.
 */
const LOW_VPS_2GB_PRESET: Omit<PluginResourceConfig, 'profile'> = {
  server: {
    nodeHeapMiB: 384,
    processTreeRssSoftMiB: 1280,
    processTreeRssHardMiB: 1536,
    mainRssTargetMiB: 450,
    mainRssHardMiB: 640,
  },
  plugins: {
    maxActiveBackends: 3,
    maxWarmBackends: 1,
    defaultIdleTimeoutSec: 60,
    aggregateRssSoftMiB: 640,
    aggregateRssHardMiB: 896,
    defaultProcessHeapMiB: 64,
    defaultProcessRssSoftMiB: 96,
    defaultProcessRssHardMiB: 160,
    cpuHeavyConcurrency: 1,
    backgroundCpuPercent: 100,
    networkGlobalConcurrency: 8,
    networkPerPluginConcurrency: 2,
    serviceGlobalConcurrency: 8,
    servicePerPluginConcurrency: 2,
    serviceInFlightMiBPerPlugin: 4,
    jobsGlobalConcurrency: 1,
    jobsPerPluginConcurrency: 1,
    eventReplayBytesMiB: 8,
    eventReplayBytesPerNameMiB: 2,
    ipcInFlightBytesMiB: 16,
    ipcInFlightBytesPerPluginMiB: 2,
    installConcurrency: 1,
    dependencyUnpackedMiBPerPlugin: 64,
  },
  database: { cacheMiB: 32, maintenancePriority: 'background' },
};

/** Loose preset for capable machines: no hard plugin tree limits. */
const STANDARD_PRESET: Omit<PluginResourceConfig, 'profile'> = {
  server: {
    nodeHeapMiB: 1024,
    processTreeRssSoftMiB: 4096,
    processTreeRssHardMiB: 6144,
    mainRssTargetMiB: 900,
    mainRssHardMiB: 1536,
  },
  plugins: {
    maxActiveBackends: 8,
    maxWarmBackends: 2,
    defaultIdleTimeoutSec: 60,
    aggregateRssSoftMiB: 2048,
    aggregateRssHardMiB: 3072,
    defaultProcessHeapMiB: 128,
    defaultProcessRssSoftMiB: 256,
    defaultProcessRssHardMiB: 512,
    cpuHeavyConcurrency: 2,
    backgroundCpuPercent: 200,
    networkGlobalConcurrency: 32,
    networkPerPluginConcurrency: 8,
    serviceGlobalConcurrency: 32,
    servicePerPluginConcurrency: 8,
    serviceInFlightMiBPerPlugin: 8,
    jobsGlobalConcurrency: 4,
    jobsPerPluginConcurrency: 2,
    eventReplayBytesMiB: 32,
    eventReplayBytesPerNameMiB: 8,
    ipcInFlightBytesMiB: 64,
    ipcInFlightBytesPerPluginMiB: 8,
    installConcurrency: 2,
    dependencyUnpackedMiBPerPlugin: 256,
  },
  database: { cacheMiB: 64, maintenancePriority: 'background' },
};

/**
 * Profile presets. `custom` keeps every server-provided default (based on
 * the 3 GiB reference) and lets the config file override them one by one.
 */
function presetFor(profile: PluginResourceProfileName): Omit<PluginResourceConfig, 'profile'> {
  if (profile === 'standard') return STANDARD_PRESET;
  if (profile === 'low-vps-2gb') return LOW_VPS_2GB_PRESET;
  return LOW_VPS_3GB_PRESET;
}

/**
 * Reference resource config for contexts that do not carry one (partial-
 * context tests, embedded hosts): the default `low-vps-3gb` profile.
 */
export const DEFAULT_RESOURCE_CONFIG: PluginResourceConfig = {
  profile: 'low-vps-3gb',
  ...LOW_VPS_3GB_PRESET,
};

/**
 * Normalize a profile name from `NEOTA_RESOURCE_PROFILE` or the config file.
 * The legacy v1.0 name `low-vps` maps to `low-vps-2gb` (MIG-05): existing
 * installs keep their budgets instead of silently receiving 3 GiB ones.
 * Unknown names fail loudly — profiles are explicit.
 */
function normalizeProfileName(value: string): PluginResourceProfileName {
  const name = value.trim();
  if (
    name === 'low-vps-3gb' ||
    name === 'low-vps-2gb' ||
    name === 'standard' ||
    name === 'custom'
  ) {
    return name;
  }
  if (name === 'low-vps') return 'low-vps-2gb';
  throw new Error(
    `Unknown NEOTA_RESOURCE_PROFILE '${name}' (expected low-vps-3gb, low-vps-2gb, standard or custom)`,
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const cwd = process.cwd();
  const host = env['NEOTA_HOST'] ?? '127.0.0.1';
  const port = Number.parseInt(env['NEOTA_PORT'] ?? '8000', 10);
  const webDir = env['NEOTA_WEB_DIR'] ?? null;
  // CORS allowlist default follows the deployment mode. In single-process
  // mode (NEOTA_WEB_DIR) the built SPA is served by this same server, and Vite
  // emits `<script type="module" crossorigin>` tags whose CORS-mode fetches
  // carry an Origin header even on same-origin requests — the server's own
  // origin must be trusted or every asset request 500s. In dev mode the
  // browser origin is the Vite dev server instead.
  const ownOrigin = `http://${isLoopbackHost(host) ? '127.0.0.1' : host}:${port}`;
  const corsOrigin = env['NEOTA_CORS_ORIGIN'] ?? (webDir ? ownOrigin : 'http://127.0.0.1:5173');
  const remoteAccess = env['NEOTA_REMOTE_ACCESS'] === 'true';
  let publicOrigin = env['NEOTA_PUBLIC_ORIGIN'] ?? corsOrigin;
  const insecureRemoteHttp = env['NEOTA_REMOTE_ALLOW_INSECURE_HTTP'] === 'true';

  if (!isLoopbackHost(host) && !remoteAccess) {
    throw new Error('Refusing to bind outside loopback without NEOTA_REMOTE_ACCESS=true');
  }

  const resources = loadResourceConfig(env);

  let remoteTokenHash: string | null = null;
  let secureSessionCookies = false;
  if (remoteAccess) {
    const token = env['NEOTA_REMOTE_TOKEN'];
    if (!token || token.length < 32) {
      throw new Error('NEOTA_REMOTE_TOKEN must contain at least 32 characters in remote mode');
    }
    const origin = parseOrigin(publicOrigin);
    publicOrigin = origin.origin;
    if (parseOrigin(corsOrigin).origin !== publicOrigin) {
      throw new Error('NEOTA_CORS_ORIGIN must match NEOTA_PUBLIC_ORIGIN in remote mode');
    }
    secureSessionCookies = origin.protocol === 'https:';
    if (!secureSessionCookies && !insecureRemoteHttp) {
      throw new Error(
        'Remote mode requires an HTTPS NEOTA_PUBLIC_ORIGIN; use NEOTA_REMOTE_ALLOW_INSECURE_HTTP=true only on a trusted test network',
      );
    }
    remoteTokenHash = createHash('sha256').update(token).digest('hex');
  }

  return {
    // Default to loopback only — LAN/remote access must be enabled explicitly.
    host,
    port,
    dataDir: env['NEOTA_DATA_DIR'] ?? resolve(cwd, 'data'),
    webDir,
    logLevel: env['NEOTA_LOG_LEVEL'] ?? 'info',
    corsOrigin,
    remoteAccess,
    publicOrigin,
    remoteTokenHash,
    secureSessionCookies,
    safeMode: env['NEOTA_SAFE_MODE'] === 'true',
    allowSecretsExposure: env['NEOTA_ALLOW_SECRETS_EXPOSURE'] === 'true',
    pluginNodePath:
      env['NEOTA_PLUGIN_NODE'] ??
      (env['PKG_EXECPATH'] || process.env['PKG_EXECPATH'] ? null : process.execPath),
    pluginWorkerPath: env['NEOTA_PLUGIN_WORKER'] ?? null,
    pluginLoaderPath: env['NEOTA_PLUGIN_LOADER'] ?? null,
    pluginGitInstall: env['NEOTA_PLUGIN_GIT_INSTALL'] !== 'false',
    pluginRegistryUrl: (env['NEOTA_PLUGIN_REGISTRY'] ?? DEFAULT_REGISTRY_URL).replace(/\/+$/u, ''),
    pluginDepsMaxPackages: positiveIntEnv(env['NEOTA_PLUGIN_DEPS_MAX_PACKAGES'], 300),
    pluginDepsMaxBytes: positiveIntEnv(env['NEOTA_PLUGIN_DEPS_MAX_BYTES'], 200 * 1024 * 1024),
    resources,
    pluginPolicyFile: env['NEOTA_PLUGIN_POLICY_FILE'] ?? null,
    pluginTrustedNative: env['NEOTA_PLUGIN_TRUSTED_NATIVE'] === 'true',
    providerTimeouts: {
      connectMs: positiveIntEnv(
        env['NEOTA_PROVIDER_CONNECT_TIMEOUT_MS'],
        DEFAULT_PROVIDER_TIMEOUTS.connectMs,
      ),
      idleMs: positiveIntEnv(env['NEOTA_PROVIDER_IDLE_TIMEOUT_MS'], DEFAULT_PROVIDER_TIMEOUTS.idleMs),
      readMs: positiveIntEnv(env['NEOTA_PROVIDER_READ_TIMEOUT_MS'], DEFAULT_PROVIDER_TIMEOUTS.readMs),
    },
  };
}

function positiveIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Assemble the resource profile (ТЗ §20): preset for the named profile,
 * overlaid by the optional YAML/JSON config file (`NEOTA_CONFIG_FILE`), then by
 * `NEOTA_*` env aliases (§20.1). The config file is admin-owned and outside the
 * plugin packages, so it survives core updates.
 */
function loadResourceConfig(env: NodeJS.ProcessEnv): PluginResourceConfig {
  const file = readResourceConfigFile(env['NEOTA_CONFIG_FILE']);
  const requestedProfile = env['NEOTA_RESOURCE_PROFILE'] ?? file?.resourceProfile ?? 'low-vps-3gb';
  const profile = normalizeProfileName(requestedProfile);
  const base = presetFor(profile);
  const resources: PluginResourceConfig = {
    profile,
    server: { ...base.server, ...file?.server },
    plugins: { ...base.plugins, ...file?.plugins },
    database: {
      cacheMiB: file?.database?.cacheMiB ?? base.database.cacheMiB,
      maintenancePriority: file?.database?.maintenancePriority ?? base.database.maintenancePriority,
    },
  };
  // ТЗ §20.1 environment aliases win over the config file.
  resources.server.processTreeRssHardMiB = positiveIntEnv(
    env['NEOTA_MEMORY_BUDGET_MB'],
    resources.server.processTreeRssHardMiB,
  );
  resources.plugins.maxActiveBackends = positiveIntEnv(
    env['NEOTA_PLUGIN_MAX_ACTIVE_BACKENDS'],
    resources.plugins.maxActiveBackends,
  );
  resources.plugins.defaultProcessHeapMiB = positiveIntEnv(
    env['NEOTA_PLUGIN_DEFAULT_HEAP_MB'],
    resources.plugins.defaultProcessHeapMiB,
  );
  resources.plugins.defaultProcessRssHardMiB = positiveIntEnv(
    env['NEOTA_PLUGIN_DEFAULT_RSS_HARD_MB'],
    resources.plugins.defaultProcessRssHardMiB,
  );
  resources.plugins.cpuHeavyConcurrency = positiveIntEnv(
    env['NEOTA_PLUGIN_CPU_HEAVY_CONCURRENCY'],
    resources.plugins.cpuHeavyConcurrency,
  );
  return resources;
}

function readResourceConfigFile(path: string | undefined): PluginResourceConfigFile | null {
  if (!path || path.trim().length === 0) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`NEOTA_CONFIG_FILE is not readable: ${path}`, { cause });
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (cause) {
    throw new Error(`NEOTA_CONFIG_FILE is not valid YAML: ${path}`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`NEOTA_CONFIG_FILE must contain an object: ${path}`);
  }
  // The legacy v1.0 profile name is normalized before schema validation so
  // existing configs keep working (MIG-05): `low-vps` === `low-vps-2gb`.
  const record = parsed as Record<string, unknown>;
  if (record['resourceProfile'] === 'low-vps') {
    record['resourceProfile'] = 'low-vps-2gb';
  }
  // TypeBox Parse() itself ignores unknown fields, so additionalProperties
  // constraints must be checked explicitly (Value.Check) before parsing.
  if (!Value.Check(PluginResourceConfigFileSchema, parsed)) {
    throw new Error(`NEOTA_CONFIG_FILE failed schema validation: ${path}`);
  }
  try {
    return Value.Parse(PluginResourceConfigFileSchema, parsed);
  } catch (cause) {
    throw new Error(`NEOTA_CONFIG_FILE failed schema validation: ${path}`, { cause });
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized.startsWith('127.')
  );
}

function parseOrigin(value: string): URL {
  const url = new URL(value);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('NEOTA_PUBLIC_ORIGIN must be an HTTP(S) origin without path or credentials');
  }
  return url;
}
