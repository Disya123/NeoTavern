/**
 * Legacy app.db import — the Settings → Data UI bindings for the
 * `legacy_import_plan` / `legacy_import_execute` / `legacy_import_rollback`
 * Tauri host commands (G7/G8 user-facing half, round 29/30; ADR-0062).
 *
 * These are host commands, not Product Wire: no envelope, no kernel dispatch
 * — plain Tauri IPC with the stable `CODE: message` failure strings the
 * adapter formats. Kernel mode only: outside Tauri (web client / sidecar
 * mode) every call reports `LEGACY_UNAVAILABLE` and the panel hides the
 * block (see `isLegacyImportAvailable`).
 */

/** One entity family in an import report (mirrors the Rust DTO). */
export interface LegacyFamilyReport {
  family: string;
  count: number;
  present: boolean;
}

/** `legacy_import_plan` result. */
export interface LegacyImportPlanReport {
  sourceDb: string;
  ready: boolean;
  problems: string[];
  families: LegacyFamilyReport[];
}

/** `legacy_import_execute` result. */
export interface LegacyImportExecuteReport {
  stagedRootId: string;
  previousRoot: string;
  families: LegacyFamilyReport[];
  restartRequired: boolean;
}

/** `legacy_import_rollback` result. */
export interface LegacyRollbackReport {
  restoredRoot: string;
  restartRequired: boolean;
}

/** A stable legacy host-op failure (the UI localizes the code). */
export interface LegacyOpFailure {
  code: string;
  message: string;
}

/** Every stable code the host can answer with (kept in one place). */
export const LEGACY_OP_CODES = [
  'LEGACY_SOURCE_UNREADABLE',
  'LEGACY_STORAGE',
  'LEGACY_NO_ROLLBACK_TARGET',
  'LEGACY_NO_DATA_ROOT',
  'LEGACY_UNAVAILABLE',
] as const;

export type LegacyOpCode = (typeof LEGACY_OP_CODES)[number];

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Legacy import needs the kernel-mode host commands; elsewhere it hides. */
export function isLegacyImportAvailable(): boolean {
  return isTauriRuntime();
}

/**
 * Parses the adapter's `CODE: message` IPC failure into a typed failure.
 * Unknown shapes degrade to `LEGACY_UNAVAILABLE` with the raw text — never a
 * crash, never a lost message.
 */
export function parseLegacyOpError(raw: unknown): LegacyOpFailure {
  const text =
    typeof raw === 'string'
      ? raw
      : typeof raw === 'object' && raw !== null
        ? JSON.stringify(raw)
        : String(raw ?? '');
  const match = /^(LEGACY_[A-Z_]+):\s*(.+)$/.exec(text);
  if (match) {
    return { code: match[1] ?? 'LEGACY_UNAVAILABLE', message: match[2] ?? text };
  }
  return { code: 'LEGACY_UNAVAILABLE', message: text };
}

async function invokeLegacy<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error('LEGACY_UNAVAILABLE: legacy import runs in the desktop kernel mode only');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/** Dry-runs the import: per-family counts + readiness, writes nothing. */
export async function legacyImportPlan(sourcePath: string): Promise<LegacyImportPlanReport> {
  return invokeLegacy<LegacyImportPlanReport>('legacy_import_plan', { sourcePath });
}

/** Stages, validates and activates the import (restart applies it). */
export async function legacyImportExecute(sourcePath: string): Promise<LegacyImportExecuteReport> {
  return invokeLegacy<LegacyImportExecuteReport>('legacy_import_execute', { sourcePath });
}

/** Restores the root pointer to the last import's `fromRoot`. */
export async function legacyImportRollback(): Promise<LegacyRollbackReport> {
  return invokeLegacy<LegacyRollbackReport>('legacy_import_rollback', {});
}

/**
 * Opens the native file picker for a legacy `app.db` (open dialog only —
 * the capability grants no filesystem scope). Resolves `null` on cancel.
 */
export async function pickLegacyAppDb(): Promise<string | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  const dialog = await import('@tauri-apps/plugin-dialog');
  const picked = await dialog.open({
    multiple: false,
    directory: false,
    filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] }],
  });
  return typeof picked === 'string' ? picked : null;
}
