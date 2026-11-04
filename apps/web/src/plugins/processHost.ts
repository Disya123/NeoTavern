/**
 * Plugin process host bridge (ADR-0066 P3c).
 *
 * The only way the web client talks to a plugin's native process. Everything is
 * host-side: the desktop shell owns the process, the supervisor decides whether a
 * start is allowed, and this module parses what the host reports instead of inventing
 * state.
 *
 * A browser-only session has no processes at all. It says so with `UnsupportedError`
 * rather than pretending a plugin runs locally — an honest silence beats a fake
 * "running" badge.
 */
import { UnsupportedError } from '@neotavern/neobackend';

/** What a start attempt produced, as the host reports it. */
export interface PluginProcessOutcome {
  kind: 'Clean' | 'Crash' | 'Hang' | 'Unknown';
  elapsedMs: number;
  detail: string;
}

/** Supervisory state of one plugin process. */
export interface PluginProcessStatus {
  state: 'Stopped' | 'Running' | 'Backoff' | 'Failed' | 'Unknown';
  restarts: number;
  lastError: string;
}

const SURFACE = 'plugins.process';

/** True when the shell exposes the Tauri IPC bridge. */
export function hasPluginProcessHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Parses the host's compact `kind|elapsedMs|detail` answer.
 *
 * The format is deliberately flat: it crosses the IPC boundary as one string, so a
 * version skew cannot silently rename a field.
 */
export function parseOutcome(value: string): PluginProcessOutcome {
  const [kind = '', elapsed = '', ...rest] = value.split('|');
  const known = kind === 'Clean' || kind === 'Crash' || kind === 'Hang';
  return {
    kind: known ? kind : 'Unknown',
    elapsedMs: Number.parseInt(elapsed, 10) || 0,
    detail: rest.join('|'),
  };
}

/** Parses the host's `state|restarts|lastError` answer. */
export function parseStatus(value: string): PluginProcessStatus {
  const [state = '', restarts = '', ...rest] = value.split('|');
  const known =
    state === 'Stopped' || state === 'Running' || state === 'Backoff' || state === 'Failed';
  return {
    state: known ? state : 'Unknown',
    restarts: Number.parseInt(restarts, 10) || 0,
    lastError: rest.join('|'),
  };
}

async function invokeHost<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!hasPluginProcessHost()) throw new UnsupportedError(SURFACE);
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/**
 * Starts a native plugin process from its staged bundle.
 *
 * `entry` is package-relative; the host refuses absolute paths and anything outside
 * the plugin's own bundle, so this wrapper never builds a path itself.
 */
export async function startPluginProcess(
  pluginId: string,
  version: string,
  entry: string,
  timeoutMs = 30_000,
): Promise<PluginProcessOutcome> {
  const raw = await invokeHost<string>('plugin_process_start', {
    pluginId,
    version,
    entry,
    timeoutMs,
  });
  return parseOutcome(raw);
}

/** Reads the supervisor's view of one plugin. */
export async function readPluginProcessStatus(pluginId: string): Promise<PluginProcessStatus> {
  return parseStatus(await invokeHost<string>('plugin_process_status', { pluginId }));
}

/** Operator stop; the failure history stays. */
export async function stopPluginProcess(pluginId: string): Promise<void> {
  await invokeHost<null>('plugin_process_stop', { pluginId });
}

/** Operator reset; a plugin that exhausted its restarts may start again. */
export async function resetPluginProcess(pluginId: string): Promise<void> {
  await invokeHost<null>('plugin_process_reset', { pluginId });
}
