/**
 * Emergency resource boundary from headroom (ADR-0026 §22, ТЗ v3.2 §22).
 *
 * Node Worker `resourceLimits` are used ONLY as an emergency ceiling against
 * runaway — never as a small per-plugin quota (§21). The ceiling is derived
 * from the actual system headroom: free memory, the runtime's own RSS, the
 * number of live workers, the plugin's declared memory hint and optional
 * admin overrides (§39). On a healthy machine the ceiling is large (free
 * resource is usable); it shrinks only when the system is actually near its
 * boundary. The computation is a pure function so the supervisor is
 * unit-testable with injected memory stats.
 */

/** One MiB in bytes. */
const MIB = 1024 * 1024;

/**
 * Absolute floor per worker: SES lockdown + a small plugin must fit even on a
 * nearly-exhausted box (this is the emergency boundary, not a quota).
 */
export const EMERGENCY_MIN_OLD_GEN_MB = 256;

/**
 * Absolute per-worker damage cap: one runaway worker can never be granted an
 * unbounded heap; the whole Plugin Runtime is the restartable unit beyond
 * that (§23.2/§24).
 */
export const EMERGENCY_MAX_OLD_GEN_MB = 4 * 1024;

/** Fraction of observed free memory that may back worker emergency ceilings. */
export const EMERGENCY_HEADROOM_FRACTION = 0.75;

/** Young generation stays a small fraction of the old-gen ceiling. */
export const EMERGENCY_YOUNG_GEN_FRACTION = 0.25;
export const EMERGENCY_MAX_YOUNG_GEN_MB = 512;
export const EMERGENCY_MIN_YOUNG_GEN_MB = 64;

/** Inputs for the headroom calculation (all memory values in bytes). */
export interface EmergencyLimitInputs {
  /** Physical RAM of the machine. */
  totalMemory: number;
  /** Currently free system memory. */
  freeMemory: number;
  /** RSS of the Plugin Runtime process (the supervisor's own process). */
  runtimeRss: number;
  /** Number of live workers already accounted for. */
  activeWorkerCount: number;
  /**
   * Plugin memory hint (MiB, manifest `resources.memoryHintMiB`, §38).
   * 0/undefined = unknown.
   */
  memoryHintMiB?: number;
  /**
   * Admin override (§39, `plugins.overrides.<id>.maxHeapMiB`). 0/undefined =
   * no override. Wins over everything else.
   */
  maxHeapOverrideMiB?: number;
}

export interface EmergencyLimits {
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function youngGenFor(oldGenMb: number): number {
  return clamp(
    Math.floor(oldGenMb * EMERGENCY_YOUNG_GEN_FRACTION),
    EMERGENCY_MIN_YOUNG_GEN_MB,
    EMERGENCY_MAX_YOUNG_GEN_MB,
  );
}

/**
 * Compute the per-worker emergency ceiling from system headroom.
 *
 * Model:
 *   headroom = freeMemory * EMERGENCY_HEADROOM_FRACTION
 *              − runtimeRss            (the runtime's own footprint)
 *              − activeWorkerCount * EMERGENCY_MIN_OLD_GEN_MB
 *                (conservative reservation: every live worker already holds
 *                 at least the floor, so a fanout cannot silently consume
 *                 the whole shared budget)
 *   ceiling  = clamp(max(headroom, hint), MIN, MAX)
 *
 * The hint raises the ceiling when headroom permits (a legitimate plugin
 * declaring more heap may use it, §22), but never below the floor. The
 * override replaces the whole calculation (§39).
 */
export function computeEmergencyLimits(inputs: EmergencyLimitInputs): EmergencyLimits {
  const override = inputs.maxHeapOverrideMiB;
  if (override !== undefined && Number.isInteger(override) && override > 0) {
    const oldGenMb = clamp(override, EMERGENCY_MIN_OLD_GEN_MB, EMERGENCY_MAX_OLD_GEN_MB);
    return { maxOldGenerationSizeMb: oldGenMb, maxYoungGenerationSizeMb: youngGenFor(oldGenMb) };
  }

  const freeMb = Math.max(0, inputs.freeMemory) / MIB;
  const runtimeRssMb = Math.max(0, inputs.runtimeRss) / MIB;
  const reservedMb = Math.max(0, inputs.activeWorkerCount) * EMERGENCY_MIN_OLD_GEN_MB;
  const headroomMb = Math.max(0, freeMb * EMERGENCY_HEADROOM_FRACTION - runtimeRssMb - reservedMb);

  const hintMb =
    inputs.memoryHintMiB !== undefined && Number.isInteger(inputs.memoryHintMiB)
      ? Math.max(0, inputs.memoryHintMiB)
      : 0;
  const ceilingMb = clamp(
    Math.max(headroomMb, hintMb),
    EMERGENCY_MIN_OLD_GEN_MB,
    EMERGENCY_MAX_OLD_GEN_MB,
  );
  return {
    maxOldGenerationSizeMb: Math.round(ceilingMb),
    maxYoungGenerationSizeMb: youngGenFor(Math.round(ceilingMb)),
  };
}

/**
 * Resolve the effective limits for one spawn: explicit per-spawn options win,
 * then the supervisor's static configuration, then the headroom-derived
 * emergency boundary.
 */
export function resolveEmergencyLimits(args: {
  explicitOldGenMb?: number;
  explicitYoungGenMb?: number;
  staticLimits?: EmergencyLimits;
  inputs: EmergencyLimitInputs;
}): EmergencyLimits {
  if (args.explicitOldGenMb !== undefined && Number.isInteger(args.explicitOldGenMb)) {
    const oldGenMb = clamp(
      args.explicitOldGenMb,
      EMERGENCY_MIN_OLD_GEN_MB,
      EMERGENCY_MAX_OLD_GEN_MB,
    );
    const explicitYoung =
      args.explicitYoungGenMb !== undefined && Number.isInteger(args.explicitYoungGenMb)
        ? clamp(args.explicitYoungGenMb, EMERGENCY_MIN_YOUNG_GEN_MB, EMERGENCY_MAX_YOUNG_GEN_MB)
        : youngGenFor(oldGenMb);
    return { maxOldGenerationSizeMb: oldGenMb, maxYoungGenerationSizeMb: explicitYoung };
  }
  if (args.staticLimits !== undefined) {
    return args.staticLimits;
  }
  return computeEmergencyLimits(args.inputs);
}
