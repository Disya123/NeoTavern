/**
 * Worker supervisor inside the Plugin Runtime (ТЗ v3.2 §16, §20, §25.1;
 * ADR-0027, ADR-0028).
 *
 * Owns the Worker registry: spawn from the trusted bootstrap, one Compartment
 * per Worker, never-reassign rule (§5.7), two-phase termination with
 * workerEpoch (§25.1), and readiness/exit/telemetry plumbing.
 *
 * The supervisor never executes plugin callbacks and never decodes plugin
 * payloads (§16.1, §15.1).
 */
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { totalmem, freemem } from 'node:os';
import type { PluginRuntimeAuthorityProbe } from '@neotavern/contracts';
import { PLUGIN_RUNTIME_PROTOCOL_VERSION } from '@neotavern/contracts';
import { minimalWorkerEnv } from './env.js';
import { resolveEmergencyLimits, type EmergencyLimits } from './emergencyLimits.js';

/** Grace window for a worker to ack terminate before force-termination (§25.1). */
const TERMINATE_GRACE_MS = 1500;

export interface SpawnWorkerOptions {
  workerId: number;
  pluginId: string;
  installationId: string;
  /** Trust level of this installation (ТЗ §11); the broker checks it on
   * every call. Defaults to `sandbox`. */
  trustLevel?: 'sandbox' | 'extended' | 'trusted';
  moduleGraphDigest?: string;
  /**
   * Explicit emergency heap caps (ADR-0026 §22). Without them the supervisor
   * derives the ceiling per spawn from actual system headroom (free memory,
   * runtime RSS, live worker count, the plugin memory hint and any admin
   * override) — the ceiling is an emergency boundary, never a small quota.
   */
  maxOldGenerationSizeMb?: number;
  maxYoungGenerationSizeMb?: number;
  /** §38 plugin memory hint (MiB, manifest `resources.memoryHintMiB`). */
  memoryHintMiB?: number;
  /** §39 admin override `maxHeapMiB` (wins over headroom). */
  maxHeapOverrideMiB?: number;
}

export interface WorkerRecord {
  workerId: number;
  workerEpoch: number;
  pluginId: string;
  installationId: string;
  trustLevel: 'sandbox' | 'extended' | 'trusted';
  thread: Worker;
  control: MessagePort;
  state: 'starting' | 'ready' | 'terminating' | 'terminated';
  startedAt: number;
}

export interface WorkerReadyInfo {
  workerId: number;
  workerEpoch: number;
  pluginId: string;
  installationId: string;
  trustLevel: 'sandbox' | 'extended' | 'trusted';
  lockdownMs: number;
  compartmentMs: number;
  bootstrapMs: number;
  noNodeAuthority: boolean;
  probe: PluginRuntimeAuthorityProbe;
  /** §22: the emergency ceiling the worker was spawned with (when reported). */
  emergencyLimits?: EmergencyLimits;
}

export interface WorkerExitInfo {
  workerId: number;
  workerEpoch: number;
  code: number | null;
}

export interface WorkerLogEntry {
  workerId: number;
  workerEpoch: number;
  level: string;
  message: string;
  at: number;
}

/** Optional callbacks; all of them default to no-ops. */
export interface SupervisorListener {
  onWorkerReady?(info: WorkerReadyInfo): void;
  onWorkerLog?(entry: WorkerLogEntry): void;
  onWorkerExit?(info: WorkerExitInfo): void;
  onWorkerError?(info: { workerId: number; workerEpoch: number; error: unknown }): void;
}

export interface SupervisorStats {
  workerCount: number;
  readyCount: number;
  startingCount: number;
  terminatingCount: number;
  workerRestarts: number;
}

function resolveBootstrapUrl(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../worker-bootstrap.mjs');
}

interface BridgeHardenedReady {
  kind: 'hardened-ready';
  workerId: number;
  workerEpoch: number;
  lockdownMs: number;
  compartmentMs: number;
  bootstrapMs: number;
  noNodeAuthority: boolean;
  probe: PluginRuntimeAuthorityProbe;
  emergencyLimits?: EmergencyLimits;
}

interface BridgeTerminateAck {
  kind: 'terminate-ack';
  workerId: number;
  workerEpoch: number;
}

function isHardenedReady(value: unknown): value is BridgeHardenedReady {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record['kind'] === 'hardened-ready' &&
    typeof record['workerId'] === 'number' &&
    typeof record['workerEpoch'] === 'number' &&
    typeof record['lockdownMs'] === 'number' &&
    typeof record['compartmentMs'] === 'number' &&
    typeof record['bootstrapMs'] === 'number' &&
    typeof record['noNodeAuthority'] === 'boolean' &&
    typeof record['probe'] === 'object' &&
    record['probe'] !== null
  );
}

function isTerminateAck(value: unknown): value is BridgeTerminateAck {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record['kind'] === 'terminate-ack' &&
    typeof record['workerId'] === 'number' &&
    typeof record['workerEpoch'] === 'number'
  );
}

function isLogEntry(value: unknown): value is WorkerLogEntry {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record['kind'] === 'log' &&
    typeof record['workerId'] === 'number' &&
    typeof record['workerEpoch'] === 'number' &&
    typeof record['level'] === 'string' &&
    typeof record['message'] === 'string' &&
    typeof record['at'] === 'number'
  );
}

export class WorkerSupervisor {
  private readonly records = new Map<number, WorkerRecord>();
  private readonly workerEpochs = new Map<number, number>();
  private readonly listener: SupervisorListener;
  private readonly onBridgeMessage: (record: WorkerRecord, message: unknown) => void;
  private readonly bootstrapUrl: string;
  /**
   * Static emergency caps (explicit configuration). Undefined → the
   * supervisor derives the ceiling per spawn from headroom (ADR-0026 §22).
   */
  private readonly staticLimits: EmergencyLimits | undefined;
  private workerRestarts = 0;

  constructor(
    listener: SupervisorListener,
    options?: {
      bootstrapUrl?: string;
      maxOldGenerationSizeMb?: number;
      maxYoungGenerationSizeMb?: number;
      /**
       * Hook for application-level bridge messages the supervisor does not
       * understand itself (Stage C: the broker gateway subscribes here).
       * The supervisor remains transport-pure (§16.1): it never decodes the
       * payload, it only forwards the raw message.
       */
      onBridgeMessage?: (record: WorkerRecord, message: unknown) => void;
    },
  ) {
    this.listener = listener;
    this.bootstrapUrl = options?.bootstrapUrl ?? resolveBootstrapUrl();
    this.onBridgeMessage = options?.onBridgeMessage ?? (() => {});
    this.staticLimits =
      options?.maxOldGenerationSizeMb !== undefined
        ? {
            maxOldGenerationSizeMb: options.maxOldGenerationSizeMb,
            maxYoungGenerationSizeMb:
              options.maxYoungGenerationSizeMb ?? Math.floor(options.maxOldGenerationSizeMb / 4),
          }
        : undefined;
  }

  spawnWorker(options: SpawnWorkerOptions): WorkerRecord {
    if (this.records.has(options.workerId)) {
      throw new Error(`worker ${options.workerId} is already registered`);
    }
    const workerEpoch = (this.workerEpochs.get(options.workerId) ?? 0) + 1;
    this.workerEpochs.set(options.workerId, workerEpoch);

    const channel = new MessageChannel();
    const trustLevel = options.trustLevel ?? 'sandbox';
    const workerData = {
      protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
      workerId: options.workerId,
      workerEpoch,
      pluginId: options.pluginId,
      installationId: options.installationId,
      trustLevel,
      moduleGraphDigest: options.moduleGraphDigest,
      bridgePort: channel.port1,
    };

    const limits = resolveEmergencyLimits({
      explicitOldGenMb: options.maxOldGenerationSizeMb,
      explicitYoungGenMb: options.maxYoungGenerationSizeMb,
      staticLimits: this.staticLimits,
      inputs: {
        totalMemory: totalmem(),
        freeMemory: freemem(),
        runtimeRss: process.memoryUsage().rss,
        activeWorkerCount: this.records.size,
        memoryHintMiB: options.memoryHintMiB,
        maxHeapOverrideMiB: options.maxHeapOverrideMiB,
      },
    });

    const thread = new Worker(this.bootstrapUrl, {
      workerData,
      transferList: [channel.port1],
      argv: [],
      execArgv: [],
      env: minimalWorkerEnv(),
      eval: false,
      trackUnmanagedFds: true,
      stdin: false,
      stdout: true,
      stderr: true,
      resourceLimits: {
        maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: limits.maxYoungGenerationSizeMb,
      },
    });

    const record: WorkerRecord = {
      workerId: options.workerId,
      workerEpoch,
      pluginId: options.pluginId,
      installationId: options.installationId,
      trustLevel,
      thread,
      control: channel.port2,
      state: 'starting',
      startedAt: Date.now(),
    };
    this.records.set(options.workerId, record);
    this.wire(record);
    return record;
  }

  terminateWorker(workerId: number, reason?: string): Promise<void> {
    return this.terminateWorkerInternal(workerId, reason);
  }

  async terminateAll(reason?: string): Promise<void> {
    await Promise.all([...this.records.keys()].map((id) => this.terminateWorker(id, reason)));
  }

  getRecord(workerId: number): WorkerRecord | undefined {
    return this.records.get(workerId);
  }

  stats(): SupervisorStats {
    let readyCount = 0;
    let startingCount = 0;
    let terminatingCount = 0;
    for (const record of this.records.values()) {
      if (record.state === 'ready') readyCount += 1;
      else if (record.state === 'starting') startingCount += 1;
      else if (record.state === 'terminating') terminatingCount += 1;
    }
    return {
      workerCount: this.records.size,
      readyCount,
      startingCount,
      terminatingCount,
      workerRestarts: this.workerRestarts,
    };
  }

  private async terminateWorkerInternal(workerId: number, reason?: string): Promise<void> {
    const record = this.records.get(workerId);
    if (!record || record.state === 'terminated' || record.state === 'terminating') return;
    record.state = 'terminating';
    try {
      record.control.postMessage({ kind: 'terminate', reason });
    } catch {
      // Port is already dead; fall through to force-termination.
    }
    await delay(TERMINATE_GRACE_MS);
    if (getWorkerState(record) !== 'terminated') {
      await record.thread.terminate();
    }
  }

  private wire(record: WorkerRecord): void {
    record.control.on('message', (message: unknown) => {
      if (isHardenedReady(message)) {
        this.handleHardenedReady(record, message);
        return;
      }
      if (isLogEntry(message)) {
        if (this.matchesEpoch(record, message.workerId, message.workerEpoch)) {
          this.listener.onWorkerLog?.(message);
        }
        return;
      }
      if (isTerminateAck(message)) {
        if (
          record.state === 'terminating' &&
          this.matchesEpoch(record, message.workerId, message.workerEpoch)
        ) {
          // Mark the exit as expected so it is not counted as a restart.
          record.state = 'terminated';
          void record.thread.terminate();
        }
        return;
      }
      // Application-level bridge messages (Stage C broker calls, Stage D SDK
      // operations) go to the registered gateway; the supervisor never
      // decodes them (§16.1).
      this.onBridgeMessage(record, message);
    });
    record.control.on('error', (error: unknown) => {
      this.listener.onWorkerError?.({
        workerId: record.workerId,
        workerEpoch: record.workerEpoch,
        error,
      });
    });
    record.thread.on('error', (error: unknown) => {
      this.listener.onWorkerError?.({
        workerId: record.workerId,
        workerEpoch: record.workerEpoch,
        error,
      });
    });
    record.thread.on('exit', (code: number | null) => {
      const unexpected = record.state !== 'terminated';
      record.state = 'terminated';
      record.control.close();
      this.records.delete(record.workerId);
      if (unexpected) this.workerRestarts += 1;
      this.listener.onWorkerExit?.({
        workerId: record.workerId,
        workerEpoch: record.workerEpoch,
        code,
      });
    });
  }

  private handleHardenedReady(record: WorkerRecord, message: BridgeHardenedReady): void {
    if (!this.matchesEpoch(record, message.workerId, message.workerEpoch)) return;
    record.state = 'ready';
    this.listener.onWorkerReady?.({
      workerId: record.workerId,
      workerEpoch: record.workerEpoch,
      pluginId: record.pluginId,
      installationId: record.installationId,
      trustLevel: record.trustLevel,
      lockdownMs: message.lockdownMs,
      compartmentMs: message.compartmentMs,
      bootstrapMs: message.bootstrapMs,
      noNodeAuthority: message.noNodeAuthority,
      probe: message.probe,
      emergencyLimits: message.emergencyLimits,
    });
  }

  /** Stale workerEpoch messages from a previous incarnation are dropped (§25.1). */
  private matchesEpoch(record: WorkerRecord, workerId: number, workerEpoch: number): boolean {
    return record.workerId === workerId && record.workerEpoch === workerEpoch;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** Re-read the mutable state; TS cannot narrow it across event-handler writes. */
function getWorkerState(record: WorkerRecord): WorkerRecord['state'] {
  return record.state;
}
