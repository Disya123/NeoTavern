/**
 * Resource Governor (ТЗ Plugin SDK vNext §8, ADR-0026).
 *
 * Single owner of the plugin process-tree budgets:
 *
 * - per-plugin process ledger (heap cap, RSS soft/hard, CPU thresholds);
 * - RSS/CPU sampling: Linux `/proc` is authoritative per process; cgroup v2
 *   `memory.current` is the whole-tree measurement when available; the worker
 *   IPC usage report is the fallback on platforms without `/proc`;
 * - the ТЗ §8.4 pressure ladder (`ok → soft → elevated → critical → hard`)
 *   with admission control and machine-readable reasons;
 * - hard-limit enforcement: repeated per-plugin violations terminate that
 *   runtime, global hard pressure terminates the largest-overage victim —
 *   both delegated to the host via `onTerminate` (the host owns the process);
 * - a CPU watchdog: sustained per-plugin CPU usage above the hard threshold
 *   terminates the runaway plugin without blocking the host API.
 *
 * The governor never executes plugin code and never touches handles; the host
 * (BackendPluginHost) owns every process and acts on termination requests.
 */
import type {
  PluginGovernorAction,
  PluginPressureLevel,
  PluginResourceLimits,
  PluginRuntimeProcess,
  PluginRuntimeResourcesResponse,
} from '@neotavern/contracts';
import { readFile } from 'node:fs/promises';
import { randomToken, type Logger } from '@neotavern/shared';
import type { PluginResourceConfig } from '../config.js';
import { parseProcStat, parseVmRss, readCgroupInfo, type CgroupInfo } from './cgroup.js';

const MIB = 1024 * 1024;

/** Version of the limits handshake passed to plugin processes (ТЗ RES-09). */
export const RESOURCE_LIMITS_VERSION = 1;

/** Work classes the governor gates by admission (ТЗ §8.1, RES-03/04). */
export type AdmissionKind = 'plugin-start' | 'maintenance' | 'heavy' | 'background';

export type AdmissionResult =
  | { ok: true }
  | { ok: false; code: 'RESOURCE_PRESSURE'; retryAfterMs: number; level: PluginPressureLevel };

export interface ProcessSample {
  rssBytes: number | null;
  cpuMs: number | null;
}

/** Injectable sampler (tests) — defaults to /proc on Linux, IPC reports elsewhere. */
export type ProcessSampler = (pid: number) => Promise<ProcessSample> | ProcessSample;

export interface GovernedProcessInfo {
  pluginId: string;
  pid: number;
  heapMiB: number;
  rssSoftMiB: number;
  rssHardMiB: number;
  cpuSoftPercent: number;
  cpuHardPercent: number;
}

/** Cooperative usage report pushed by the worker over IPC (fallback source). */
export interface WorkerUsageReport {
  heapUsed: number;
  rss: number;
  cpuMs: number;
  uptimeMs: number;
}

interface PluginProcessState extends GovernedProcessInfo {
  /** RSS from /proc (authoritative on Linux) or the last IPC report. */
  rssBytes: number | null;
  /** Process CPU time, milliseconds. */
  cpuMs: number;
  /** CPU time at the previous sample — for per-interval usage deltas. */
  lastCpuMs: number;
  lastSampleAt: number;
  /** Consecutive samples above the RSS hard limit. */
  rssViolationSamples: number;
  /** Consecutive samples with CPU usage above the hard threshold. */
  cpuViolationSamples: number;
  /** Termination already requested — no repeated kills. */
  terminated: boolean;
  /** Whether the current RSS value came from /proc or IPC. */
  source: 'proc' | 'ipc' | null;
  startedAt: number;
}

export interface ResourceGovernorOptions {
  config: PluginResourceConfig;
  logger: Logger;
  sampleIntervalMs?: number;
  /** Consecutive over-hard RSS samples before termination (~2 × interval). */
  hardViolationSamples?: number;
  /** Consecutive over-hard CPU samples before watchdog termination. */
  cpuHardConsecutiveSamples?: number;
  sampler?: ProcessSampler;
  /** Injectable cgroup snapshot; `undefined` reads the real filesystem. */
  cgroup?: CgroupInfo | null;
  now?: () => number;
}

const ACTION_HISTORY_LIMIT = 50;

export class ResourceGovernor {
  private readonly processes = new Map<string, PluginProcessState>();
  private readonly logger: Logger;
  private readonly sampleIntervalMs: number;
  private readonly hardViolationSamples: number;
  private readonly cpuHardConsecutiveSamples: number;
  private readonly sampler: ProcessSampler;
  private readonly cgroupOverride: CgroupInfo | null | undefined;
  private readonly now: () => number;
  private readonly actions: PluginGovernorAction[] = [];

  private timer: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private level: PluginPressureLevel = 'ok';
  private selfPressure = false;
  private cgroup: CgroupInfo | null = null;
  private mainRssBytes = 0;
  private aggregateRssBytes = 0;
  private treeRssBytes = 0;
  private lastSampleAt = 0;

  /** Host hook: request graceful termination of a runtime (host owns kill). */
  onTerminate: ((pluginId: string, reason: string) => void) | null = null;
  /** Host hook: pressure level changed (idle eviction, cache flush, …). */
  onPressureChange: ((level: PluginPressureLevel) => void) | null = null;

  constructor(options: ResourceGovernorOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.sampleIntervalMs = options.sampleIntervalMs ?? 2_000;
    this.hardViolationSamples = options.hardViolationSamples ?? 2;
    this.cpuHardConsecutiveSamples = options.cpuHardConsecutiveSamples ?? 3;
    this.sampler =
      options.sampler ??
      ((pid) => (process.platform === 'linux' ? sampleProc(pid) : { rssBytes: null, cpuMs: null }));
    this.cgroupOverride = options.cgroup;
    this.now = options.now ?? Date.now;
    this.lastSampleAt = this.now();
  }

  /** The assembled resource profile (budgets, concurrency caps). */
  readonly config: PluginResourceConfig;

  /** CPU hard threshold (fraction of one core) for the watchdog. */
  get cpuHardPercent(): number {
    return Math.min(95, Math.round((this.config.plugins.backgroundCpuPercent * 0.9) / 10) * 10);
  }

  /** CPU soft threshold (fraction of one core). */
  get cpuSoftPercent(): number {
    return Math.round(this.cpuHardPercent * 0.7);
  }

  /** Versioned limits handshake for a backend plugin process (ТЗ RES-09). */
  limitsFor(pluginId: string): PluginResourceLimits | null {
    const state = this.processes.get(pluginId);
    if (!state) return null;
    return {
      version: RESOURCE_LIMITS_VERSION,
      heapMiB: state.heapMiB,
      rssSoftMiB: state.rssSoftMiB,
      rssHardMiB: state.rssHardMiB,
      cpuSoftPercent: state.cpuSoftPercent,
      cpuHardPercent: state.cpuHardPercent,
    };
  }

  registerProcess(info: GovernedProcessInfo): void {
    this.processes.set(info.pluginId, {
      ...info,
      rssBytes: null,
      cpuMs: 0,
      lastCpuMs: 0,
      lastSampleAt: this.now(),
      rssViolationSamples: 0,
      cpuViolationSamples: 0,
      terminated: false,
      source: null,
      startedAt: this.now(),
    });
  }

  unregisterProcess(pluginId: string): void {
    this.processes.delete(pluginId);
  }

  isTerminated(pluginId: string): boolean {
    return this.processes.get(pluginId)?.terminated ?? false;
  }

  /**
   * Cooperative usage report from the worker (fallback source on platforms
   * without /proc, cross-check on Linux).
   */
  handleUsageReport(pluginId: string, usage: WorkerUsageReport): void {
    const state = this.processes.get(pluginId);
    if (!state || !Number.isFinite(usage.rss)) return;
    if (state.source === 'proc' && state.rssBytes !== null) return;
    state.rssBytes = usage.rss;
    state.cpuMs = usage.cpuMs;
    state.source = 'ipc';
  }

  /** Admission control (ТЗ §8.4 steps 1/3/6, RES-03). */
  canAdmit(kind: AdmissionKind): AdmissionResult {
    if (this.level === 'hard' || this.selfPressure) {
      return { ok: false, code: 'RESOURCE_PRESSURE', retryAfterMs: 30_000, level: this.level };
    }
    if (kind === 'plugin-start' || kind === 'background') {
      if (this.level === 'critical') {
        return { ok: false, code: 'RESOURCE_PRESSURE', retryAfterMs: 10_000, level: this.level };
      }
      return { ok: true };
    }
    // maintenance / heavy are denied as soon as soft pressure starts (§8.4.1).
    if (this.level !== 'ok') {
      return { ok: false, code: 'RESOURCE_PRESSURE', retryAfterMs: 10_000, level: this.level };
    }
    return { ok: true };
  }

  /** Admin diagnostics payload (OBS-01; no payloads, no secrets). */
  snapshot(): PluginRuntimeResourcesResponse {
    const cgroup = this.cgroup;
    return {
      profile: this.config.profile,
      limitsVersion: RESOURCE_LIMITS_VERSION,
      level: this.level,
      budgets: {
        mainHeapMiB: this.config.server.nodeHeapMiB,
        mainRssHardMiB: this.config.server.mainRssHardMiB,
        treeSoftMiB: this.config.server.processTreeRssSoftMiB,
        treeHardMiB: this.config.server.processTreeRssHardMiB,
        aggregateSoftMiB: this.config.plugins.aggregateRssSoftMiB,
        aggregateHardMiB: this.config.plugins.aggregateRssHardMiB,
      },
      measurements: {
        mainRssMiB: roundMiB(this.mainRssBytes),
        aggregateRssMiB: roundMiB(this.aggregateRssBytes),
        treeRssMiB: roundMiB(this.treeRssBytes),
        ...(cgroup
          ? {
              cgroup: {
                available: cgroup.available,
                currentMiB:
                  cgroup.memoryCurrentMiB === null ? null : roundMiB(cgroup.memoryCurrentMiB * MIB),
                maxMiB: cgroup.memoryMaxMiB === null ? null : roundMiB(cgroup.memoryMaxMiB * MIB),
              },
            }
          : {}),
      },
      processes: [...this.processes.values()].map((state): PluginRuntimeProcess => {
        const process: PluginRuntimeProcess = {
          pluginId: state.pluginId,
          pid: state.pid,
          heapMiB: state.heapMiB,
          rssSoftMiB: state.rssSoftMiB,
          rssHardMiB: state.rssHardMiB,
          ...(state.rssBytes === null ? {} : { rssMiB: roundMiB(state.rssBytes) }),
          ...(state.cpuMs > 0 ? { cpuMs: Math.round(state.cpuMs) } : {}),
          ...(state.source === null ? {} : { source: state.source }),
        };
        return process;
      }),
      actions: [...this.actions],
    };
  }

  /** Start the sampling loop (unref'd — never keeps the server alive). */
  start(): void {
    if (this.timer) return;
    void this.sample();
    this.timer = setInterval(() => void this.sample(), this.sampleIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One governance pass; also used directly by tests. */
  async sample(): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      await this.tick();
    } finally {
      this.tickInFlight = false;
    }
  }

  private async tick(): Promise<void> {
    const now = this.now();
    const elapsed = now - this.lastSampleAt;
    this.lastSampleAt = now;
    this.mainRssBytes = process.memoryUsage().rss;
    if (this.cgroupOverride !== undefined) {
      this.cgroup = this.cgroupOverride;
    } else if (this.cgroup === null) {
      this.cgroup = await readCgroupSnapshot();
    }

    let aggregate = 0;
    const treeSource = this.cgroup?.memoryCurrentMiB;
    for (const state of this.processes.values()) {
      const sample = await this.sampler(state.pid);
      if (sample.rssBytes !== null) {
        state.rssBytes = sample.rssBytes;
        state.source = 'proc';
      } else if (state.source === 'proc') {
        // Process gone or /proc unreadable — keep the last known value.
      }
      if (sample.cpuMs !== null) state.cpuMs = sample.cpuMs;
      if (state.rssBytes !== null) aggregate += state.rssBytes;
      this.evaluateProcess(state, elapsed);
    }
    this.aggregateRssBytes = aggregate;
    this.treeRssBytes = treeSource != null ? treeSource * MIB : this.mainRssBytes + aggregate;

    const nextLevel = this.computeLevel();
    if (nextLevel !== this.level) {
      this.level = nextLevel;
      this.recordAction({
        pluginId: null,
        resource: 'tree',
        currentMiB: roundMiB(this.treeRssBytes),
        limitMiB: roundMiB(this.config.server.processTreeRssSoftMiB * MIB),
        action: `pressure:${nextLevel}`,
      });
      this.onPressureChange?.(nextLevel);
    }
    this.terminateVictims();
  }

  private evaluateProcess(state: PluginProcessState, elapsed: number): void {
    if (state.terminated) return;
    // RSS hard limit (ТЗ §8.4 step 4): N consecutive over-hard samples.
    if (state.rssBytes !== null && state.rssBytes > state.rssHardMiB * MIB) {
      state.rssViolationSamples += 1;
      if (state.rssViolationSamples >= this.hardViolationSamples) {
        this.requestTermination(state, 'RESOURCE_LIMIT_EXCEEDED');
      }
    } else {
      state.rssViolationSamples = 0;
    }
    // CPU watchdog (RES-06): sustained usage above the hard threshold.
    if (elapsed > 0 && state.cpuMs > 0) {
      const usage = (state.cpuMs - (state.lastCpuMs ?? 0)) / elapsed;
      state.lastCpuMs = state.cpuMs;
      if (usage >= this.cpuHardPercent / 100) {
        state.cpuViolationSamples += 1;
        if (state.cpuViolationSamples >= this.cpuHardConsecutiveSamples) {
          this.requestTermination(state, 'CPU_WATCHDOG');
        }
      } else {
        state.cpuViolationSamples = 0;
      }
    }
  }

  private computeLevel(): PluginPressureLevel {
    const config = this.config;
    const aggSoftBytes = config.plugins.aggregateRssSoftMiB * MIB;
    const aggHardBytes = config.plugins.aggregateRssHardMiB * MIB;
    const treeSoftBytes = config.server.processTreeRssSoftMiB * MIB;
    const treeHardBytes = config.server.processTreeRssHardMiB * MIB;
    const mainHardBytes = config.server.mainRssHardMiB * MIB;

    if ([...this.processes.values()].some((state) => state.terminated)) return 'hard';
    if (this.aggregateRssBytes >= aggHardBytes || this.treeRssBytes >= treeHardBytes) return 'hard';
    if (this.mainRssBytes >= mainHardBytes) {
      // ТЗ §8.4 step 6: the main process itself is over budget — deny new
      // work instead of an unbounded growth spiral.
      this.selfPressure = true;
      return 'critical';
    }
    this.selfPressure = false;
    if (this.aggregateRssBytes >= aggSoftBytes || this.treeRssBytes >= treeSoftBytes)
      return 'critical';
    if (this.aggregateRssBytes >= aggSoftBytes * 0.9 || this.treeRssBytes >= treeSoftBytes * 0.9) {
      return 'elevated';
    }
    if (this.aggregateRssBytes >= aggSoftBytes * 0.8 || this.treeRssBytes >= treeSoftBytes * 0.8) {
      return 'soft';
    }
    return 'ok';
  }

  /** ТЗ §8.4 step 5: global hard pressure kills the largest-overage runtime. */
  private terminateVictims(): void {
    if (this.level !== 'hard') return;
    let victim: PluginProcessState | null = null;
    let worstRatio = 0;
    for (const state of this.processes.values()) {
      if (state.terminated || state.rssBytes === null) continue;
      const ratio = state.rssBytes / Math.max(1, state.rssHardMiB * MIB);
      if (ratio > worstRatio) {
        worstRatio = ratio;
        victim = state;
      }
    }
    if (victim && worstRatio > 1) {
      this.requestTermination(victim, 'RESOURCE_LIMIT_EXCEEDED');
    } else if (victim === null) {
      // No attributable RSS data — never kill blindly (RES-04 keeps the main
      // process alive; unmeasured overage is reported to the operator).
      this.logger.warn(
        `resource governor: global hard pressure without attributable plugin RSS (level=hard)`,
      );
    }
  }

  private requestTermination(state: PluginProcessState, reason: string): void {
    if (state.terminated) return;
    state.terminated = true;
    this.recordAction({
      pluginId: state.pluginId,
      resource: 'rss',
      currentMiB: state.rssBytes === null ? undefined : roundMiB(state.rssBytes),
      limitMiB: roundMiB(state.rssHardMiB * MIB),
      action: reason,
    });
    this.logger.warn(
      `resource governor: terminating plugin ${state.pluginId} (${reason}, rss=${state.rssBytes === null ? '?' : roundMiB(state.rssBytes)}MiB, limit=${state.rssHardMiB}MiB)`,
    );
    this.onTerminate?.(state.pluginId, reason);
  }

  private recordAction(action: Omit<PluginGovernorAction, 'at' | 'traceId'>): void {
    this.actions.push({ at: this.now(), traceId: randomToken(8), ...action });
    if (this.actions.length > ACTION_HISTORY_LIMIT)
      this.actions.splice(0, this.actions.length - ACTION_HISTORY_LIMIT);
  }
}

function roundMiB(bytes: number): number {
  return Math.round((bytes / MIB) * 100) / 100;
}

/** Linux per-process sampling via /proc (authoritative RSS + CPU time). */
async function sampleProc(pid: number): Promise<ProcessSample> {
  const read = async (path: string): Promise<string | null> => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  };
  const [status, stat] = await Promise.all([
    read(`/proc/${pid}/status`),
    read(`/proc/${pid}/stat`),
  ]);
  return {
    rssBytes: status === null ? null : parseVmRss(status),
    cpuMs: stat === null ? null : parseProcStat(stat),
  };
}

let cachedCgroup: CgroupInfo | null | undefined;
/** Read the cgroup snapshot once per process lifetime (cheap, stable). */
async function readCgroupSnapshot(): Promise<CgroupInfo | null> {
  if (cachedCgroup !== undefined) return cachedCgroup;
  cachedCgroup = await readCgroupInfo();
  return cachedCgroup;
}
