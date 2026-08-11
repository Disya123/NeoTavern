/**
 * vNext Plugin Runtime service (ADR-0027 §3, ТЗ Plugin SDK vNext v3.2 §15,
 * §25; Stage A).
 *
 * The Main Host side of the Plugin Runtime lifecycle: lazily spawns the
 * runtime process, builds signed module graphs from plugin package
 * directories, activates one worker per v3 plugin (spawn → WORKER_READY →
 * MODULE_GRAPH → module-graph-loaded), and wires the broker host (part 9c)
 * to the runtime transport so worker-side capability calls are decided in
 * Main Host.
 *
 * Stage A prototype limits, documented in docs/plugin-sdk/vnext-plan.md:
 * - module graphs travel as a single control frame (64 KiB cap); bulk
 *   data-pipe transfer is a later stage, so host-side graph building caps
 *   per-module source and total graph size.
 * - one worker per plugin; no worker restarts yet.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type {
  PluginModuleGraph,
  PluginRuntimeBridgeMessageBody,
  PluginRuntimeFatalDiagnosticBody,
  PluginRuntimeLogBatchPayload,
  PluginRuntimeLogRecord,
  PluginRuntimeWorkerReady,
  PluginRuntimeWorkerTerminated,
} from '@neotavern/contracts';
import {
  buildModuleGraph,
  ModuleMapDiskCache,
  packageSourceDigest,
  PluginRuntimeClient,
  sha256Hex,
  type MemoryHostOptions,
  type PluginPackageSource,
} from '@neotavern/plugin-runtime';
import { AppError, ErrorCodes } from '@neotavern/shared';
import {
  attachVNextBrokerHost,
  createVNextBrokerHost,
  type VNextBrokerHostService,
} from './vnextBrokerHost.js';
import type { VNextBrokerHost } from './vnextBroker.js';

/**
 * Default per-module source cap. Graphs whose modules all fit this (and the
 * total) travel the control frame; larger graphs use the data pipe
 * (Stage F part 11, §15.9). 64 KiB is the practical prototype ceiling.
 */
const DEFAULT_SOURCE_BYTES_LIMIT = 64 * 1024;
/**
 * Default total graph cap. Graphs above the control-frame budget are
 * shipped over the data pipe; this cap keeps the whole graph well below
 * the 256 MiB data-payload bound while bounding worker-side parse cost.
 */
const DEFAULT_GRAPH_BYTES_LIMIT = 256 * 1024;
/** Default total bytes scanned while reading a package directory. */
const DEFAULT_SCAN_BYTES_LIMIT = 8 * 1024 * 1024;
/** Default overall activation timeout (bootstrap + lockdown + graph eval). */
const DEFAULT_ACTIVATION_TIMEOUT_MS = 20_000;
/** How long `deactivate` waits for the WORKER_TERMINATED frame. */
const DEACTIVATE_TIMEOUT_MS = 5_000;

export interface VNextPluginActivationSpec {
  pluginId: string;
  installationId: string;
  /** Absolute path to the installed plugin package (containing plugin.json). */
  packageRoot: string;
  /** Package-relative backend entry id (manifest.backend, e.g. `src/index.js`). */
  entry: string;
  trustLevel?: 'sandbox' | 'extended' | 'trusted';
  allowedNodeBuiltins?: readonly string[];
  allowedDependencies?: readonly string[];
  /** §38 manifest `resources.memoryHintMiB` — advisory emergency-ceiling input. */
  memoryHintMiB?: number;
  /** §39 admin override `maxHeapMiB` — wins over the headroom calculation. */
  maxHeapOverrideMiB?: number;
}

export interface VNextWorkerInfo {
  workerId: number;
  workerEpoch: number;
  pluginId: string;
  installationId: string;
  trustLevel: 'sandbox' | 'extended' | 'trusted';
  lockdownMs: number;
  noNodeAuthority: boolean;
  /** Entry module export names after graph evaluation (§8.6). */
  exportNames: string[];
  /** JSON-safe snapshot of serializable entry exports. */
  snapshot: Record<string, unknown>;
  /** Diagnostic builder warnings (dynamic code/CJS idioms, §6.8). */
  warnings: string[];
  /** SHA-256 of the serialized signed graph. */
  graphDigest: string;
  /** §22: the emergency heap ceiling the worker was spawned with. */
  emergencyLimits?: { maxOldGenerationSizeMb: number; maxYoungGenerationSizeMb: number };
}

/** One plugin console record delivered to the host log router (§9.1.1). */
export interface VNextLogEntry {
  workerId: number;
  /** Resolved from the activation/worker records; `unknown` pre-activation. */
  pluginId: string;
  level: PluginRuntimeLogRecord['level'];
  message: string;
  at: number;
  /** Coalesced identical consecutive records (§9.1.1 rule 3). */
  count?: number;
  /** Synthetic suppressed-record marker: `message` is the [NT] text. */
  suppressed?: number;
}

export interface VNextRuntimeOptions {
  /** Runtime entry override (tests inject a fixture or the built dist). */
  runtimeEntry?: string;
  nodeExecutable?: string;
  stderrSink?: (line: string) => void;
  /**
   * §9.1.1 host log router: one call per plugin console record (batched
   * LOG_BATCH frames decoded once by the client). `suppressed` is set on the
   * synthetic `[NT] N plugin log records suppressed` record the host MUST
   * emit when a batch reports dropped records (rule 9). The router is
   * optional: without it batches are acked and dropped.
   */
  logSink?: (entry: VNextLogEntry) => void;
  /**
   * §9.1.4 fatal diagnostics: the dying worker's bounded envelope. Defaults
   * to routing through `logSink` as an error record so crash attribution is
   * visible even without a dedicated consumer.
   */
  fatalSink?: (body: PluginRuntimeFatalDiagnosticBody, pluginId: string | undefined) => void;
  /** Overall activation timeout in ms. Default 20000. */
  timeoutMs?: number;
  /** Per-module source cap for host-side graph building. Default 64 KiB. */
  graphSourceBytesLimit?: number;
  /** Total serialized graph cap (control/data-pipe transport). Default 256 KiB. */
  graphTotalBytesLimit?: number;
  /** Total bytes read while scanning the package directory. Default 8 MiB. */
  packageScanBytesLimit?: number;
  /**
   * §8.1 persistent module-map cache directory (e.g.
   * `data/cache/plugin-module-maps`). When set, built module graphs are
   * cached on disk keyed by the source digest + Node/SES/Endo/loader
   * versions; the cache is fully removable and rebuilds automatically.
   */
  moduleMapCacheDir?: string;
  /** Injectable fetch for the `network.http.fetch` executor (tests stub SSRF edges). */
  fetchImpl?: typeof fetch;
  /** Injectable DNS lookup for the SSRF policy (tests avoid real lookups). */
  dnsLookupImpl?: (hostname: string) => Promise<string[]>;
  /** §29.1.5 secret registry (opaque handles → bound origin + headers). */
  networkSecrets?: Readonly<Record<string, { origin: string; headers: Record<string, string> }>>;
  /** §29 proxy: executor-level proxy URL (http:// or https://). */
  proxyUrl?: string;
  /**
   * §29.1.1 scope capabilities override (tests). Production derives the scope
   * from the DB grants via the broker's default provider.
   */
  networkScopeProvider?: (pluginId: string) => {
    local: boolean;
    private: boolean;
    metadata: boolean;
  };
  /**
   * §30 Files API: plugin-owned data directory resolver. Production wires
   * `join(pluginsRoot, pluginId, 'data')`; every `files.*` operation is
   * confined to the resolved root.
   */
  filesRoot?: (pluginId: string) => string;
  /**
   * §32.1 process API: scoped-mode policy. Absent = reference default
   * (current Node executable inside the plugin's files root).
   */
  processScope?: (pluginId: string) => {
    executables: string[];
    cwdRoots: string[];
    defaultCwd: string;
  };
  /**
   * §33 Secrets API: host-side provider. Defaults to the OAuth-repo-backed
   * provider; tests inject a stub.
   */
  secretsProvider?: MemoryHostOptions['secretsProvider'];
  /**
   * §33: bound-origin resolver (serviceId → origin). Defaults to reading
   * the plugin manifest's declared `authClients` authorization URL.
   */
  secretOriginResolver?: (pluginId: string, serviceId: string) => string | null;
}

export interface VNextRuntimeService {
  /** Spawn a worker for the plugin, ship its graph and await module load. */
  activate(spec: VNextPluginActivationSpec): Promise<VNextWorkerInfo>;
  /** Terminate the plugin's worker and await the WORKER_TERMINATED frame. */
  deactivate(pluginId: string): Promise<void>;
  isActive(pluginId: string): boolean;
  activePlugins(): string[];
  /** Host-driven revocation: abort in-flight calls and notify the runtime. */
  revoke(pluginId: string, name?: string, reason?: string): number;
  /** Emit an event into the §18 core; live subscriptions are pushed. */
  emitEvent(name: string, payload: unknown): void;
  /** Abort everything in-flight and terminate the runtime process. */
  shutdown(): Promise<void>;
}

interface PendingActivation {
  spec: VNextPluginActivationSpec;
  workerId: number;
  graph: PluginModuleGraph;
  graphDigest: string;
  warnings: string[];
  ready: PluginRuntimeWorkerReady | undefined;
  resolve: (info: VNextWorkerInfo) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

interface ModuleGraphLoadedMessage {
  kind: 'module-graph-loaded';
  workerId: number;
  workerEpoch: number;
  exportNames: string[];
  /**
   * JSON-safe snapshot of serializable entry exports. The worker omits it
   * (and sets `snapshotOmitted`) when it exceeds the wire bound so a huge
   * export cannot blow the BRIDGE_MESSAGE control frame.
   */
  snapshot?: Record<string, unknown>;
  snapshotOmitted?: boolean;
}

interface ModuleGraphErrorMessage {
  kind: 'module-graph-error';
  workerId: number;
  workerEpoch: number;
  code: string;
  message: string;
}

/** Normalize `manifest.backend` to a package-relative posix id. */
function normalizeEntry(entry: string): string {
  let id = entry.trim();
  while (id.startsWith('./')) id = id.slice(2);
  if (id.startsWith('/') || id.includes('..')) {
    throw new AppError({
      code: ErrorCodes.PLUGIN_INVALID,
      params: { entry, reason: 'ENTRY_ESCAPES_PACKAGE' },
    });
  }
  if (id.length === 0) {
    throw new AppError({
      code: ErrorCodes.PLUGIN_INVALID,
      params: { reason: 'EMPTY_ENTRY' },
    });
  }
  return id;
}

function graphLoadError(code: string, message: string): AppError {
  return new AppError({
    code: ErrorCodes.PLUGIN_LOAD_FAILED,
    params: { moduleErrorCode: code, moduleMessage: message },
    message: `plugin module graph failed to load: ${code}`,
  });
}

export function createVNextRuntimeService(
  ctx: VNextBrokerHost,
  options: VNextRuntimeOptions = {},
): VNextRuntimeService {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
  const sourceBytesLimit = options.graphSourceBytesLimit ?? DEFAULT_SOURCE_BYTES_LIMIT;
  const graphBytesLimit = options.graphTotalBytesLimit ?? DEFAULT_GRAPH_BYTES_LIMIT;
  const scanBytesLimit = options.packageScanBytesLimit ?? DEFAULT_SCAN_BYTES_LIMIT;

  let client: PluginRuntimeClient | undefined;
  let clientPromise: Promise<PluginRuntimeClient> | undefined;
  let nextWorkerId = 0;
  const moduleMapCache =
    options.moduleMapCacheDir !== undefined
      ? new ModuleMapDiskCache(options.moduleMapCacheDir)
      : undefined;
  /**
   * §20.13 runtime generations: incremented for every spawned runtime
   * process so frames from a previous generation are distinguishable
   * (§25.2). The runtime is blank after a restart — workers are recreated
   * by the host on demand, never restored automatically.
   */
  let runtimeGeneration = 0;
  /** True while `shutdown()` is terminating the runtime: the exit event of
   * that process is graceful and must not be treated as a crash. */
  let shuttingDown = false;
  const pending = new Map<number, PendingActivation>();
  const workers = new Map<number, VNextWorkerInfo>();
  const pluginWorkers = new Map<string, number>();

  // Transport resolves lazily: the client may not exist yet when the broker
  // host is constructed (runtime spawn is on-demand).
  const host: VNextBrokerHostService = createVNextBrokerHost(
    ctx,
    {
      sendRpcResponse: (body) => {
        const c = client;
        if (c === undefined) {
          throw new Error('plugin runtime is not started');
        }
        c.sendRpcResponse(body);
      },
      sendBrokerRevoke: (body) => {
        client?.sendBrokerRevoke(body);
      },
      sendHostBridgeMessage: (body) => {
        client?.sendHostBridgeMessage(body);
      },
    },
    {
      fetchImpl: options.fetchImpl,
      dnsLookupImpl: options.dnsLookupImpl,
      networkSecrets: options.networkSecrets,
      proxyUrl: options.proxyUrl,
      networkScopeProvider: options.networkScopeProvider,
      filesRoot: options.filesRoot,
      processScope: options.processScope,
      secretsProvider: options.secretsProvider,
      secretOriginResolver: options.secretOriginResolver,
    },
  );

  async function ensureClient(): Promise<PluginRuntimeClient> {
    if (client !== undefined) return client;
    // A new spawn means a new runtime generation (§20.13): stale frames from
    // an earlier process carry an older epoch and are dropped (§25.2).
    shuttingDown = false;
    const generation = ++runtimeGeneration;
    clientPromise ??= PluginRuntimeClient.start({
      runtimeEpoch: generation,
      nodeExecutable: options.nodeExecutable,
      runtimeEntry: options.runtimeEntry,
      stderrSink: options.stderrSink,
      telemetryMs: 5_000,
      timeoutMs,
    })
      .then((c) => {
        client = c;
        attachVNextBrokerHost(c, host);
        c.on('workerReady', (ready) => handleWorkerReady(ready));
        c.on('bridgeMessage', (body) => handleBridgeMessage(body));
        c.on('workerTerminated', (info) => handleWorkerTerminated(info));
        c.on('logBatch', (batch) => handleLogBatch(batch));
        c.on('fatalDiagnostic', (body) => handleFatalDiagnostic(body));
        // §20.13: a crashed runtime resets host state (workers are gone) and
        // is restarted on demand by the next activation — never by
        // immediately re-activating every previously warm plugin.
        c.on('exit', (info) => handleRuntimeExit(info.code));
        return c;
      })
      .catch((error) => {
        clientPromise = undefined;
        throw new AppError({
          code: ErrorCodes.PLUGIN_RUNTIME_UNAVAILABLE,
          params: { reason: 'spawn-failed' },
          message: 'plugin runtime failed to start',
          cause: error,
        });
      });
    return clientPromise;
  }

  /**
   * §20.13 runtime crash recovery. The process is gone: reject every pending
   * activation (their workers died with it), prune broker subscriptions and
   * drop the active-worker state — plugins become cold and reactivate on the
   * next demand (event/route/command), paced by normal activation admission.
   */
  function handleRuntimeExit(code: number | null): void {
    if (shuttingDown) return;
    options.stderrSink?.(
      `[plugin-runtime] process exited unexpectedly (code=${String(code)}) — worker state reset; plugins reactivate on demand (§20.13)`,
    );
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(
        new AppError({
          code: ErrorCodes.PLUGIN_RUNTIME_CRASHED,
          params: { reason: 'runtime-process-exited', code: code ?? null },
        }),
      );
    }
    pending.clear();
    for (const info of workers.values()) {
      host.workerTerminated(info.workerId);
    }
    workers.clear();
    pluginWorkers.clear();
    client = undefined;
    clientPromise = undefined;
  }

  function handleWorkerReady(ready: PluginRuntimeWorkerReady): void {
    const entry = pending.get(ready.workerId);
    if (entry === undefined || entry.ready !== undefined) return;
    entry.ready = ready;
    // §15.8: the signed graph travels AFTER hardened-ready; the epoch is now
    // known, so the runtime can verify the MODULE_GRAPH header matches.
    const c = client;
    if (c === undefined) return;
    c.sendModuleGraph({ workerId: ready.workerId, workerEpoch: ready.workerEpoch }, entry.graph);
  }

  function handleBridgeMessage(body: PluginRuntimeBridgeMessageBody): void {
    const entry = pending.get(body.workerId);
    if (entry === undefined) return;
    const message = body.message as { kind?: unknown } | null;
    const kind = message?.kind;
    if (kind === 'module-graph-loaded') {
      finishActivation(entry, true, {
        exportNames: (body.message as ModuleGraphLoadedMessage).exportNames,
        snapshot: (body.message as ModuleGraphLoadedMessage).snapshot ?? {},
      });
    } else if (kind === 'module-graph-error') {
      const errorMessage = body.message as Partial<ModuleGraphErrorMessage>;
      finishActivation(
        entry,
        false,
        undefined,
        graphLoadError(
          errorMessage.code ?? 'MODULE_EVALUATION_FAILED',
          errorMessage.message ?? 'unknown module error',
        ),
      );
    }
  }

  function finishActivation(
    entry: PendingActivation,
    ok: boolean,
    loaded?: { exportNames: string[]; snapshot: Record<string, unknown> },
    error?: unknown,
  ): void {
    if (pending.get(entry.workerId) !== entry) return;
    pending.delete(entry.workerId);
    clearTimeout(entry.timer);
    if (!ok) {
      client?.terminateWorker(entry.workerId, 'activation failed');
      entry.reject(error);
      return;
    }
    const ready = entry.ready;
    if (ready === undefined) {
      client?.terminateWorker(entry.workerId, 'activation failed (no ready)');
      entry.reject(
        new AppError({
          code: ErrorCodes.PLUGIN_LOAD_FAILED,
          params: { reason: 'worker-ready-missing' },
        }),
      );
      return;
    }
    const info: VNextWorkerInfo = {
      workerId: ready.workerId,
      workerEpoch: ready.workerEpoch,
      pluginId: ready.pluginId,
      installationId: ready.installationId,
      trustLevel: entry.spec.trustLevel ?? 'sandbox',
      lockdownMs: ready.lockdownMs,
      noNodeAuthority: ready.noNodeAuthority,
      exportNames: loaded?.exportNames ?? [],
      snapshot: loaded?.snapshot ?? {},
      warnings: entry.warnings,
      graphDigest: entry.graphDigest,
      ...(ready.emergencyLimits !== undefined ? { emergencyLimits: ready.emergencyLimits } : {}),
    };
    workers.set(info.workerId, info);
    pluginWorkers.set(info.pluginId, info.workerId);
    entry.resolve(info);
  }

  /**
   * §9.1.1 host log router: attribute records to the plugin, emit the
   * synthetic suppressed-record when the batch reports drops (rule 9), then
   * ack so the worker's flush credit is replenished. Without a logSink the
   * batch is still acked — a wedged log channel must not wedge the plugin.
   */
  function handleLogBatch(
    batch: PluginRuntimeLogBatchPayload & {
      workerId: number;
      workerEpoch: number;
    },
  ): void {
    const worker = workers.get(batch.workerId);
    const pluginId = worker?.pluginId ?? pending.get(batch.workerId)?.spec.pluginId ?? '<unknown>';
    const sink = options.logSink;
    if (sink !== undefined) {
      for (const record of batch.records) {
        sink({
          workerId: batch.workerId,
          pluginId,
          level: record.level,
          message: record.message,
          at: record.at,
          ...(record.count !== undefined ? { count: record.count } : {}),
        });
      }
      if (batch.droppedCount > 0) {
        // §9.1.1 rule 9: the host MUST emit the synthetic suppressed record.
        sink({
          workerId: batch.workerId,
          pluginId,
          level: 'warn',
          message: `[NT] ${batch.droppedCount.toLocaleString('en-US')} plugin log records suppressed`,
          at: Date.now(),
          suppressed: batch.droppedCount,
        });
      }
    }
    const c = client;
    if (c !== undefined) {
      c.sendLogBatchAck({
        workerId: batch.workerId,
        workerEpoch: batch.workerEpoch,
        seq: batch.seq,
      });
    }
  }

  /** §9.1.4: route the dying worker's bounded envelope to the host. */
  function handleFatalDiagnostic(body: PluginRuntimeFatalDiagnosticBody): void {
    const pluginId =
      workers.get(body.workerId)?.pluginId ?? pending.get(body.workerId)?.spec.pluginId;
    const fatalSink = options.fatalSink;
    if (fatalSink !== undefined) {
      fatalSink(body, pluginId);
      return;
    }
    // Default: make the crash visible through the ordinary log router.
    options.logSink?.({
      workerId: body.workerId,
      pluginId: pluginId ?? '<unknown>',
      level: 'error',
      message: `plugin fatal ${body.envelope.kind}: ${body.envelope.name}: ${body.envelope.message}`,
      at: Date.now(),
    });
  }

  function handleWorkerTerminated(info: PluginRuntimeWorkerTerminated): void {
    host.workerTerminated(info.workerId);
    const entry = pending.get(info.workerId);
    if (entry !== undefined) {
      // The worker died before its graph finished loading.
      pending.delete(info.workerId);
      clearTimeout(entry.timer);
      entry.reject(
        new AppError({
          code: ErrorCodes.PLUGIN_LOAD_FAILED,
          params: { reason: 'worker-exited-before-ready' },
        }),
      );
      return;
    }
    const worker = workers.get(info.workerId);
    if (worker === undefined || worker.workerEpoch !== info.workerEpoch) return;
    workers.delete(info.workerId);
    pluginWorkers.delete(worker.pluginId);
  }

  async function readPackageFiles(packageRoot: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    let scannedBytes = 0;
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        // Dot entries (.git, .rollback-*, .incoming-*) never belong to the
        // module graph; node_modules stays walkable for allowed dependencies.
        if (entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const info = await stat(full);
        scannedBytes += info.size;
        if (scannedBytes > scanBytesLimit) {
          throw new AppError({
            code: ErrorCodes.PLUGIN_LOAD_FAILED,
            params: { reason: 'package-scan-limit-exceeded', limitBytes: scanBytesLimit },
          });
        }
        if (info.size > sourceBytesLimit) {
          throw new AppError({
            code: ErrorCodes.PLUGIN_LOAD_FAILED,
            params: {
              reason: 'module-source-too-large',
              file: entry.name,
              sizeBytes: info.size,
              limitBytes: sourceBytesLimit,
            },
          });
        }
        const rel = relative(packageRoot, full).replaceAll('\\', '/');
        files.set(rel, await readFile(full, 'utf8'));
      }
    };
    await walk(packageRoot);
    return files;
  }

  async function buildGraph(spec: VNextPluginActivationSpec): Promise<{
    graph: PluginModuleGraph;
    graphDigest: string;
    warnings: string[];
  }> {
    const entry = normalizeEntry(spec.entry);
    const files = await readPackageFiles(spec.packageRoot);
    // §8.1 persistent module-map cache: keyed by the canonical SOURCE digest
    // plus every component that shapes the compiled form (Node/SES/Endo/
    // loader versions). Any upgrade invalidates; a miss rebuilds from source.
    const sourceDigest = packageSourceDigest(files);
    const cached = await moduleMapCache?.get(sourceDigest);
    if (cached !== undefined) {
      const serialized = JSON.stringify(cached.graph);
      const bytes = Buffer.byteLength(serialized, 'utf8');
      if (bytes > graphBytesLimit) {
        throw new AppError({
          code: ErrorCodes.PLUGIN_LOAD_FAILED,
          params: { reason: 'graph-too-large', sizeBytes: bytes, limitBytes: graphBytesLimit },
        });
      }
      return { graph: cached.graph, graphDigest: sha256Hex(serialized), warnings: cached.warnings };
    }
    const source: PluginPackageSource = {
      pluginId: spec.pluginId,
      entry,
      files,
    };
    const { graph, warnings } = buildModuleGraph(source, {
      allowedNodeBuiltins: spec.allowedNodeBuiltins ?? [],
      allowedDependencies: spec.allowedDependencies ?? [],
      maxSourceBytes: sourceBytesLimit,
    });
    const serialized = JSON.stringify(graph);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > graphBytesLimit) {
      throw new AppError({
        code: ErrorCodes.PLUGIN_LOAD_FAILED,
        params: { reason: 'graph-too-large', sizeBytes: bytes, limitBytes: graphBytesLimit },
      });
    }
    await moduleMapCache?.put(sourceDigest, { graph, warnings });
    return { graph, graphDigest: sha256Hex(serialized), warnings };
  }

  return {
    async activate(spec) {
      if (pluginWorkers.has(spec.pluginId)) {
        throw new AppError({
          code: ErrorCodes.PLUGIN_LOAD_FAILED,
          params: { pluginId: spec.pluginId, reason: 'already-active' },
        });
      }
      const { graph, graphDigest, warnings } = await buildGraph(spec);
      const c = await ensureClient();
      const workerId = ++nextWorkerId;
      return new Promise<VNextWorkerInfo>((resolveAct, rejectAct) => {
        const entry: PendingActivation = {
          spec,
          workerId,
          graph,
          graphDigest,
          warnings,
          ready: undefined,
          resolve: resolveAct,
          reject: rejectAct,
          timer: setTimeout(() => {
            if (pending.get(workerId) !== entry) return;
            pending.delete(workerId);
            c.terminateWorker(workerId, 'activation timeout');
            rejectAct(
              new AppError({
                code: ErrorCodes.PLUGIN_LOAD_FAILED,
                params: { pluginId: spec.pluginId, reason: 'activation-timeout' },
              }),
            );
          }, timeoutMs),
        };
        pending.set(workerId, entry);
        try {
          c.spawnWorker({
            workerId,
            pluginId: spec.pluginId,
            installationId: spec.installationId,
            moduleGraphDigest: graphDigest,
            memoryHintMiB: spec.memoryHintMiB,
            maxHeapOverrideMiB: spec.maxHeapOverrideMiB,
          });
        } catch (error) {
          // The runtime process died between ensureClient() and the spawn
          // (crash race, §20.13): the exit handler may already have rejected
          // this entry, so only fail if it is still ours.
          if (pending.get(workerId) !== entry) return;
          pending.delete(workerId);
          clearTimeout(entry.timer);
          rejectAct(
            new AppError({
              code: ErrorCodes.PLUGIN_RUNTIME_CRASHED,
              params: { pluginId: spec.pluginId, reason: 'runtime-process-exited' },
              cause: error,
            }),
          );
        }
      });
    },

    async deactivate(pluginId) {
      const workerId = pluginWorkers.get(pluginId);
      const worker = workerId === undefined ? undefined : workers.get(workerId);
      if (workerId === undefined || worker === undefined) return;
      const c = await ensureClient().catch(() => undefined);
      if (c === undefined) return;
      c.terminateWorker(workerId, 'plugin deactivated');
      await new Promise<void>((resolveTerm) => {
        const timer = setTimeout(resolveTerm, DEACTIVATE_TIMEOUT_MS);
        const onTerminated = (info: PluginRuntimeWorkerTerminated): void => {
          if (info.workerId === workerId) {
            clearTimeout(timer);
            c.off('workerTerminated', onTerminated);
            resolveTerm();
          }
        };
        c.on('workerTerminated', onTerminated);
      });
    },

    isActive(pluginId) {
      return pluginWorkers.has(pluginId);
    },

    activePlugins() {
      return [...pluginWorkers.keys()];
    },

    revoke(pluginId, name, reason) {
      return host.revoke(pluginId, name, reason);
    },

    emitEvent(name, payload) {
      host.emitEvent(name, payload);
    },

    async shutdown() {
      host.shutdown();
      shuttingDown = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('plugin runtime shutdown'));
      }
      pending.clear();
      workers.clear();
      pluginWorkers.clear();
      const c = client;
      client = undefined;
      clientPromise = undefined;
      if (c !== undefined) {
        await c.terminate().catch(() => undefined);
      }
    },
  };
}
