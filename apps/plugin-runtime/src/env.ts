/**
 * Spawn contract for the Plugin Runtime process (ADR-0027/0028).
 *
 * The Main Host passes only small immutable identifiers and tuning knobs;
 * never secrets, NODE_OPTIONS or unrelated NeoTavern environment (§5.5, §15.8).
 */
export interface PluginRuntimeSpawnEnv {
  /** Runtime generation counter, used to ignore stale messages (§25.1). */
  runtimeEpoch: number;
  /** Opaque host-assigned runtime identity (diagnostics only). */
  runtimeId: string;
  /** Telemetry push interval in milliseconds (§40). */
  telemetryMs: number;
}

/** Parse `NEOTA_PLUGIN_RUNTIME_*` environment variables with safe defaults. */
export function parseRuntimeEnv(env: NodeJS.ProcessEnv = process.env): PluginRuntimeSpawnEnv {
  return {
    runtimeEpoch: parseNonNegativeInt(env['NEOTA_PLUGIN_RUNTIME_EPOCH'], 1),
    runtimeId: env['NEOTA_PLUGIN_RUNTIME_ID'] ?? `runtime-${process.pid}`,
    telemetryMs: parsePositiveInt(env['NEOTA_PLUGIN_RUNTIME_TELEMETRY_MS'], 5000),
  };
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Minimal environment for plugin Workers (§5.5, ADR-0028): no NODE_OPTIONS,
 * no host secrets, no SHARE_ENV. Only platform-neutral locale variables are
 * carried over.
 */
export function minimalWorkerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_NO_WARNINGS: '1' };
  for (const key of ['SystemRoot', 'WINDIR', 'LANG', 'LC_ALL']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}
