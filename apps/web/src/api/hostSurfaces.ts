/**
 * Explicit host-surface boundary for the plugin host (ADR-0038 host/HTTP
 * contour, cutover registry rows 19/20/21a).
 *
 * The Product Wire is canonical for product DATA. The plugin *host* is a
 * different plane: it is the trusted process that owns package verification
 * (SEC-05 signature + ZIP hardening), OAuth secrets, the sandbox session and the
 * job scheduler. Those are not product records, they are host capabilities —
 * so this module is the single, auditable place where the web contour talks to
 * them, and {@link HOST_SURFACES} states for every surface WHY it lives here
 * and WHAT stage 6 must replace it with.
 *
 * Kernel mode rule (ARC-02): every surface below is `unsupported` on the kernel
 * plane until its host capability exists, and each function therefore fails
 * with a typed `UnsupportedError` carrying the registry id — never a silent
 * request to a dead legacy route. The registry is the reason that rule cannot
 * drift: the error code and the declared surface are the same string.
 */
import {
  type PluginAuthConnectRequest,
  type PluginAuthConnectResult,
  type PluginAuthConnectionsResponse,
  type PluginAuthRevokeRequest,
  type PluginAuthRevokeResult,
  type PluginGitInstallRequest,
  type PluginInstallResult,
  type PluginSafeModeResult,
} from '@neotavern/contracts';
import { installPackage } from '../plugins/bundleClient.js';
import { UnsupportedError } from '@neotavern/neobackend';
import { api, legacyUrl } from './client.js';
import { isKernelMode } from './backend.js';

/**
 * One host-owned capability the web contour needs but Product Wire does not
 * (and must not) model.
 *
 * `kernelMode` is deliberately a single literal: as of the boundary extraction
 * no host surface has a kernel implementation, so every one of them must be
 * fail-closed. Widening it requires an actual host capability, which also means
 * updating the cutover registry row that consumes this surface.
 */
export interface HostSurface {
  /** Stable id — doubles as the `UnsupportedError` code. */
  readonly id:
    | 'plugins.safe-mode.enter'
    | 'plugins.safe-mode.exit'
    | 'plugins.auth.connections'
    | 'plugins.auth.connect'
    | 'plugins.auth.revoke'
    | 'plugins.auth.sandbox-session'
    | 'plugins.auth.fetch-proxy';
  /** Legacy route template (the sidecar side of the boundary). */
  readonly route: string;
  readonly method: 'GET' | 'POST' | 'DELETE';
  /** Always `unsupported` today: no host capability exists on the kernel plane. */
  readonly kernelMode: 'unsupported';
  /** Why this is host state rather than a product record. */
  readonly why: string;
  /** What stage 6 has to provide so the boundary disappears. */
  readonly removal: string;
}

/**
 * The complete, exhaustive list of plugin host surfaces reachable from the web
 * contour. Adding a call to a legacy plugin route anywhere else is a boundary
 * violation; the accompanying test keeps this table and the functions in sync.
 */
export const HOST_SURFACES: readonly HostSurface[] = [
  {
    id: 'plugins.safe-mode.enter',
    route: '/plugins/runtime/safe-mode',
    method: 'POST',
    kernelMode: 'unsupported',
    why:
      'Safe mode toggles the live plugin runtime (worker pool + sandbox frames). The kernel owns data, not ' +
      'the execution plane, so it has no such switch.',
    removal:
      'The kernel-mode plugin executor owns safe mode; the UI then calls its host command instead.',
  },
  {
    id: 'plugins.safe-mode.exit',
    route: '/plugins/runtime/safe-mode',
    method: 'DELETE',
    kernelMode: 'unsupported',
    why: 'Same switch as `plugins.safe-mode.enter` (exit path).',
    removal: 'Same executor-owned switch.',
  },
  {
    id: 'plugins.auth.connections',
    route: '/plugins/:id/auth/connections',
    method: 'GET',
    kernelMode: 'unsupported',
    why:
      'OAuth tokens are held by the host secret store and never leave it; the sandbox only sees metadata. ' +
      'Product Wire models plugin state and secrets, not third-party connection sessions.',
    removal:
      'Give the executor an auth-connection store behind the host adapter and surface metadata-only reads ' +
      'through it.',
  },
  {
    id: 'plugins.auth.connect',
    route: '/plugins/:id/auth/connect',
    method: 'POST',
    kernelMode: 'unsupported',
    why: 'Starts a browser OAuth flow whose redirect is a host endpoint (state/PKCE live on the host).',
    removal: 'The executor owns the flow; the UI only renders the returned authorization URL.',
  },
  {
    id: 'plugins.auth.revoke',
    route: '/plugins/:id/auth/revoke',
    method: 'POST',
    kernelMode: 'unsupported',
    why: 'Revocation must delete the host-held token; the kernel never has a copy.',
    removal: 'Same executor-owned connection store as `plugins.auth.connect`.',
  },
  // ── sandbox-internal hosts (same boundary, reached from plugins/kernel/*) ──
  {
    id: 'plugins.auth.sandbox-session',
    route: '/plugins/:id/auth',
    method: 'POST',
    kernelMode: 'unsupported',
    why:
      'The rev4 sandbox broker (`plugins/kernel/auth.ts`) reads service/connection metadata and starts flows ' +
      'through the legacy auth routes; the tokens stay in the host store and the browser flow is a host ' +
      'endpoint, so this is the same host plane as `plugins.auth.connect`, reached from the sandbox RPC.',
    removal:
      'Point the sandbox broker at the executor-owned connection store (metadata-only reads + flow start) ' +
      'instead of HTTP.',
  },
  {
    id: 'plugins.auth.fetch-proxy',
    route: '/plugins/:id/auth/fetch',
    method: 'POST',
    kernelMode: 'unsupported',
    why:
      'An authenticated `network.fetch` with a connectionId must go through a server-side proxy: the token ' +
      'never reaches the sandbox, and the host performs the outbound request (rev4 §K5). The kernel is not an ' +
      'HTTP client for plugin credentials.',
    removal:
      'The executor owns authenticated fetch (token injection in the trusted host); the sandbox RPC calls it ' +
      'directly instead of an HTTP proxy.',
  },
] as const;

/** Look up a surface by id (throws on an unknown id — that is a code bug). */
export function hostSurface(id: HostSurface['id']): HostSurface {
  const found = HOST_SURFACES.find((surface) => surface.id === id);
  if (!found) throw new Error(`unknown host surface: ${id}`);
  return found;
}

/**
 * Fail closed on the kernel plane with the surface's own id, so the UI error is
 * traceable back to the row in {@link HOST_SURFACES}.
 */
function assertLegacyPlane(id: HostSurface['id']): void {
  if (isKernelMode()) {
    throw new UnsupportedError(id);
  }
}

/**
 * The sandbox host's adapter: resolve one declared surface to its legacy route
 * (`/api/v2` + the surface template + a per-call suffix), then hand the request
 * to `fetch` on the legacy plane. On the kernel plane it throws the same typed
 * `UnsupportedError` as every other surface, so a sandbox RPC can never reach a
 * dead route by accident — the caller maps it to `CAPABILITY_UNAVAILABLE`.
 */
export async function hostSurfaceFetch(
  id: 'plugins.auth.sandbox-session' | 'plugins.auth.fetch-proxy',
  pluginId: string,
  suffix: string,
  init?: { method?: string; body?: string },
): Promise<Response> {
  assertLegacyPlane(id);
  const route = hostSurface(id).route.replace(':id', encodeURIComponent(pluginId));
  return fetch(legacyUrl(`${route}${suffix}`), {
    method: init?.method ?? 'GET',
    // An empty body with `content-type: application/json` is a Fastify 400
    // (FST_ERR_CTP_EMPTY_JSON_BODY) — the header only travels with a body.
    ...(init?.body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: init.body }),
  });
}

/** Reads a picked file as text (`File.text` is missing in some test DOMs). */
function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('plugin manifest could not be read'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsText(file);
  });
}

/**
 * Install a plugin from its `manifest.json` (round 75).
 *
 * There is no package pipeline: the kernel stores a plugin as a descriptor row
 * (`plugins.install`) and the runtime loads code from the web bundle, so a signed
 * ZIP would verify a payload nobody reads. The user picks a manifest, we validate
 * the few fields the wire requires, and the descriptor is recorded with
 * `locally-trusted` — the honest state of a plugin the user chose by hand.
 */
export async function installPlugin(file: File): Promise<PluginInstallResult> {
  const text = await readFileText(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('plugin manifest is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('plugin manifest must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const id = typeof record['id'] === 'string' ? record['id'] : '';
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(id)) {
    throw new Error('plugin manifest needs an id matching ^[a-z][a-z0-9-]{1,63}$');
  }
  const name =
    typeof record['name'] === 'string' && record['name'].length > 0 ? record['name'] : id;
  const version =
    typeof record['version'] === 'string' && record['version'].length > 0
      ? record['version']
      : '0.0.0';
  const permissions = Array.isArray(record['permissions'])
    ? record['permissions'].filter((value): value is string => typeof value === 'string')
    : [];
  const installed = await backend.plugins.install({
    id,
    name: name.slice(0, 128),
    version: version.slice(0, 64),
    trustState: 'locally-trusted',
    permissions: permissions.slice(0, 64),
    manifest: record,
  });
  return { plugin: translatePlugin(installed.plugin), replaced: false };
}

/**
 * Installs a plugin package the user picks as a folder (ADR-0066 P2b).
 *
 * The host reads `manifest.json`, verifies every declared file and publishes them; this
 * function only records the descriptor afterwards, using the manifest text that was
 * verified rather than one re-typed from the picked fields. Without a folder picker the
 * caller keeps the manifest-only path, which is honest but cannot load any code.
 */
export async function installPluginDirectory(): Promise<PluginInstallResult> {
  const dialog = await import('@tauri-apps/plugin-dialog');
  const picked = await dialog.open({ directory: true, multiple: false });
  if (typeof picked !== 'string' || picked.length === 0) {
    throw new Error('no package was selected');
  }
  const pkg = await installPackage(picked);
  const record = pkg.manifest;
  const id = typeof record['id'] === 'string' ? record['id'] : '';
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(id)) {
    throw new Error('plugin manifest needs an id matching ^[a-z][a-z0-9-]{1,63}$');
  }
  const name =
    typeof record['name'] === 'string' && record['name'].length > 0 ? record['name'] : id;
  const version =
    typeof record['version'] === 'string' && record['version'].length > 0
      ? record['version']
      : '0.0.0';
  const permissions = Array.isArray(record['permissions'])
    ? record['permissions'].filter((value): value is string => typeof value === 'string')
    : [];
  const installed = await backend.plugins.install({
    id,
    name: name.slice(0, 128),
    version: version.slice(0, 64),
    trustState: 'locally-trusted',
    permissions: permissions.slice(0, 64),
    manifest: record,
  });
  return { plugin: translatePlugin(installed.plugin), replaced: false };
}

/**
 * Git install has no kernel path: fetching a repository and trusting its contents
 * is host work that no plane implements, so it refuses instead of pretending.
 */
export async function installPluginFromGit(
  _input: PluginGitInstallRequest,
): Promise<PluginInstallResult> {
  throw new UnsupportedError('plugins.install.git');
}

/** Enter plugin runtime safe mode (host-owned switch). */
export async function enterPluginSafeMode(): Promise<PluginSafeModeResult> {
  assertLegacyPlane('plugins.safe-mode.enter');
  return api.post<PluginSafeModeResult>(hostSurface('plugins.safe-mode.enter').route);
}

/** Leave plugin runtime safe mode (host-owned switch). */
export async function exitPluginSafeMode(): Promise<PluginSafeModeResult> {
  assertLegacyPlane('plugins.safe-mode.exit');
  return api.del<PluginSafeModeResult>(hostSurface('plugins.safe-mode.exit').route);
}

/** List the OAuth connections of one plugin (host-held tokens). */
export async function readPluginAuthConnections(
  pluginId: string,
): Promise<PluginAuthConnectionsResponse> {
  assertLegacyPlane('plugins.auth.connections');
  const route = hostSurface('plugins.auth.connections').route.replace(
    ':id',
    encodeURIComponent(pluginId),
  );
  return api.get<PluginAuthConnectionsResponse>(route);
}

/** Start an OAuth flow for one plugin service (host redirect endpoint). */
export async function connectPluginAuth(
  pluginId: string,
  input: PluginAuthConnectRequest,
): Promise<PluginAuthConnectResult> {
  assertLegacyPlane('plugins.auth.connect');
  const route = hostSurface('plugins.auth.connect').route.replace(
    ':id',
    encodeURIComponent(pluginId),
  );
  return api.post<PluginAuthConnectResult>(route, input);
}

/** Revoke an OAuth connection (host-held token deletion). */
export async function revokePluginAuth(
  pluginId: string,
  input: PluginAuthRevokeRequest,
): Promise<PluginAuthRevokeResult> {
  assertLegacyPlane('plugins.auth.revoke');
  const route = hostSurface('plugins.auth.revoke').route.replace(
    ':id',
    encodeURIComponent(pluginId),
  );
  return api.post<PluginAuthRevokeResult>(route, input);
}
