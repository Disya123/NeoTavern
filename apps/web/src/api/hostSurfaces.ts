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
import { UnsupportedError } from '@neotavern/neobackend';
import { api } from './client.js';
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
    | 'plugins.install.host-verify'
    | 'plugins.install.git.host-verify'
    | 'plugins.safe-mode.enter'
    | 'plugins.safe-mode.exit'
    | 'plugins.auth.connections'
    | 'plugins.auth.connect'
    | 'plugins.auth.revoke';
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
    id: 'plugins.install.host-verify',
    route: '/plugins/install',
    method: 'POST',
    kernelMode: 'unsupported',
    why:
      'Package acceptance is host-owned: the kernel `plugins.install` op requires the host to have already ' +
      'verified signature/digest and ZIP traversal (SEC-05). The browser has no verifier.',
    removal:
      'Move the verifier into the kernel-side host adapter (desktop/CLI) and expose a "verified package" ' +
      'handle to the UI, then delete this route.',
  },
  {
    id: 'plugins.install.git.host-verify',
    route: '/plugins/install-git',
    method: 'POST',
    kernelMode: 'unsupported',
    why:
      'A Git archive fetch is an outbound network operation of the trusted host, not the browser, and it ' +
      'needs the same signature verification as a local package.',
    removal:
      'Serve it from the same kernel-side host adapter as `plugins.install` (one verifier, two sources).',
  },
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

/** Install a plugin package the host has verified (see `plugins.install.host-verify`). */
export async function installPlugin(file: File): Promise<PluginInstallResult> {
  assertLegacyPlane('plugins.install.host-verify');
  return api.upload<PluginInstallResult>(hostSurface('plugins.install.host-verify').route, file);
}

/** Install a plugin from a public Git archive (host-side fetch + verification). */
export async function installPluginFromGit(
  input: PluginGitInstallRequest,
): Promise<PluginInstallResult> {
  assertLegacyPlane('plugins.install.git.host-verify');
  return api.post<PluginInstallResult>(hostSurface('plugins.install.git.host-verify').route, input);
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
