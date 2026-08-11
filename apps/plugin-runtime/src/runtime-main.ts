/**
 * Plugin Runtime process entry (ТЗ v3.2 §15–§20; ADR-0027/0028).
 *
 * Spawned by the Main Host (see host/runtimeClient.ts). Owns the Worker
 * supervisor, the framed control channel (stdin/stdout) plus separated data
 * pipes (fd3/fd4, §15.9), the telemetry loop (§40) and the terminate
 * lifecycle. stdout is protocol-only (§15.5): runtime logs go to stderr.
 */
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import type {
  PluginRuntimeBridgeMessageBody,
  PluginRuntimeBrokerRevokeBody,
  PluginRuntimeFatalDiagnosticBody,
  PluginRuntimeFatalEnvelope,
  PluginRuntimeFrame,
  PluginRuntimeFrameTypeValue,
  PluginRuntimeHello,
  PluginRuntimeHelloAck,
  PluginRuntimeLogBatchAckBody,
  PluginRuntimeModuleGraphBody,
  PluginRuntimeRpcRequestBody,
  PluginRuntimeRpcRequestDataBody,
  PluginRuntimeRpcResponseBody,
  PluginRuntimeTelemetry,
  PluginRuntimeWorkerReady,
  PluginRuntimeWorkerSpawn,
  PluginRuntimeWorkerTerminate,
  PluginRuntimeWorkerTerminated,
} from '@neotavern/contracts';
import {
  PLUGIN_RUNTIME_LOG_BATCH_MAX_BYTES,
  PLUGIN_RUNTIME_MAX_DATA_PAYLOAD_BYTES,
  PLUGIN_RUNTIME_PROTOCOL_VERSION,
  PluginRuntimeFrameFlag,
  PluginRuntimeFrameParser,
  PluginRuntimeFrameType,
  decodeControlBody,
  encodeControlFrame,
  encodeDataFrame,
} from '@neotavern/contracts';
import { parseRuntimeEnv } from './env.js';
import { WorkerSupervisor, type WorkerReadyInfo } from './supervisor.js';
import { createBrokerGateway } from './broker/brokerGateway.js';
import { createHostForwardingCore } from './broker/hostForwardingCore.js';

/**
 * Bounded, backpressure-aware control outbox (§15.5): frames never queue
 * unboundedly behind a slow host reader; excess frames are dropped and
 * counted, and diagnostics stay on stderr.
 *
 * Uses a boolean `running` gate rather than a stored pump promise: an async
 * pump that resets the promise in its `finally` would be overwritten by the
 * caller's `??=` assignment, leaving a stale non-null promise that blocks
 * every later push. With a plain boolean the loop re-triggers itself in
 * `finally` when work arrived while draining, so no wakeup is lost.
 */
class ControlOutbox {
  private readonly pending: Uint8Array[] = [];
  private readonly maxPending: number;
  private running = false;
  private drainResolvers: Array<() => void> = [];
  dropped = 0;

  constructor(
    private readonly stream: NodeJS.WritableStream,
    maxPending = 64,
  ) {
    this.maxPending = maxPending;
  }

  push(bytes: Uint8Array): void {
    if (this.pending.length >= this.maxPending) {
      this.dropped += 1;
      return;
    }
    this.pending.push(bytes);
    void this.pump();
  }

  /** Resolves once every queued frame has been handed to the stream. */
  drained(): Promise<void> {
    if (this.pending.length === 0 && !this.running) return Promise.resolve();
    return new Promise((resolveDrained) => {
      this.drainResolvers.push(resolveDrained);
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const bytes = this.pending[0];
        if (bytes === undefined) break;
        if (!this.stream.write(bytes)) {
          await new Promise<void>((resolveDrain) => this.stream.once('drain', resolveDrain));
        }
        this.pending.shift();
      }
    } catch (error) {
      process.stderr.write(`[neotavern-plugin-runtime] outbox error: ${String(error)}\n`);
    } finally {
      this.running = false;
      if (this.pending.length > 0) {
        void this.pump();
      } else {
        this.notifyDrained();
      }
    }
  }

  private notifyDrained(): void {
    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    for (const resolveDrained of resolvers) resolveDrained();
  }
}

const env = parseRuntimeEnv();
const { runtimeEpoch } = env;

// Broker calls relay host-ward: the worker bridge posts `rpc-request`, the
// gateway admits the envelope and the forwarding core ships it as an
// RPC_REQUEST frame; the host's RPC_RESPONSE settles the worker-side promise
// (ADR-0027: the decision authority lives in Main Host).
const brokerCore = createHostForwardingCore({
  sendRpcRequest: (body: PluginRuntimeRpcRequestBody) => {
    sendControlFrame(PluginRuntimeFrameType.RPC_REQUEST, body);
  },
  // Stage F part 13: large call args travel the fd 4 data pipe. The payload
  // stays opaque — the host is the single decode point (§15.1). A congested
  // outbox fails the call with backpressure instead of buffering unboundedly.
  sendRpcRequestData: (body: PluginRuntimeRpcRequestDataBody) => {
    sendOpaqueDataFrame(
      PluginRuntimeFrameType.RPC_REQUEST_DATA,
      body.workerId,
      body.workerEpoch,
      body.payloadBytes,
    );
  },
});
const brokerGateway = createBrokerGateway(brokerCore);

const supervisor = new WorkerSupervisor(
  {
    onWorkerReady: (info: WorkerReadyInfo) => {
      sendControlFrame(PluginRuntimeFrameType.WORKER_READY, toWorkerReadyBody(info));
    },
    onWorkerLog: (entry) => {
      process.stderr.write(`[worker ${entry.workerId}] ${entry.level}: ${entry.message}\n`);
    },
    onWorkerExit: (info) => {
      brokerCore.abortWorker(info.workerId, info.workerEpoch);
      // §9.1.4: attach the retained fatal envelope (if any) so a crash is
      // attributable even when the FATAL_DIAGNOSTIC frame raced the exit.
      const fatal = lastFatalDiagnostics.get(info.workerId);
      sendControlFrame(
        PluginRuntimeFrameType.WORKER_TERMINATED,
        toWorkerTerminatedBody(info, fatal?.envelope),
      );
    },
    onWorkerError: (info) => {
      process.stderr.write(`[worker ${info.workerId}] error: ${String(info.error)}\n`);
    },
  },
  {
    onBridgeMessage: (record, message) => {
      // §9.1.1 log batches: the worker encoded the batch once; the runtime
      // forwards it opaque to the LOG_BATCH frame — the host is the single
      // decode point (§15.1). Worker identity rides the frame header; the
      // payload is bounded (the worker enforces the batch cap, this check
      // is defense-in-depth for the control pipe).
      if (message !== null && typeof message === 'object' && 'kind' in message) {
        if (message.kind === 'log-batch') {
          const batch = message as {
            workerId?: unknown;
            workerEpoch?: unknown;
            payloadBytes?: unknown;
          };
          const payload = batch.payloadBytes;
          if (
            batch.workerId === record.workerId &&
            batch.workerEpoch === record.workerEpoch &&
            payload instanceof Uint8Array &&
            payload.byteLength <= PLUGIN_RUNTIME_LOG_BATCH_MAX_BYTES
          ) {
            outbox.push(
              encodeDataFrame(
                {
                  protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
                  frameType: PluginRuntimeFrameType.LOG_BATCH,
                  flags: 0,
                  runtimeEpoch,
                  workerId: record.workerId,
                  workerEpoch: record.workerEpoch,
                  requestId: 0,
                },
                payload,
              ),
            );
          }
          return;
        }
        // §9.1.4 fatal diagnostics: forwarded immediately on the reserved
        // FATAL_DIAGNOSTIC path (never credit-gated) and retained so the
        // WORKER_TERMINATED frame can carry the envelope if the worker dies
        // before the host consumed the frame.
        if (message.kind === 'fatal-diagnostic') {
          const fatal = message as {
            workerId?: unknown;
            workerEpoch?: unknown;
            envelope?: unknown;
          };
          const envelope = fatal.envelope;
          if (
            fatal.workerId === record.workerId &&
            fatal.workerEpoch === record.workerEpoch &&
            envelope !== null &&
            typeof envelope === 'object' &&
            isFatalEnvelope(envelope)
          ) {
            const body: PluginRuntimeFatalDiagnosticBody = {
              workerId: record.workerId,
              workerEpoch: record.workerEpoch,
              envelope,
            };
            lastFatalDiagnostics.set(record.workerId, body);
            sendControlFrame(PluginRuntimeFrameType.FATAL_DIAGNOSTIC, body);
          }
          return;
        }
      }
      // Broker-level messages are consumed by the gateway; app-level ones
      // (module-graph-loaded/error today, live delivery in Stage F) travel
      // host-ward as BRIDGE_MESSAGE frames so the host can resolve
      // activations and observe plugin traffic (§15.1: payload stays opaque).
      if (!brokerGateway.handleBridgeMessage(record, message)) {
        sendControlFrame(PluginRuntimeFrameType.BRIDGE_MESSAGE, {
          workerId: record.workerId,
          workerEpoch: record.workerEpoch,
          message,
        } satisfies PluginRuntimeBridgeMessageBody);
      }
    },
  },
);

/**
 * §9.1.4: last bounded fatal envelope per worker, kept independently of the
 * log path so a crash is attributable even if the worker died before its
 * FATAL_DIAGNOSTIC frame reached the host.
 */
const lastFatalDiagnostics = new Map<number, PluginRuntimeFatalDiagnosticBody>();

/** Minimal shape guard for the worker-produced fatal envelope. */
function isFatalEnvelope(value: object): value is PluginRuntimeFatalEnvelope {
  const envelope = value as { kind?: unknown; name?: unknown; message?: unknown };
  return (
    (envelope.kind === 'uncaught-exception' || envelope.kind === 'unhandled-rejection') &&
    typeof envelope.name === 'string' &&
    typeof envelope.message === 'string'
  );
}

const controlIn = new PluginRuntimeFrameParser();
const dataIn = new PluginRuntimeFrameParser({
  maxPayloadBytes: PLUGIN_RUNTIME_MAX_DATA_PAYLOAD_BYTES,
});
const outbox = new ControlOutbox(process.stdout);
// Runtime -> host data pipe (fd 4, §15.9): opened in openDataPipes. Frames
// serialize on a single write chain so kernel backpressure paces the next
// frame; a bounded queue rejects when the pipe is congested.
let dataOut: net.Socket | undefined;
let dataWriteTail: Promise<void> = Promise.resolve();
let dataQueuedFrames = 0;
const DATA_OUT_MAX_QUEUED_FRAMES = 8;
let connected = false;
let shuttingDown = false;

process.stderr.write(
  `[neotavern-plugin-runtime] pid=${process.pid} epoch=${runtimeEpoch} id=${env.runtimeId}\n`,
);

// Handshake (runtime -> host): announce identity and capabilities (§15.2).
sendControlFrame(PluginRuntimeFrameType.HELLO, {
  protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
  runtimeEpoch,
  pid: process.pid,
  capabilities: ['framed-control', 'data-pipes'],
} satisfies PluginRuntimeHello);

process.stdin.on('data', (chunk: Buffer) => {
  let frames: PluginRuntimeFrame[];
  try {
    frames = controlIn.push(chunk);
  } catch (error) {
    reportProtocolError(error);
    return;
  }
  for (const frame of frames) handleHostFrame(frame);
});
process.stdin.on('end', () => {
  // Host closed its control pipe: it is gone or shutting down.
  shutdownDiagnostics('stdin closed');
  void shutdownAndExit();
});
process.stdin.on('error', (error: unknown) => {
  process.stderr.write(`[neotavern-plugin-runtime] stdin error: ${String(error)}\n`);
});
process.stdout.on('error', (error: unknown) => {
  // EPIPE after the host died: nothing to keep us alive for.
  process.stderr.write(`[neotavern-plugin-runtime] stdout error: ${String(error)}\n`);
  void shutdownAndExit();
});

openDataPipes();

const telemetryTimer = setInterval(() => {
  if (connected && !shuttingDown) {
    sendControlFrame(PluginRuntimeFrameType.TELEMETRY, collectTelemetry());
  }
}, env.telemetryMs);

process.on('SIGTERM', () => {
  void shutdownAndExit();
});
process.on('SIGINT', () => {
  void shutdownAndExit();
});

function handleHostFrame(frame: PluginRuntimeFrame): void {
  switch (frame.header.frameType) {
    case PluginRuntimeFrameType.HELLO_ACK:
      handleHelloAck(frame);
      break;
    case PluginRuntimeFrameType.WORKER_SPAWN:
      handleSpawn(frame);
      break;
    case PluginRuntimeFrameType.WORKER_TERMINATE:
      handleWorkerTerminate(frame);
      break;
    case PluginRuntimeFrameType.PING:
      sendControlFrame(PluginRuntimeFrameType.PONG, collectTelemetry(), {
        requestId: frame.header.requestId,
      });
      break;
    case PluginRuntimeFrameType.RPC_RESPONSE: {
      const body = decodeControlBody(frame.payload) as PluginRuntimeRpcResponseBody;
      if (!brokerCore.handleRpcResponse(body)) {
        process.stderr.write(
          `[neotavern-plugin-runtime] unmatched RPC_RESPONSE for requestId=${String(body.requestId)}\n`,
        );
      }
      break;
    }
    case PluginRuntimeFrameType.BROKER_REVOKE: {
      const body = decodeControlBody(frame.payload) as PluginRuntimeBrokerRevokeBody;
      brokerGateway.revoke(body.pluginId, body.name, body.reason);
      break;
    }
    case PluginRuntimeFrameType.MODULE_GRAPH:
      handleModuleGraph(frame);
      break;
    case PluginRuntimeFrameType.LOG_BATCH_ACK:
      handleLogBatchAck(frame);
      break;
    case PluginRuntimeFrameType.HOST_BRIDGE_MESSAGE:
      handleHostBridgeMessage(frame);
      break;
    case PluginRuntimeFrameType.TERMINATE:
      void shutdownAndExit();
      break;
    default:
      reportProtocolError(
        new Error(`unexpected host frame type ${String(frame.header.frameType)}`),
      );
  }
}

function handleHelloAck(frame: PluginRuntimeFrame): void {
  const body = decodeControlBody(frame.payload) as PluginRuntimeHelloAck;
  if (!body.accepted) {
    process.stderr.write(
      `[neotavern-plugin-runtime] handshake rejected: ${body.reason ?? 'unknown reason'}\n`,
    );
    process.exit(1);
  }
  if (body.runtimeEpoch !== runtimeEpoch) {
    process.stderr.write(
      `[neotavern-plugin-runtime] epoch mismatch: host=${body.runtimeEpoch} ours=${runtimeEpoch}\n`,
    );
  }
  connected = true;
}

function handleSpawn(frame: PluginRuntimeFrame): void {
  const body = decodeControlBody(frame.payload) as PluginRuntimeWorkerSpawn;
  if (
    !Number.isInteger(body.workerId) ||
    typeof body.pluginId !== 'string' ||
    typeof body.installationId !== 'string'
  ) {
    reportProtocolError(new Error('malformed WORKER_SPAWN body'));
    return;
  }
  try {
    const record = supervisor.spawnWorker({
      workerId: body.workerId,
      pluginId: body.pluginId,
      installationId: body.installationId,
      moduleGraphDigest: body.moduleGraphDigest,
      memoryHintMiB: body.memoryHintMiB,
      maxHeapOverrideMiB: body.maxHeapOverrideMiB,
    });
    process.stderr.write(
      `[neotavern-plugin-runtime] spawned worker ${record.workerId} (epoch ${record.workerEpoch})\n`,
    );
  } catch (error) {
    reportProtocolError(error);
  }
}

function handleWorkerTerminate(frame: PluginRuntimeFrame): void {
  const body = decodeControlBody(frame.payload) as PluginRuntimeWorkerTerminate;
  if (!Number.isInteger(body.workerId)) {
    reportProtocolError(new Error('malformed WORKER_TERMINATE body'));
    return;
  }
  void supervisor.terminateWorker(body.workerId, body.reason).then(() => {
    process.stderr.write(`[neotavern-plugin-runtime] worker ${body.workerId} terminated\n`);
  });
}

function handleModuleGraph(frame: PluginRuntimeFrame): void {
  const body = decodeControlBody(frame.payload) as PluginRuntimeModuleGraphBody;
  if (!Number.isInteger(body.workerId) || !Number.isInteger(body.workerEpoch)) {
    reportProtocolError(new Error('malformed MODULE_GRAPH body'));
    return;
  }
  const record = supervisor.getRecord(body.workerId);
  if (record === undefined) {
    reportProtocolError(new Error(`MODULE_GRAPH for unknown worker ${String(body.workerId)}`));
    return;
  }
  if (record.workerEpoch !== body.workerEpoch) {
    reportProtocolError(
      new Error(
        `MODULE_GRAPH epoch mismatch for worker ${String(body.workerId)}: ` +
          `host=${body.workerEpoch} ours=${record.workerEpoch}`,
      ),
    );
    return;
  }
  // §15.8: the signed graph arrives over the transport, never via
  // workerData. The worker validates shape and per-module digests.
  record.control.postMessage({ kind: 'load-module-graph', graph: body.graph });
}

/**
 * §9.1.1 credit ack (host -> worker via the runtime): the host consumed a
 * LOG_BATCH; the worker replenishes its flush credit. The runtime validates
 * the worker identity/epoch and forwards a small `log-batch-ack` bridge
 * message; a stale ack (racing a restart) is dropped like a late response.
 */
function handleLogBatchAck(frame: PluginRuntimeFrame): void {
  let body: PluginRuntimeLogBatchAckBody;
  try {
    body = decodeControlBody(frame.payload) as PluginRuntimeLogBatchAckBody;
  } catch (error) {
    reportProtocolError(error);
    return;
  }
  const record = supervisor.getRecord(body.workerId);
  if (record === undefined || record.workerEpoch !== body.workerEpoch) {
    process.stderr.write(
      `[neotavern-plugin-runtime] drop LOG_BATCH_ACK for worker ${body.workerId} (epoch mismatch)\n`,
    );
    return;
  }
  if (!Number.isInteger(body.seq)) {
    reportProtocolError(new Error('malformed LOG_BATCH_ACK body'));
    return;
  }
  record.control.postMessage({ kind: 'log-batch-ack', seq: body.seq });
}

/**
 * Stage F live delivery: host-ward app-level messages (e.g. `event-push`)
 * routed to one worker. The runtime only checks the worker identity — the
 * payload stays opaque (§15.1); the worker narrows by kind. A push racing a
 * worker restart is dropped, like a late RPC_RESPONSE.
 */
function handleHostBridgeMessage(frame: PluginRuntimeFrame): void {
  let body: PluginRuntimeBridgeMessageBody;
  try {
    body = decodeControlBody(frame.payload) as PluginRuntimeBridgeMessageBody;
  } catch (error) {
    reportProtocolError(error);
    return;
  }
  const record = supervisor.getRecord(body.workerId);
  if (record === undefined || record.workerEpoch !== body.workerEpoch) {
    process.stderr.write(
      `[neotavern-plugin-runtime] drop HOST_BRIDGE_MESSAGE for worker ${body.workerId} (epoch mismatch)\n`,
    );
    return;
  }
  if (body.message === null || typeof body.message !== 'object') {
    reportProtocolError(new Error('malformed HOST_BRIDGE_MESSAGE body'));
    return;
  }
  record.control.postMessage(body.message);
}

function sendControlFrame(
  frameType: PluginRuntimeFrameTypeValue,
  body: unknown,
  options?: { requestId?: number; flags?: number },
): void {
  const bytes = encodeControlFrame(
    {
      protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
      frameType,
      flags: options?.flags ?? 0,
      runtimeEpoch,
      workerId: 0,
      workerEpoch: 0,
      requestId: options?.requestId ?? 0,
    },
    body,
  );
  outbox.push(bytes);
}

/**
 * Write one opaque payload to the fd 4 data pipe (runtime -> host, §15.9,
 * Stage F part 13). Returns false when the frame was not queued: the pipe is
 * closed/unavailable or the bounded outbox is congested — the caller then
 * fails the broker call with backpressure instead of buffering unboundedly
 * (§17).
 */
function sendOpaqueDataFrame(
  frameType: PluginRuntimeFrameTypeValue,
  workerId: number,
  workerEpoch: number,
  payload: Uint8Array,
): boolean {
  if (
    dataOut === undefined ||
    dataOut.destroyed ||
    dataQueuedFrames >= DATA_OUT_MAX_QUEUED_FRAMES
  ) {
    return false;
  }
  const bytes = encodeDataFrame(
    {
      protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
      frameType,
      flags: PluginRuntimeFrameFlag.DATA,
      runtimeEpoch,
      workerId,
      workerEpoch,
      requestId: 0,
    },
    payload,
  );
  dataQueuedFrames += 1;
  dataWriteTail = dataWriteTail
    .then(
      () =>
        new Promise<void>((resolve) => {
          if (dataOut === undefined || dataOut.destroyed) {
            resolve();
            return;
          }
          dataOut.write(bytes, () => resolve());
        }),
    )
    .catch(() => undefined)
    .finally(() => {
      dataQueuedFrames -= 1;
    });
  return true;
}

function reportProtocolError(error: unknown): void {
  process.stderr.write(`[neotavern-plugin-runtime] protocol error: ${String(error)}\n`);
  try {
    const code =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'PLUGIN_RUNTIME_BAD_PAYLOAD';
    sendControlFrame(PluginRuntimeFrameType.ERROR, {
      code,
      message: String(error instanceof Error ? error.message : error),
      retryable: true,
      stackToken: 'runtime',
    });
  } catch {
    // Outbox may be dead; nothing else to do.
  }
}

function collectTelemetry(): PluginRuntimeTelemetry {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const stats = supervisor.stats();
  const elu = performance.eventLoopUtilization();
  return {
    at: Date.now(),
    runtimeEpoch,
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
    rssMiB: memory.rss / 1048576,
    heapUsedMiB: memory.heapUsed / 1048576,
    heapTotalMiB: memory.heapTotal / 1048576,
    externalMiB: memory.external / 1048576,
    arrayBuffersMiB: (memory.arrayBuffers ?? 0) / 1048576,
    cpuMs: (cpu.user + cpu.system) / 1000,
    eventLoopUtilization: elu.utilization,
    workerCount: stats.workerCount,
    workerRestarts: stats.workerRestarts,
    runtimeRestarts: 0,
  };
}

function toWorkerReadyBody(info: WorkerReadyInfo): PluginRuntimeWorkerReady {
  return {
    workerId: info.workerId,
    workerEpoch: info.workerEpoch,
    pluginId: info.pluginId,
    installationId: info.installationId,
    lockdownMs: info.lockdownMs,
    compartmentMs: info.compartmentMs,
    bootstrapMs: info.bootstrapMs,
    noNodeAuthority: info.noNodeAuthority,
    probe: info.probe,
    ...(info.emergencyLimits !== undefined ? { emergencyLimits: info.emergencyLimits } : {}),
  };
}

function toWorkerTerminatedBody(
  info: {
    workerId: number;
    workerEpoch: number;
    code: number | null;
  },
  fatal?: PluginRuntimeFatalEnvelope,
): PluginRuntimeWorkerTerminated {
  return {
    workerId: info.workerId,
    workerEpoch: info.workerEpoch,
    code: info.code ?? 0,
    signal: null,
    ...(fatal !== undefined ? { fatal } : {}),
  };
}

function openDataPipes(): void {
  // §15.9: control-class frames never queue behind bulk data. The data
  // pipes carry their own bounded outbox and parser, so a multi-MiB
  // transfer cannot delay TERMINATE/PING/REVOKE on the control channel.
  // The runtime -> host direction (fd 4) carries RPC_REQUEST_DATA with
  // large broker-call args (Stage F part 13).
  const incoming = openDataSocket(3, 'read');
  const outgoing = openDataSocket(4, 'write');
  dataOut = outgoing;
  if (incoming !== undefined) {
    incoming.on('data', (chunk: Buffer) => {
      let frames: PluginRuntimeFrame[];
      try {
        frames = dataIn.push(chunk);
      } catch (error) {
        reportProtocolError(error);
        return;
      }
      for (const frame of frames) handleHostDataFrame(frame);
    });
    incoming.on('end', () => {
      process.stderr.write('[neotavern-plugin-runtime] data pipe fd 3 closed\n');
    });
    incoming.on('error', (error: unknown) => {
      process.stderr.write(`[neotavern-plugin-runtime] data pipe fd 3: ${String(error)}\n`);
    });
  }
  if (outgoing !== undefined) {
    // Runtime -> host bulk (RPC_REQUEST_DATA with large args, §15.9) flows
    // through the serialized outbox above; the socket owns no other state.
    outgoing.on('error', (error: unknown) => {
      process.stderr.write(`[neotavern-plugin-runtime] data pipe fd 4: ${String(error)}\n`);
    });
  }
}

function openDataSocket(fd: number, mode: 'read' | 'write'): net.Socket | undefined {
  try {
    // Windows (named-pipe handles): starting a read on a data fd blocks
    // writes on that same handle (net.Socket keeps a pending overlapped
    // read), so the runtime opens each pipe for exactly one direction.
    return new net.Socket({
      fd,
      readable: mode === 'read',
      writable: mode === 'write',
    });
  } catch (error) {
    process.stderr.write(`[neotavern-plugin-runtime] data pipe fd ${fd} unavailable: ${String(error)}\n`);
    return undefined;
  }
}

function handleHostDataFrame(frame: PluginRuntimeFrame): void {
  switch (frame.header.frameType) {
    case PluginRuntimeFrameType.MODULE_GRAPH_DATA:
      handleModuleGraphData(frame);
      break;
    case PluginRuntimeFrameType.RPC_RESPONSE_DATA:
      handleRpcResponseData(frame);
      break;
    case PluginRuntimeFrameType.RPC_RESPONSE_STREAM:
      handleRpcResponseStream(frame);
      break;
    default:
      process.stderr.write(
        `[neotavern-plugin-runtime] unexpected data-pipe frame type ${String(frame.header.frameType)}\n`,
      );
  }
}

/**
 * Large module graphs (§15.3): the signed graph arrives on the data pipe as
 * an opaque payload (§15.1 — the worker is the single decode point), with
 * the routing identity in the hot header. Mirrors handleModuleGraph: a
 * frame racing a worker restart is dropped, never treated as a protocol
 * error (the host will retry or give up at its own layer).
 */
function handleModuleGraphData(frame: PluginRuntimeFrame): void {
  const { workerId, workerEpoch } = frame.header;
  const record = supervisor.getRecord(workerId);
  if (record === undefined || record.workerEpoch !== workerEpoch) {
    process.stderr.write(
      `[neotavern-plugin-runtime] drop MODULE_GRAPH_DATA for worker ${workerId} (epoch mismatch)\n`,
    );
    return;
  }
  record.control.postMessage({
    kind: 'load-module-graph',
    graphBytes: frame.payload,
  });
}

/**
 * Large broker-call results (Stage F part 12): the response body arrives on
 * the data pipe as an opaque payload (§15.1 — the worker is the single decode
 * point) with the routing identity in the hot header. Mirrors
 * handleHostBridgeMessage: a frame racing a worker restart is dropped, never
 * treated as a protocol error.
 */
function handleRpcResponseData(frame: PluginRuntimeFrame): void {
  const { workerId, workerEpoch } = frame.header;
  const record = supervisor.getRecord(workerId);
  if (record === undefined || record.workerEpoch !== workerEpoch) {
    process.stderr.write(
      `[neotavern-plugin-runtime] drop RPC_RESPONSE_DATA for worker ${workerId} (epoch mismatch)\n`,
    );
    return;
  }
  record.control.postMessage({
    kind: 'rpc-response',
    responseBytes: frame.payload,
  });
}

/**
 * §17 credit streams (Stage F part 14): one chunk of a large broker-call
 * result. The payload (`header JSON + NUL + chunk`, see
 * `PluginRuntimeRpcResponseStreamHeader`) stays opaque here — the worker is
 * the single assembly and decode point (§15.1). Mirrors handleRpcResponseData:
 * a frame racing a worker restart is dropped, never a protocol error.
 */
function handleRpcResponseStream(frame: PluginRuntimeFrame): void {
  const { workerId, workerEpoch } = frame.header;
  const record = supervisor.getRecord(workerId);
  if (record === undefined || record.workerEpoch !== workerEpoch) {
    process.stderr.write(
      `[neotavern-plugin-runtime] drop RPC_RESPONSE_STREAM for worker ${workerId} (epoch mismatch)\n`,
    );
    return;
  }
  record.control.postMessage({
    kind: 'rpc-response-stream',
    payloadBytes: frame.payload,
  });
}

function shutdownDiagnostics(reason: string): void {
  process.stderr.write(`[neotavern-plugin-runtime] shutdown (${reason})\n`);
}

async function shutdownAndExit(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(telemetryTimer);
  brokerCore.shutdown();
  await supervisor.terminateAll('runtime shutdown');
  sendControlFrame(PluginRuntimeFrameType.TERMINATE_ACK, { runtimeEpoch });
  await outbox.drained();
  setImmediate(() => process.exit(0));
}
