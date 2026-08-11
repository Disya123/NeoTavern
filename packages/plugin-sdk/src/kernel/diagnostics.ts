/**
 * Rev4 kernel diagnostics (contract §2, rev4 §C): a read-only snapshot of
 * the plugin's OWN runtime state — protocol/sdk versions, sandbox instance,
 * limits, host feature registry and active grants.
 *
 * The snapshot must never carry secrets (API keys, tokens, credentials,
 * filesystem paths) or another plugin's state: it is built host-side from
 * public registry fields only (AGENTS.md §4: no secrets in diagnostic
 * exports). No capability is required — the data is the plugin's own, like
 * `capabilities.list`.
 */
import type { CapabilityGrant } from './capabilities.js';
import type { PluginLimits } from './limits.js';

/** Stable plugin registry identity, safe for diagnostics (no secrets). */
export interface DiagnosticsPluginInfo {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  status: string;
  lastErrorCode: string | null;
  compatibilityLevel: string;
}

/** Read-only runtime snapshot a plugin may request about itself. */
export interface DiagnosticsSnapshot {
  protocolVersion: string;
  sdkVersion: string;
  /** Sandbox session identifier, stable for the lifetime of the frame. */
  instanceId: string;
  plugin: DiagnosticsPluginInfo;
  limits: PluginLimits | null;
  /** Host feature registry (`api.runtime.supports` keys). */
  features: Record<string, number>;
  /** Active grants, capped at 64 entries. */
  grants: CapabilityGrant[];
  /**
   * rev4 §M3: crash-isolation state — present once the host recorded a
   * heartbeat failure (hung/crashed sandbox). `restartBudgetLeft` counts
   * automatic restarts remaining inside the restart window; 0 means the
   * next failure disables the plugin.
   */
  crash?: {
    count: number;
    lastAt: number | null;
    restartBudgetLeft: number;
  };
}

export interface KernelDiagnosticsApi {
  /** Resolve a read-only snapshot of the plugin's own runtime state. */
  get(): Promise<DiagnosticsSnapshot>;
}
