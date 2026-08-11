/**
 * Main Host side of the Plugin Runtime (ТЗ v3.2 §15; ADR-0027/0028).
 *
 * Spawns the runtime process, runs the framed handshake, exposes worker
 * lifecycle commands and typed events for readiness/telemetry/exit. The
 * client is a plain transport: plugin payloads stay opaque (§15.1), and the
 * control channel is the only thing decoded here.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';
import type {
  PluginRuntimeBridgeMessageBody,
  PluginRuntimeBrokerRevokeBody,
  PluginRuntimeFatalDiagnosticBody,
  PluginRuntimeFrame,
  PluginRuntimeFrameTypeValue,
  PluginRuntimeHello,
  PluginRuntimeHelloAck,
  PluginRuntimeLogBatchAckBody,
  PluginRuntimeLogBatchPayload,
  PluginRuntimeModuleGraphBody,
  PluginRuntimeProtocolError,
  PluginRuntimeRpcRequestBody,
  PluginRuntimeRpcResponseBody,
  PluginRuntimeStreamCreditBody,
  PluginRuntimeTelemetry,
  PluginRuntimeWorkerReady,
  PluginRuntimeWorkerSpawn,
  PluginRuntimeWorkerTerminated,
  PluginRuntimeWorkerTerminate,
} from '@neotavern/contracts';
import {
  PLUGIN_RUNTIME_LOG_BATCH_MAX_RECORDS,
  PLUGIN_RUNTIME_LOG_LEVELS,
  PLUGIN_RUNTIME_MAX_CONTROL_PAYLOAD_BYTES,
  PLUGIN_RUNTIME_MAX_DATA_PAYLOAD_BYTES,
  PLUGIN_RUNTIME_MAX_STRING_BYTES,
  PLUGIN_RUNTIME_PROTOCOL_VERSION,
  PluginRuntimeFrameFlag,
  PluginRuntimeFrameParser,
  PluginRuntimeFrameType,
  decodeControlBody,
  encodeControlFrame,
  encodeDataBody,
  encodeDataFrame,
  RPC_STREAM_CHUNK_BYTES,
} from '@neotavern/contracts';
import { ResponseStreamer, type RpcResponseStreamFrame } from './responseStreamer.js';

export interface PluginRuntimeClientOptions {
  /** Runtime generation counter; the host owns it (§25.1). Default 1. */
  runtimeEpoch?: number;
  /** Opaque runtime identity for diagnostics. Default generated. */
  runtimeId?: string;
  /** Telemetry push interval in ms. Default 5000. */
  telemetryMs?: number;
  /** Timeout for the handshake and request/response frames. Default 5000. */
  timeoutMs?: number;
  /** Node executable used to spawn the runtime. Default `process.execPath`. */
  nodeExecutable?: string;
  /** Runtime entry override (e.g. an already-built dist bundle). */
  runtimeEntry?: string;
  /** Working directory for the child. Defaults to the package root. */
  cwd?: string;
  /** Optional diagnostic-line consumer for the runtime's stderr. */
  stderrSink?: (line: string) => void;
}

export interface PluginRuntimeClientEvents {
  ready: PluginRuntimeHello;
  workerReady: PluginRuntimeWorkerReady;
  workerTerminated: PluginRuntimeWorkerTerminated;
  /** A worker broker call forwarded host-ward by the runtime (§15.2). */
  rpcRequest: PluginRuntimeRpcRequestBody;
  /**
   * App-level worker bridge message the runtime did not consume
   * (module-graph-loaded/error, Stage A; live delivery, Stage F).
   */
  bridgeMessage: PluginRuntimeBridgeMessageBody;
  telemetry: PluginRuntimeTelemetry;
  /**
   * Opaque bulk frame from the runtime on the data pipe (fd 4, §15.9).
   * Payload stays opaque; no producer exists yet (forward compatibility).
   */
  dataFrame: PluginRuntimeFrame;
  /**
   * One batched plugin console batch (§9.1.1). Decoded exactly once here —
   * the runtime forwarded the worker-encoded payload opaque (§15.1). The
   * consumer routes the records to the host log router, emits the synthetic
   * suppressed-record when `droppedCount > 0` (rule 9) and then calls
   * `sendLogBatchAck` to replenish the worker's log credit.
   */
  logBatch: PluginRuntimeLogBatchPayload & { workerId: number; workerEpoch: number };
  /** §9.1.4: bounded fatal envelope of a dying worker (reserved path). */
  fatalDiagnostic: PluginRuntimeFatalDiagnosticBody;
  error: PluginRuntimeProtocolError | Error;
  exit: { code: number | null; signal: string | null };
}

export type PluginRuntimeClientEventName = keyof PluginRuntimeClientEvents;

export interface PluginRuntimeWorkerTarget {
  workerId: number;
  pluginId: string;
  installationId: string;
  moduleGraphDigest?: string;
  /** §38 memory hint (MiB): the runtime raises the emergency ceiling when headroom permits. */
  memoryHintMiB?: number;
  /** §39 admin override (MiB): wins over the headroom calculation. */
  maxHeapOverrideMiB?: number;
}

interface FrameWaiter {
  predicate: (frame: PluginRuntimeFrame) => boolean;
  resolve: (frame: PluginRuntimeFrame) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}

function defaultRuntimeEntry(root: string): string {
  const distEntry = resolve(root, 'dist', 'runtime-main.js');
  return existsSync(distEntry) ? distEntry : resolve(root, 'src', 'runtime-main.ts');
}

/**
 * Control-path eligibility for a module-graph body: the encoded body must
 * fit the control payload cap with slack for JSON escaping, and every
 * module source must stay under the control decoder's per-string bound
 * (also with escaping slack, §15.11). Anything larger goes the data pipe.
 */
function fitsControlPath(body: PluginRuntimeModuleGraphBody): boolean {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  if (bytes.byteLength > PLUGIN_RUNTIME_MAX_CONTROL_PAYLOAD_BYTES - CONTROL_ESCAPE_MARGIN_BYTES) {
    return false;
  }
  const graph = body.graph as { records?: Array<{ source?: unknown }> };
  if (!Array.isArray(graph.records)) return false;
  for (const record of graph.records) {
    const source = record.source;
    if (typeof source === 'string' && source.length > PLUGIN_RUNTIME_MAX_STRING_BYTES / 2) {
      return false;
    }
  }
  return true;
}

/**
 * Control-path eligibility for a broker-call response body: the encoded body
 * must fit the control payload cap, and no string (e.g. a large fetch body)
 * may approach the control decoder's per-string bound (§15.11). Anything
 * larger goes the data pipe as RPC_RESPONSE_DATA.
 */
function rpcResponseFitsControl(body: PluginRuntimeRpcResponseBody): boolean {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  if (bytes.byteLength > PLUGIN_RUNTIME_MAX_CONTROL_PAYLOAD_BYTES - CONTROL_ESCAPE_MARGIN_BYTES) {
    return false;
  }
  const stack: unknown[] = [body];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') {
      if (value.length > PLUGIN_RUNTIME_MAX_STRING_BYTES / 2) return false;
    } else if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
    } else if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        stack.push((value as Record<string, unknown>)[key]);
      }
    }
  }
  return true;
}

/** Slack reserved for JSON escaping when routing to the control pipe. */
const CONTROL_ESCAPE_MARGIN_BYTES = 8 * 1024;

/** Narrow a decoded log record's level to the contract union (§9.1.2). */
function isLogLevel(value: unknown): value is (typeof PLUGIN_RUNTIME_LOG_LEVELS)[number] {
  return (
    typeof value === 'string' && (PLUGIN_RUNTIME_LOG_LEVELS as readonly string[]).includes(value)
  );
}

function minimalRuntimeEnv(
  options: Required<Pick<PluginRuntimeClientOptions, 'runtimeEpoch' | 'runtimeId' | 'telemetryMs'>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NEOTA_PLUGIN_RUNTIME_EPOCH: String(options.runtimeEpoch),
    NEOTA_PLUGIN_RUNTIME_ID: options.runtimeId,
    NEOTA_PLUGIN_RUNTIME_TELEMETRY_MS: String(options.telemetryMs),
    NODE_NO_WARNINGS: '1',
  };
  // NODE_OPTIONS is deliberately NOT propagated (§5.6, ADR-0028).
  for (const key of ['SystemRoot', 'WINDIR', 'LANG', 'LC_ALL']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/**
 * Typed client over a spawned Plugin Runtime process. Construct via
 * `PluginRuntimeClient.start()`, which completes the framed handshake.
 */
export class PluginRuntimeClient {
  readonly runtimeEpoch: number;
  private readonly child: ChildProcess;
  private readonly options: PluginRuntimeClientOptions;
  private readonly emitter = new EventEmitter();
  private readonly controlParser = new PluginRuntimeFrameParser();
  private readonly dataParser = new PluginRuntimeFrameParser({
    maxPayloadBytes: PLUGIN_RUNTIME_MAX_DATA_PAYLOAD_BYTES,
  });
  private readonly waiters = new Set<FrameWaiter>();
  private readonly preHandshake: PluginRuntimeFrame[] = [];
  private readonly responseStreamer = new ResponseStreamer();
  private streamedResponseFrameCount = 0;
  private streamedResponseByteCount = 0;
  private requestIdCounter = 0;
  private connected = false;
  private closed = false;

  private constructor(child: ChildProcess, options: PluginRuntimeClientOptions) {
    this.child = child;
    this.options = options;
    this.runtimeEpoch = options.runtimeEpoch ?? 1;
    this.wireChild();
  }

  /** Spawn the runtime process and complete the framed handshake. */
  static async start(options: PluginRuntimeClientOptions = {}): Promise<PluginRuntimeClient> {
    const timeoutMs = options.timeoutMs ?? 5000;
    const root = options.cwd ?? packageRoot();
    const entry = options.runtimeEntry ?? defaultRuntimeEntry(root);
    const args: string[] = entry.endsWith('.ts') ? ['--import', 'tsx', entry] : [entry];
    const child = spawn(options.nodeExecutable ?? process.execPath, args, {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      cwd: root,
      env: minimalRuntimeEnv({
        runtimeEpoch: options.runtimeEpoch ?? 1,
        runtimeId: options.runtimeId ?? `runtime-${randomUUID()}`,
        telemetryMs: options.telemetryMs ?? 5000,
      }),
      windowsHide: true,
    });
    const client = new PluginRuntimeClient(child, options);
    try {
      await client.handshake(timeoutMs);
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  on<K extends PluginRuntimeClientEventName>(
    event: K,
    listener: (payload: PluginRuntimeClientEvents[K]) => void,
  ): this {
    this.emitter.on(event, listener as (payload: unknown) => void);
    return this;
  }

  once<K extends PluginRuntimeClientEventName>(
    event: K,
    listener: (payload: PluginRuntimeClientEvents[K]) => void,
  ): this {
    this.emitter.once(event, listener as (payload: unknown) => void);
    return this;
  }

  off<K extends PluginRuntimeClientEventName>(
    event: K,
    listener: (payload: PluginRuntimeClientEvents[K]) => void,
  ): this {
    this.emitter.off(event, listener as (payload: unknown) => void);
    return this;
  }

  /** Ask the runtime to bootstrap a worker (fire-and-forget; see workerReady). */
  spawnWorker(target: PluginRuntimeWorkerTarget): void {
    this.assertConnected();
    const body: PluginRuntimeWorkerSpawn = {
      workerId: target.workerId,
      pluginId: target.pluginId,
      installationId: target.installationId,
      moduleGraphDigest: target.moduleGraphDigest,
      ...(target.memoryHintMiB !== undefined ? { memoryHintMiB: target.memoryHintMiB } : {}),
      ...(target.maxHeapOverrideMiB !== undefined
        ? { maxHeapOverrideMiB: target.maxHeapOverrideMiB }
        : {}),
    };
    this.sendFrame(PluginRuntimeFrameType.WORKER_SPAWN, body);
  }

  /** Terminate a worker (two-phase inside the runtime, §25.1). */
  terminateWorker(workerId: number, reason?: string): void {
    this.assertConnected();
    const body: PluginRuntimeWorkerTerminate = { workerId, reason };
    this.sendFrame(PluginRuntimeFrameType.WORKER_TERMINATE, body);
  }

  /** Request a liveness/telemetry reply from the runtime (§40). */
  ping(timeoutMs?: number): Promise<PluginRuntimeTelemetry> {
    const requestId = this.nextRequestId();
    this.sendFrame(PluginRuntimeFrameType.PING, {}, { requestId });
    return this.waitForFrame(
      (frame) =>
        frame.header.frameType === PluginRuntimeFrameType.PONG &&
        frame.header.requestId === requestId,
      timeoutMs ?? this.options.timeoutMs ?? 5000,
      'PONG',
    ).then((frame) => decodeControlBody(frame.payload) as PluginRuntimeTelemetry);
  }

  /**
   * Settle a worker broker call the host decided (§15.2, Stage D part 9b).
   * Transport is chosen here, deterministically: the control frame
   * (RPC_RESPONSE) when the body fits the control path; the data pipe
   * (RPC_RESPONSE_DATA, fd 3, §15.9) with an opaque payload decoded exactly
   * once by the worker (§15.1) when it fits one chunk; otherwise a §17 credit
   * stream (RPC_RESPONSE_STREAM chunks paced by the worker's credit grants) —
   * large network bodies land here.
   */
  sendRpcResponse(body: PluginRuntimeRpcResponseBody): void {
    this.assertConnected();
    if (rpcResponseFitsControl(body)) {
      this.sendFrame(PluginRuntimeFrameType.RPC_RESPONSE, body);
      return;
    }
    const payload = encodeDataBody(body);
    if (payload.byteLength > RPC_STREAM_CHUNK_BYTES) {
      const result = this.responseStreamer.begin(
        body.workerId,
        body.workerEpoch,
        body.requestId,
        payload,
      );
      if (result.kind === 'error') {
        this.sendFrame(PluginRuntimeFrameType.RPC_RESPONSE, {
          workerId: body.workerId,
          workerEpoch: body.workerEpoch,
          requestId: body.requestId,
          ok: false,
          error: { code: result.code, message: result.message },
        });
        return;
      }
      this.writeResponseStreamFrame(result.frame);
      return;
    }
    const bytes = encodeDataFrame(
      {
        protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
        frameType: PluginRuntimeFrameType.RPC_RESPONSE_DATA,
        flags: PluginRuntimeFrameFlag.DATA,
        runtimeEpoch: this.runtimeEpoch,
        workerId: body.workerId,
        workerEpoch: body.workerEpoch,
        requestId: 0,
      },
      payload,
    );
    // fd 3 is the host -> runtime data pipe (a Writable by construction).
    const dataOut = this.child.stdio[3] as Writable | null;
    if (dataOut && !dataOut.destroyed) dataOut.write(bytes);
  }

  /**
   * Write one §17 stream chunk to the data pipe and account it in the
   * diagnostics counters (§40; also the observable the subprocess e2e test
   * uses to prove the credit path was exercised).
   */
  private writeResponseStreamFrame(frame: RpcResponseStreamFrame): void {
    const bytes = encodeDataFrame(
      {
        protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
        frameType: PluginRuntimeFrameType.RPC_RESPONSE_STREAM,
        flags: PluginRuntimeFrameFlag.DATA,
        runtimeEpoch: this.runtimeEpoch,
        workerId: frame.workerId,
        workerEpoch: frame.workerEpoch,
        requestId: 0,
      },
      frame.payload,
    );
    const dataOut = this.child.stdio[3] as Writable | null;
    if (dataOut && !dataOut.destroyed) dataOut.write(bytes);
    this.streamedResponseFrameCount += 1;
    this.streamedResponseByteCount += frame.chunk.byteLength;
  }

  /**
   * Consume a worker's `rpc-stream-credit` bridge message (§17): validate
   * the grant and produce the next chunk when the window allows. This message
   * is transport-level, so it is consumed here and never re-emitted as an
   * app-level bridge message. Malformed or stale grants are dropped.
   */
  private handleStreamCredit(body: PluginRuntimeBridgeMessageBody): void {
    const message = body.message;
    if (message === null || typeof message !== 'object') return;
    const credit = message as Partial<PluginRuntimeStreamCreditBody>;
    const workerId = credit.workerId;
    const workerEpoch = credit.workerEpoch;
    const requestId = credit.requestId;
    const bytes = credit.bytes;
    if (
      typeof workerId !== 'number' ||
      typeof workerEpoch !== 'number' ||
      typeof requestId !== 'string' ||
      typeof bytes !== 'number' ||
      !Number.isInteger(bytes) ||
      bytes < 1
    ) {
      return;
    }
    const frame = this.responseStreamer.grant(workerId, workerEpoch, requestId, bytes);
    if (frame !== null) this.writeResponseStreamFrame(frame);
  }

  /**
   * §9.1.1: decode one LOG_BATCH frame payload (the single decode point for
   * plugin log records, §15.1) and emit the typed `logBatch` event. Records
   * are bounded by the batch caps; malformed records are skipped rather than
   * trusted, and a malformed whole batch is dropped without an emit.
   */
  private handleLogBatchFrame(frame: PluginRuntimeFrame): void {
    let text: string;
    try {
      text = new TextDecoder().decode(frame.payload);
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== 'object') return;
    const batch = parsed as { seq?: unknown; droppedCount?: unknown; records?: unknown };
    if (
      typeof batch.seq !== 'number' ||
      !Number.isInteger(batch.seq) ||
      batch.seq < 0 ||
      typeof batch.droppedCount !== 'number' ||
      !Number.isInteger(batch.droppedCount) ||
      batch.droppedCount < 0 ||
      !Array.isArray(batch.records)
    ) {
      return;
    }
    const records: PluginRuntimeLogBatchPayload['records'] = [];
    for (const raw of batch.records.slice(0, PLUGIN_RUNTIME_LOG_BATCH_MAX_RECORDS)) {
      if (raw === null || typeof raw !== 'object') continue;
      const record = raw as { level?: unknown; message?: unknown; at?: unknown; count?: unknown };
      if (
        !isLogLevel(record.level) ||
        typeof record.message !== 'string' ||
        typeof record.at !== 'number' ||
        !Number.isInteger(record.at)
      ) {
        continue;
      }
      if (typeof record.count === 'number' && Number.isInteger(record.count) && record.count >= 2) {
        records.push({
          level: record.level,
          message: record.message,
          at: record.at,
          count: record.count,
        });
      } else {
        records.push({ level: record.level, message: record.message, at: record.at });
      }
    }
    this.emit('logBatch', {
      workerId: frame.header.workerId,
      workerEpoch: frame.header.workerEpoch,
      seq: batch.seq,
      droppedCount: batch.droppedCount,
      records,
    });
  }

  /**
   * §9.1.1 credit ack: the host consumed one LOG_BATCH (log router wrote it
   * and emitted the synthetic suppressed-record); the runtime relays the ack
   * to the worker, which replenishes its bounded flush credit.
   */
  sendLogBatchAck(body: PluginRuntimeLogBatchAckBody): void {
    this.assertConnected();
    this.sendFrame(PluginRuntimeFrameType.LOG_BATCH_ACK, body);
  }

  /** §17 diagnostics: number of stream chunks written to the data pipe. */
  get responseStreamFrameCount(): number {
    return this.streamedResponseFrameCount;
  }

  /** §17 diagnostics: bytes streamed to the data pipe across all chunks. */
  get responseStreamByteCount(): number {
    return this.streamedResponseByteCount;
  }

  /** Tell the runtime to reject new calls and abort in-flight ones (§10.2). */
  sendBrokerRevoke(body: PluginRuntimeBrokerRevokeBody): void {
    this.assertConnected();
    this.sendFrame(PluginRuntimeFrameType.BROKER_REVOKE, body);
  }

  /**
   * Push an app-level bridge message to one worker (Stage F live delivery,
   * e.g. `event-push`). The runtime checks the worker identity and forwards
   * the payload to the worker's control port; the worker narrows by kind.
   */
  sendHostBridgeMessage(body: PluginRuntimeBridgeMessageBody): void {
    this.assertConnected();
    this.sendFrame(PluginRuntimeFrameType.HOST_BRIDGE_MESSAGE, body);
  }

  /**
   * Ship the signed module graph for a spawned worker (Stage A, §15.8;
   * large graphs Stage F part 11). Call after the WORKER_READY frame so
   * `target.workerEpoch` matches the runtime's record epoch.
   *
   * Transport is chosen here, deterministically:
   * - control frame (MODULE_GRAPH) when the encoded body fits the control
   *   cap with escaping slack and every module source stays under the
   *   control decoder's per-string bound (decode happens in the runtime);
   * - otherwise the data pipe (MODULE_GRAPH_DATA, fd 3, §15.9) with an
   *   opaque payload decoded exactly once by the worker (§15.1).
   */
  sendModuleGraph(target: { workerId: number; workerEpoch: number }, graph: unknown): void {
    this.assertConnected();
    const body: PluginRuntimeModuleGraphBody = {
      workerId: target.workerId,
      workerEpoch: target.workerEpoch,
      graph,
    };
    const header = {
      protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
      runtimeEpoch: this.runtimeEpoch,
      workerId: target.workerId,
      workerEpoch: target.workerEpoch,
      requestId: 0,
    };
    if (fitsControlPath(body)) {
      const bytes = encodeControlFrame(
        { ...header, frameType: PluginRuntimeFrameType.MODULE_GRAPH, flags: 0 },
        body,
      );
      if (this.child.stdin) this.child.stdin.write(bytes);
      return;
    }
    const payload = encodeDataBody(body);
    const bytes = encodeDataFrame(
      {
        ...header,
        frameType: PluginRuntimeFrameType.MODULE_GRAPH_DATA,
        flags: PluginRuntimeFrameFlag.DATA,
      },
      payload,
    );
    // fd 3 is the host -> runtime data pipe (a Writable by construction).
    const dataOut = this.child.stdio[3] as Writable | null;
    if (dataOut && !dataOut.destroyed) dataOut.write(bytes);
  }

  /** Graceful runtime shutdown: TERMINATE, then wait for process exit. */
  async terminate(timeoutMs?: number): Promise<void> {
    if (this.closed) return;
    if (this.child.exitCode !== null) {
      this.closed = true;
      return;
    }
    this.sendFrame(PluginRuntimeFrameType.TERMINATE, { runtimeEpoch: this.runtimeEpoch });
    await this.waitForExit(timeoutMs ?? 5000);
  }

  /** Hard-stop the child without a protocol exchange. */
  close(): void {
    this.closed = true;
    this.rejectAllWaiters(new Error('Plugin Runtime client closed'));
    if (this.child.exitCode === null) this.child.kill();
  }

  get connectedState(): boolean {
    return this.connected;
  }

  private async handshake(timeoutMs: number): Promise<void> {
    const existing = this.takeFrame(
      (frame) => frame.header.frameType === PluginRuntimeFrameType.HELLO,
    );
    const helloFrame =
      existing ??
      (await this.waitForFrame(
        (frame) => frame.header.frameType === PluginRuntimeFrameType.HELLO,
        timeoutMs,
        'HELLO',
      ));
    const hello = decodeControlBody(helloFrame.payload) as PluginRuntimeHello;
    if (hello.protocolVersion !== PLUGIN_RUNTIME_PROTOCOL_VERSION) {
      const ack: PluginRuntimeHelloAck = {
        protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
        runtimeEpoch: hello.runtimeEpoch,
        accepted: false,
        reason: `VERSION_MISMATCH host=${PLUGIN_RUNTIME_PROTOCOL_VERSION} runtime=${hello.protocolVersion}`,
      };
      this.sendFrame(PluginRuntimeFrameType.HELLO_ACK, ack);
      throw new Error(ack.reason);
    }
    if (hello.runtimeEpoch !== this.runtimeEpoch) {
      throw new Error(
        `Plugin Runtime epoch mismatch: requested=${this.runtimeEpoch} got=${hello.runtimeEpoch}`,
      );
    }
    const ack: PluginRuntimeHelloAck = {
      protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
      runtimeEpoch: hello.runtimeEpoch,
      accepted: true,
    };
    this.sendFrame(PluginRuntimeFrameType.HELLO_ACK, ack);
    this.connected = true;
    this.emit('ready', hello);
    // Frames that raced the handshake (e.g. early telemetry) now dispatch.
    for (const queued of this.preHandshake.splice(0)) this.dispatchFrame(queued);
  }

  private wireChild(): void {
    this.child.stdout?.on('data', (chunk: Buffer) => {
      let frames: PluginRuntimeFrame[];
      try {
        frames = this.controlParser.push(chunk);
      } catch (error) {
        this.emit('error', error as Error);
        return;
      }
      for (const frame of frames) this.dispatchFrame(frame);
    });
    this.child.stdout?.on('error', (error: Error) => this.emit('error', error));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      const sink = this.options.stderrSink;
      if (sink) {
        for (const line of chunk.split(/\r?\n/u)) {
          if (line) sink(line);
        }
      }
    });
    // Data pipes (§15.9): fd 3 is host -> runtime bulk (writes only),
    // fd 4 is runtime -> host bulk. RPC_REQUEST_DATA frames (large broker
    // call args, Stage F part 13) are decoded here — the host is the single
    // decode point (§15.1) — and re-emitted as the control-path `rpcRequest`;
    // unknown frame types stay opaque on `dataFrame`.
    const dataIn = this.child.stdio[4];
    if (dataIn) {
      dataIn.on('data', (chunk: Buffer) => {
        let frames: PluginRuntimeFrame[];
        try {
          frames = this.dataParser.push(chunk);
        } catch (error) {
          this.emit('error', error as Error);
          return;
        }
        for (const frame of frames) this.handleDataFrame(frame);
      });
      dataIn.on('error', (error: Error) => this.emit('error', error));
    }
    this.child.on('error', (error: Error) => {
      this.closed = true;
      this.rejectAllWaiters(error);
      this.emit('error', error);
    });
    this.child.on('exit', (code, signal) => {
      this.connected = false;
      this.rejectAllWaiters(new Error(`Plugin Runtime exited (code=${code})`));
      this.emit('exit', { code, signal });
    });
  }

  /**
   * Route one fd 4 data frame (§15.9). RPC_REQUEST_DATA (large broker call
   * args, Stage F part 13) is decoded exactly once here — the host is the
   * endpoint (§15.1) — validated against the hot-header identity (frames
   * racing a worker restart are dropped, never forwarded cross-worker) and
   * re-emitted as the control-path `rpcRequest` shape. Unknown frame types
   * stay opaque on `dataFrame` for forward compatibility.
   */
  private handleDataFrame(frame: PluginRuntimeFrame): void {
    if (frame.header.frameType !== PluginRuntimeFrameType.RPC_REQUEST_DATA) {
      this.emit('dataFrame', frame);
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(frame.payload));
    } catch {
      return; // malformed payload: drop, the call's deadline bounds the wait
    }
    const request = body as PluginRuntimeRpcRequestBody;
    if (
      request === null ||
      typeof request !== 'object' ||
      typeof request.call !== 'object' ||
      request.call === null ||
      !Number.isInteger(request.workerId) ||
      !Number.isInteger(request.workerEpoch) ||
      request.workerId !== frame.header.workerId ||
      request.workerEpoch !== frame.header.workerEpoch
    ) {
      return; // identity mismatch or malformed body: drop like epoch races
    }
    this.emit('rpcRequest', request);
  }

  private dispatchFrame(frame: PluginRuntimeFrame): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(frame)) {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
        return;
      }
    }
    if (!this.connected) {
      // HELLO (and anything racing the handshake) is buffered until the
      // handshake drains it.
      this.preHandshake.push(frame);
      return;
    }
    switch (frame.header.frameType) {
      case PluginRuntimeFrameType.TELEMETRY:
        this.emit('telemetry', decodeControlBody(frame.payload) as PluginRuntimeTelemetry);
        break;
      case PluginRuntimeFrameType.WORKER_READY:
        this.emit('workerReady', decodeControlBody(frame.payload) as PluginRuntimeWorkerReady);
        break;
      case PluginRuntimeFrameType.WORKER_TERMINATED:
        this.emit(
          'workerTerminated',
          decodeControlBody(frame.payload) as PluginRuntimeWorkerTerminated,
        );
        break;
      case PluginRuntimeFrameType.RPC_REQUEST:
        this.emit('rpcRequest', decodeControlBody(frame.payload) as PluginRuntimeRpcRequestBody);
        break;
      case PluginRuntimeFrameType.BRIDGE_MESSAGE: {
        const body = decodeControlBody(frame.payload) as PluginRuntimeBridgeMessageBody;
        const message = body.message;
        if (message !== null && typeof message === 'object' && 'kind' in message) {
          if (message.kind === 'rpc-stream-credit') {
            this.handleStreamCredit(body);
            break;
          }
        }
        this.emit('bridgeMessage', body);
        break;
      }
      case PluginRuntimeFrameType.LOG_BATCH:
        // §9.1.1: raw worker-encoded batch payload; the host is the single
        // decode point (§15.1). Malformed batches are dropped (no emit) but
        // still acked by the consumer path via sendLogBatchAck — a wedged
        // log channel must not wedge the plugin.
        this.handleLogBatchFrame(frame);
        break;
      case PluginRuntimeFrameType.FATAL_DIAGNOSTIC:
        this.emit(
          'fatalDiagnostic',
          decodeControlBody(frame.payload) as PluginRuntimeFatalDiagnosticBody,
        );
        break;
      case PluginRuntimeFrameType.ERROR: {
        const body = decodeControlBody(frame.payload) as {
          code?: unknown;
          message?: unknown;
        };
        const error = new Error(
          `Plugin Runtime error frame: ${String(body.message ?? body.code ?? 'unknown')}`,
        );
        this.emit('error', error);
        break;
      }
      default:
        // Unknown-to-client frames are dropped; forward compatibility.
        break;
    }
  }

  private sendFrame(
    frameType: PluginRuntimeFrameTypeValue,
    body: unknown,
    options?: { requestId?: number; flags?: number },
  ): void {
    const bytes = encodeControlFrame(
      {
        protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
        frameType,
        flags: options?.flags ?? 0,
        runtimeEpoch: this.runtimeEpoch,
        workerId: 0,
        workerEpoch: 0,
        requestId: options?.requestId ?? 0,
      },
      body,
    );
    if (this.child.stdin) this.child.stdin.write(bytes);
  }

  private takeFrame(
    predicate: (frame: PluginRuntimeFrame) => boolean,
  ): PluginRuntimeFrame | undefined {
    const index = this.preHandshake.findIndex(predicate);
    if (index < 0) return undefined;
    return this.preHandshake.splice(index, 1)[0];
  }

  private waitForFrame(
    predicate: (frame: PluginRuntimeFrame) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<PluginRuntimeFrame> {
    if (this.closed) return Promise.reject(new Error('Plugin Runtime client is closed'));
    return new Promise<PluginRuntimeFrame>((resolveWaiter, rejectWaiter) => {
      const waiter: FrameWaiter = {
        predicate,
        resolve: resolveWaiter,
        reject: rejectWaiter,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          rejectWaiter(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    if (this.child.exitCode !== null) return Promise.resolve();
    return new Promise((resolveExit) => {
      const timer = setTimeout(() => {
        if (this.child.exitCode === null) this.child.kill();
        resolveExit();
      }, timeoutMs);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }

  private rejectAllWaiters(error: Error): void {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private nextRequestId(): number {
    this.requestIdCounter = (this.requestIdCounter + 1) >>> 0;
    return this.requestIdCounter;
  }

  private assertConnected(): void {
    if (!this.connected || this.closed) {
      throw new Error('Plugin Runtime client is not connected');
    }
  }

  private emit<K extends PluginRuntimeClientEventName>(
    event: K,
    payload: PluginRuntimeClientEvents[K],
  ): void {
    this.emitter.emit(event, payload);
  }
}
