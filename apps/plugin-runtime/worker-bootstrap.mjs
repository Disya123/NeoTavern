// Trusted plugin Worker bootstrap (ТЗ Plugin SDK vNext v3.2 §5, ADR-0028).
//
// Two-phase bootstrap. This file IS part of the NeoTavern Trusted Computing Base:
// nothing plugin-world (plugin code, dependencies, marketplace/generated
// code, preload modules, NODE_OPTIONS payloads) may run before lockdown().
// Only version-pinned audited imports are allowed here (§5.1–§5.2).
//
// The file is executed only via `new Worker(...)` from the supervisor; it is
// deliberately plain ESM and is not imported from TypeScript.
import { workerData, resourceLimits } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
// SES v2 installs lockdown/Compartment onto globalThis as a side effect; the
// module namespace itself has no named exports. Capture them into locals
// before any other code runs (they are part of the TCB capture step §5.1).
import 'ses';
// Endo module-source parses/compiles plugin modules (§6.3, §8.8). Trusted,
// version-pinned; captured into the TCB before lockdown.
import { ModuleSource } from '@endo/module-source';

const bootstrapStart = performance.now();
const { lockdown, Compartment } = globalThis;

// Inline module-graph contract constants (§6.2, §8.6). Kept in sync with
// `packages/contracts/src/pluginModule.ts`; `workerGraph.test.ts` pins the
// exercised codes against the contracts values so drift is caught by CI.
const MODULE_ERROR_CODE = {
  PACKAGE_INVALID: 'PACKAGE_INVALID',
  UNSUPPORTED_DEPENDENCY: 'UNSUPPORTED_DEPENDENCY',
  UNSUPPORTED_NODE_BUILTIN: 'UNSUPPORTED_NODE_BUILTIN',
  MODULE_NOT_IN_GRAPH: 'MODULE_NOT_IN_GRAPH',
  MODULE_DIGEST_MISMATCH: 'MODULE_DIGEST_MISMATCH',
  MODULE_EVALUATION_FAILED: 'MODULE_EVALUATION_FAILED',
};
const MODULE_VIRTUAL_SCHEME = 'neotavern-plugin';

// Inline capability-broker constants (Stage C, ТЗ §10–§11, §26.2.1, §41).
// Kept in sync with `packages/contracts/src/capabilityBroker.ts`; the worker
// tests pin the exercised codes against the contracts values.
const BROKER_ERROR_CODE = {
  CAPABILITY_DENIED: 'CAPABILITY_DENIED',
  CAPABILITY_REVOKED: 'CAPABILITY_REVOKED',
  TRUST_REQUIRED: 'TRUST_REQUIRED',
  POLICY_DENIED: 'POLICY_DENIED',
  OPERATION_DEADLINE: 'OPERATION_DEADLINE',
  SERVICE_CALL_CYCLE: 'SERVICE_CALL_CYCLE',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INTERNAL: 'INTERNAL',
};
const BROKER_MAX_CAUSAL_CHAIN = 16;
const BROKER_DEFAULT_DEADLINE_MS = 10_000;
const BROKER_MAX_DEADLINE_MS = 60_000;
const BROKER_MAX_ARGS_BYTES = 32 * 1024;
// Stage F part 13: args above the control bound travel the data pipe as an
// opaque RPC_REQUEST_DATA payload (the worker serializes the final wire body
// exactly once). The bound leaves headroom over the largest SDK value caps
// (8 MiB) for the envelope and JSON escaping.
const BROKER_MAX_ARGS_DATA_BYTES = 16 * 1024 * 1024;
// Stage F part 14 (§17 credit streams): the host streams large response
// bodies as RPC_RESPONSE_STREAM chunks (one per credit window); this worker
// is the single assembly/decode point (§15.1) and grants credit as it
// consumes. The accumulated bound mirrors the host producer cap; reaching it
// fails the call (defense-in-depth, the host normally refuses up front).
const RPC_STREAM_MAX_ACCUMULATED_BYTES = 16 * 1024 * 1024;
// SES Compartments do not support top-level await, so an import-time broker
// call settles AFTER the import promise resolves. The graph load report waits
// for pending calls to settle (bounded) so host consumers can observe the
// result of import-time calls; fire-and-forget calls only delay the report
// up to this bound.
const BROKER_IMPORT_CALL_DRAIN_MS = 5_000;
/** Serialized snapshot bound for module-graph-loaded (§15.3/§15.11). */
const SNAPSHOT_MAX_BYTES = 48 * 1024;

function moduleLocation(pluginId, id) {
  return `${MODULE_VIRTUAL_SCHEME}://${pluginId}/${String(id).replace(/^\/+/, '')}`;
}

function graphError(code, params = {}) {
  const error = new Error(code);
  error.code = code;
  error.params = params;
  return error;
}

function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

const {
  protocolVersion,
  workerId,
  workerEpoch,
  pluginId,
  installationId,
  trustLevel,
  bridgePort,
  // moduleGraphDigest stays in workerData: the supervisor owns it; the
  // bootstrap only needs the transport identifiers and the broker caller
  // identity (pluginId / installationId / trustLevel, §10.1).
} = workerData;

if (
  !Number.isInteger(protocolVersion) ||
  protocolVersion < 1 ||
  !bridgePort ||
  typeof pluginId !== 'string' ||
  pluginId.length === 0 ||
  typeof installationId !== 'string' ||
  installationId.length === 0 ||
  (trustLevel !== 'sandbox' && trustLevel !== 'extended' && trustLevel !== 'trusted')
) {
  // Nothing we can frame reliably; bail loudly on the diagnostics stream.
  console.error(
    `[neotavern-plugin-runtime] invalid bootstrap data (protocolVersion=${String(protocolVersion)}, ` +
      `pluginId=${String(pluginId)}, installationId=${String(installationId)}, ` +
      `trustLevel=${String(trustLevel)})`,
  );
  process.exit(1);
}

// ---- Phase 1: SES lockdown (§5.3). Production policy: errorTaming safe,
// overrideTaming moderate, consoleTaming safe. `severe` as default is
// forbidden by §55; `unsafe-debug` is allowed only in a disposable local
// developer runtime (§40.1.5).
const lockdownStart = performance.now();
lockdown({
  errorTaming: 'safe',
  overrideTaming: 'moderate',
  consoleTaming: 'safe',
});
const lockdownMs = performance.now() - lockdownStart;

// ---- §9.1.1 BoundedConsoleSink: fixed-size ring, batched LOG_BATCH frames,
// credit/ack from the Runtime, coalescing/drop accounting, and a reserved
// fatal path. The wire constants stay in sync with
// `packages/contracts/src/pluginRuntime.ts` (the worker tests pin them); the
// sink policy numbers are worker-local (the ring is the ONLY log buffer —
// §9.1.1 rule 5: no secondary unbounded queue behind it).
import {
  errorIdentity,
  makeBoundedFormatter,
  makeLogCredits,
  makeLogRing,
} from './consoleSink.mjs';

const LOG_BATCH_MAX_BYTES = 16 * 1024;
const LOG_BATCH_MAX_RECORDS = 256;
const LOG_MAX_MESSAGE_BYTES = 4000;
const CONSOLE_RING_BYTES = 64 * 1024;
const CONSOLE_RECORD_OVERHEAD_BYTES = 96;
const CONSOLE_FLUSH_THRESHOLD_BYTES = 4 * 1024;
const CONSOLE_FLUSH_INTERVAL_MS = 100;
const CONSOLE_LOG_INITIAL_CREDITS = 8;
const CONSOLE_LOG_MAX_CREDITS = 64;
// §9.1.2 bounded formatting. Depth/keys/items/string/record/stack bounds;
// the formatter never intentionally invokes getters and never throws.
const CONSOLE_FORMAT_MAX_DEPTH = 4;
const CONSOLE_FORMAT_MAX_KEYS = 16;
const CONSOLE_FORMAT_MAX_ITEMS = 32;
const CONSOLE_FORMAT_MAX_STRING_BYTES = 512;
const CONSOLE_FORMAT_MAX_STACK_FRAMES = 32;
const CONSOLE_FORMAT_MAX_VISITS = 4096;

const formatConsoleRecord = makeBoundedFormatter({
  maxDepth: CONSOLE_FORMAT_MAX_DEPTH,
  maxKeys: CONSOLE_FORMAT_MAX_KEYS,
  maxItems: CONSOLE_FORMAT_MAX_ITEMS,
  maxStringBytes: CONSOLE_FORMAT_MAX_STRING_BYTES,
  maxRecordBytes: LOG_MAX_MESSAGE_BYTES,
  maxStackFrames: CONSOLE_FORMAT_MAX_STACK_FRAMES,
  maxVisits: CONSOLE_FORMAT_MAX_VISITS,
});

const logRing = makeLogRing(CONSOLE_RING_BYTES, CONSOLE_RECORD_OVERHEAD_BYTES);
// §9.1.1 rules 7/8: the Runtime replenishes credits via log-batch-ack; the
// worker never accumulates payload beyond the ring when credit is spent.
const logCredits = makeLogCredits(CONSOLE_LOG_INITIAL_CREDITS, CONSOLE_LOG_MAX_CREDITS);
let logSeq = 0;

/**
 * Flush one LOG_BATCH (§9.1.1): drains the ring up to the batch bounds and
 * posts the worker-encoded payload (the worker is the single encode point;
 * the runtime forwards it opaque and the host decodes once — §15.1).
 * Without credit the worker does NOT accumulate additional payload: the ring
 * stays the only buffer and new records coalesce/drop (§9.1.1 rules 5/8).
 */
function flushLogBatch(force) {
  if (logRing.size === 0) return;
  if (!force && !logCredits.canFlush()) return;
  const records = logRing.drain(LOG_BATCH_MAX_RECORDS, LOG_BATCH_MAX_BYTES - 512);
  if (records.length === 0) return;
  const droppedCount = logRing.dropped;
  const payload = { seq: logSeq, droppedCount, records };
  let payloadBytes = null;
  try {
    payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  } catch {
    return;
  }
  if (payloadBytes.byteLength > LOG_BATCH_MAX_BYTES) {
    // Defense-in-depth: the batch cannot leave, so its records are counted
    // as suppressed (they are already out of the ring).
    logRing.countDropped(records.length);
    logSeq += 1;
    return;
  }
  logSeq += 1;
  if (!force) logCredits.consume();
  try {
    bridgePort.postMessage({
      kind: 'log-batch',
      workerId,
      workerEpoch,
      seq: payload.seq,
      droppedCount,
      payloadBytes,
    });
  } catch {
    // Port gone (supervisor already terminated us); best-effort drop.
  }
}

/** §9.1.4 fatal diagnostics: bounded envelope on the reserved path. */
function emitFatalDiagnostic(fatalKind, value) {
  let name = 'Error';
  let message = 'unknown';
  let stack = null;
  try {
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      // Same side-table-aware identity extraction as the log formatter
      // (§9.1.3): SES safe taming hides name/stack behind accessors.
      const identity = errorIdentity(value);
      name = identity.name;
      message = identity.message;
      stack = identity.stack;
    } else if (typeof value === 'string') {
      message = value;
    }
  } catch {
    // Keep defaults; the envelope must never fail to emit.
  }
  if (name.length > 256) name = name.slice(0, 256);
  if (message.length > 2000) message = message.slice(0, 2000);
  if (stack !== null && stack.length > 8000) stack = stack.slice(0, 8000);
  const envelope = {
    kind: 'fatal-diagnostic',
    workerId,
    workerEpoch,
    envelope: { kind: fatalKind, name, message, ...(stack !== null ? { stack } : {}) },
  };
  try {
    bridgePort.postMessage(envelope);
  } catch {
    // Port died with the thread; the stderr line below still survives.
  }
  try {
    process.stderr.write(
      `[neotavern-plugin-runtime] worker fatal ${workerId}/${workerEpoch}: ${fatalKind} ${name}: ${message}\n`,
    );
  } catch {
    // Nothing left to write to.
  }
}

// §26.1.3/§26.1.4 deterministic fatal policy. A fatal that fires while the
// module graph is still loading is reported through the reserved fatal path
// (§9.1.1 rule 10 — a log flood cannot displace it) and the worker stays up
// ONLY long enough to deliver the `module-graph-loaded` / `module-graph-error`
// report, because the host needs a deterministic activation outcome. After
// that report is out, any uncaught exception or unhandled rejection is
// Worker-fatal: report, then exit(1) — never continue in unknown state
// (§9.1.4/§26.1.3).
let moduleGraphReported = false;
let pendingFatalExit = false;

function onFatal(fatalKind, value) {
  emitFatalDiagnostic(fatalKind, value);
  if (moduleGraphReported) process.exit(1);
  pendingFatalExit = true;
}

process.on('uncaughtException', (error) => {
  onFatal('uncaught-exception', error);
});
process.on('unhandledRejection', (reason) => {
  onFatal('unhandled-rejection', reason);
});

function makeConsoleSink() {
  return Object.freeze({
    log: (...args) => emitConsole('log', args),
    info: (...args) => emitConsole('info', args),
    warn: (...args) => emitConsole('warn', args),
    error: (...args) => emitConsole('error', args),
    debug: (...args) => emitConsole('debug', args),
    trace: (...args) => emitConsole('trace', args),
  });
}

function emitConsole(level, args) {
  try {
    const message = formatConsoleRecord(args);
    logRing.push(level, message, Date.now());
    if (logRing.bytesUsed >= CONSOLE_FLUSH_THRESHOLD_BYTES) flushLogBatch(false);
  } catch {
    // The sink is synchronous from the plugin's point of view but must
    // never throw into plugin code (§9.1.1).
  }
}

// ---- Broker bridge (Stage C, ТЗ §10, §16).
// The hardened `bridge.invoke` endowment is the ONLY way plugin code reaches
// the Capability Broker. It builds the BrokerCallRequest envelope (caller
// identity comes from workerData, never from plugin input), bounds method,
// args (§15.11) and deadline (§10.1) and routes the reply by requestId.
const pendingCalls = new Map();
let callSequence = 0;

// §17 credit streams: in-flight response accumulators, keyed by requestId
// and bounded by RPC_STREAM_MAX_ACCUMULATED_BYTES (no unbounded queues).
const rpcResponseStreams = new Map();

function dropPendingCall(requestId) {
  pendingCalls.delete(requestId);
}

/**
 * Wait until import-time broker calls have gone quiet: two consecutive
 * quiescent polls mean no new call is being chained from a previous one
 * (e.g. `sdk.kv.set(...).then(() => sdk.kv.get(...))`). Bounded by timeout.
 */
function awaitPendingCallsDrained(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let idleStreak = 0;
  return new Promise((resolve) => {
    const poll = () => {
      if (pendingCalls.size === 0) {
        idleStreak += 1;
        if (idleStreak >= 2) {
          resolve();
          return;
        }
      } else {
        idleStreak = 0;
      }
      if (Date.now() >= deadline) {
        resolve();
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function brokerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function invokeBrokerCall(method, args, options) {
  if (typeof method !== 'string' || method.length === 0 || method.length > 256) {
    return Promise.reject(
      brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid broker method'),
    );
  }
  if (options === null || typeof options !== 'object') {
    return Promise.reject(
      brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid broker call options'),
    );
  }
  const capabilityName = options.capability;
  if (
    typeof capabilityName !== 'string' ||
    capabilityName.length === 0 ||
    capabilityName.length > 128
  ) {
    return Promise.reject(
      brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'capability name required'),
    );
  }
  let argsJson = null;
  try {
    argsJson = args === undefined ? null : JSON.stringify(args);
  } catch {
    return Promise.reject(
      brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'args not serializable'),
    );
  }
  if (argsJson !== null && argsJson.length > BROKER_MAX_ARGS_DATA_BYTES) {
    return Promise.reject(brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'args too large'));
  }
  // Stage F part 13: args above the control bound ride the data pipe as an
  // opaque RPC_REQUEST_DATA payload; the small case keeps the RPC_REQUEST
  // control frame (structured clone, no re-serialization).
  const dataPipeArgs = argsJson !== null && argsJson.length > BROKER_MAX_ARGS_BYTES;
  const rawDeadline = options.deadlineMs ?? BROKER_DEFAULT_DEADLINE_MS;
  const deadlineMs = Math.min(Math.max(1, rawDeadline), BROKER_MAX_DEADLINE_MS);
  let causalChain = [];
  if (options.causalChain !== undefined) {
    if (
      !Array.isArray(options.causalChain) ||
      options.causalChain.length > BROKER_MAX_CAUSAL_CHAIN
    ) {
      return Promise.reject(
        brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid causal chain'),
      );
    }
    causalChain = options.causalChain.filter(
      (entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 160,
    );
  }
  const requestId = `${workerId}-${workerEpoch}-${callSequence++}-${randomUUID().slice(0, 8)}`;
  const deadlineAt = Date.now() + deadlineMs;
  const call = {
    requestId,
    caller: { pluginId, installationId, trustLevel },
    method,
    ...(args === undefined ? {} : { args }),
    capability: {
      name: capabilityName,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
    },
    deadlineAt,
    causalChain,
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      dropPendingCall(requestId);
      reject(brokerError(BROKER_ERROR_CODE.CAPABILITY_REVOKED, 'call aborted by caller'));
    };
    pendingCalls.set(requestId, {
      resolve: (result) => {
        if (settled) return;
        settled = true;
        dropPendingCall(requestId);
        resolve(result);
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        dropPendingCall(requestId);
        reject(error);
      },
    });
    const signal = options.signal;
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      if (dataPipeArgs) {
        // Serialize the final wire body exactly once (§15.1) and hand it to
        // the runtime opaque; the host is the single decode point. The
        // metadata fields let the runtime's forwarding core admit/track the
        // call without decoding the payload.
        const payloadBytes = new TextEncoder().encode(
          JSON.stringify({ workerId, workerEpoch, call }),
        );
        bridgePort.postMessage({
          kind: 'rpc-request-data',
          requestId,
          pluginId: call.caller.pluginId,
          capabilityName: call.capability.name,
          causalChain,
          deadlineAt,
          payloadBytes,
        });
      } else {
        bridgePort.postMessage({ kind: 'rpc-request', call });
      }
    } catch {
      if (!settled) {
        settled = true;
        dropPendingCall(requestId);
        reject(brokerError(BROKER_ERROR_CODE.INTERNAL, 'bridge unavailable'));
      }
    }
  });
}

function handleRpcResponse(message) {
  if (message.responseBytes instanceof Uint8Array) {
    // Large-result transport (Stage F part 12): the runtime forwarded the
    // data-pipe payload opaque; this worker is the single decode point
    // (§15.1). A malformed payload is dropped — the call's own deadline
    // bounds how long the pending promise can wait.
    try {
      const parsed = JSON.parse(new TextDecoder().decode(message.responseBytes));
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.requestId !== 'string') {
        return;
      }
      message = {
        requestId: parsed.requestId,
        ok: parsed.ok === true,
        result: parsed.result,
        error: parsed.error,
      };
    } catch {
      return;
    }
  }
  const pending = pendingCalls.get(message.requestId);
  if (!pending) return; // stale or late reply after caller-side abort
  if (message.ok === true) {
    pending.resolve(message.result);
    return;
  }
  const wireError =
    message.error === null || typeof message.error !== 'object' ? {} : message.error;
  const code = typeof wireError.code === 'string' ? wireError.code : BROKER_ERROR_CODE.INTERNAL;
  const text = typeof wireError.message === 'string' ? wireError.message : 'broker call failed';
  pending.reject(brokerError(code, text));
}

/**
 * §17 credit streams (Stage F part 14): one chunk of a streamed response
 * body. The frame payload is `header JSON + NUL + raw chunk` (see
 * `PluginRuntimeRpcResponseStreamHeader`); the NUL is an unambiguous
 * separator because JSON text can never contain a raw NUL byte. This worker
 * is the single assembly and decode point (§15.1): chunks are accumulated in
 * a bounded buffer, credit is granted host-ward after each consumed chunk,
 * and the assembled body is decoded exactly once when the final chunk
 * arrives. Protocol violations (seq gaps, cap overflow, non-final head
 * frames) fail the call with VALIDATION_FAILED instead of hanging it.
 */
function handleRpcResponseStream(message) {
  const payloadBytes = message.payloadBytes;
  if (!(payloadBytes instanceof Uint8Array)) return;
  const nul = payloadBytes.indexOf(0);
  if (nul <= 0) return;
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(payloadBytes.subarray(0, nul)));
  } catch {
    return;
  }
  if (header === null || typeof header !== 'object') return;
  const { requestId, seq, final } = header;
  if (
    typeof requestId !== 'string' ||
    !Number.isInteger(seq) ||
    seq < 0 ||
    typeof final !== 'boolean'
  ) {
    return;
  }
  if (!pendingCalls.has(requestId)) return; // stale/late chunk: drop
  const chunk = payloadBytes.subarray(nul + 1);
  const existing = rpcResponseStreams.get(requestId);
  if (existing === undefined) {
    if (seq !== 0) {
      rejectResponseStream(requestId, 'response stream does not start at seq 0');
      return;
    }
    if (chunk.byteLength > RPC_STREAM_MAX_ACCUMULATED_BYTES) {
      rejectResponseStream(requestId, 'response stream chunk exceeds the accumulated cap');
      return;
    }
    rpcResponseStreams.set(requestId, {
      chunks: [chunk],
      totalBytes: chunk.byteLength,
      seq: 0,
    });
  } else {
    if (seq !== existing.seq + 1) {
      rejectResponseStream(requestId, 'response stream sequence gap');
      return;
    }
    if (existing.totalBytes + chunk.byteLength > RPC_STREAM_MAX_ACCUMULATED_BYTES) {
      rejectResponseStream(requestId, 'response stream exceeded the accumulated cap');
      return;
    }
    existing.chunks.push(chunk);
    existing.totalBytes += chunk.byteLength;
    existing.seq = seq;
  }
  if (final) {
    const record = rpcResponseStreams.get(requestId);
    rpcResponseStreams.delete(requestId);
    let assembled;
    if (record.chunks.length === 1) {
      assembled = record.chunks[0];
    } else {
      assembled = new Uint8Array(record.totalBytes);
      let offset = 0;
      for (const part of record.chunks) {
        assembled.set(part, offset);
        offset += part.byteLength;
      }
    }
    // Single decode (§15.1): the assembled bytes are the same
    // PluginRuntimeRpcResponseBody JSON as the control path.
    try {
      const parsed = JSON.parse(new TextDecoder().decode(assembled));
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.requestId !== 'string') {
        return;
      }
      handleRpcResponse({
        requestId: parsed.requestId,
        ok: parsed.ok === true,
        result: parsed.result,
        error: parsed.error,
      });
    } catch {
      return;
    }
    return;
  }
  // The consumer (this worker) consumed the chunk: grant credit host-ward so
  // the producer never creates the next chunk without a free window (§17).
  bridgePort.postMessage({
    kind: 'rpc-stream-credit',
    workerId,
    workerEpoch,
    requestId,
    bytes: chunk.byteLength,
  });
}

function rejectResponseStream(requestId, message) {
  rpcResponseStreams.delete(requestId);
  const pending = pendingCalls.get(requestId);
  if (pending) {
    pending.reject(brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, message));
  }
}

function makeRuntimeBridge() {
  return Object.freeze({
    invoke(method, args, options) {
      return invokeBrokerCall(method, args, options);
    },
  });
}

// ---- Core SDK (Stage D, ТЗ §12 catalog).
// The typed `sdk` endowment maps operations to (§12 capability, broker
// method) pairs from the same catalog the host executor validates against
// (`packages/contracts/src/sdkOps.ts`; the worker test pins the inline copy).
// Unlike raw `bridge.invoke`, `sdk` validates operation inputs here in the
// bootstrap, so malformed plugin calls never reach the wire (§15.11).
const SDK_OPERATION_CAPABILITY = {
  'storage.kv.get': 'storage.kv',
  'storage.kv.set': 'storage.kv',
  'storage.kv.delete': 'storage.kv',
  'storage.kv.list': 'storage.kv',
  'settings.get': 'settings.read',
  'settings.set': 'settings.write',
  // §18 events: core channel (no §12 grant); the label keeps the envelope
  // uniform so revoke/deadline/cycle handling applies to it as well.
  'events.replay': 'events',
  'events.subscribe': 'events',
  'events.unsubscribe': 'events',
  'network.http.fetch': 'network.http',
  'models.list': 'models.list',
  'chats.list': 'chats.read',
  'chats.read': 'chats.read',
  'characters.list': 'characters.read',
  'characters.read': 'characters.read',
  'lorebook.list': 'lorebook.read',
  'lorebook.read': 'lorebook.read',
  'lorebook.entries': 'lorebook.read',
  'database.core.query': 'database.core.read',
  // §30 Files API (Stage E): plugin-owned data directory scope.
  'files.read': 'files.plugin',
  'files.write': 'files.plugin',
  'files.stat': 'files.plugin',
  'files.list': 'files.plugin',
  'files.rename': 'files.plugin',
  'files.remove': 'files.plugin',
  // §29 Socket API (Stage E): each socket family has its own §12 capability;
  // destinations still pass the host's SSRF scope policy.
  'network.websocket.open': 'network.websocket',
  'network.websocket.send': 'network.websocket',
  'network.websocket.receive': 'network.websocket',
  'network.websocket.close': 'network.websocket',
  'network.tcp.connect': 'network.tcp',
  'network.tcp.send': 'network.tcp',
  'network.tcp.receive': 'network.tcp',
  'network.tcp.close': 'network.tcp',
  'network.listen.open': 'network.listen',
  'network.listen.accept': 'network.listen',
  'network.listen.close': 'network.listen',
  'network.udp.open': 'network.udp',
  'network.udp.send': 'network.udp',
  'network.udp.receive': 'network.udp',
  'network.udp.close': 'network.udp',
  // §13/§32 Process API (Stage E): scoped by default; unrestricted mode is
  // granted separately via system.unrestricted at the host.
  'process.spawn': 'process.spawn',
  'process.output': 'process.spawn',
  'process.signal': 'process.spawn',
  'process.wait': 'process.spawn',
  'process.close': 'process.spawn',
  // §19/§27 Jobs API (Stage E): host-side scheduler.
  'jobs.register': 'jobs.background',
  'jobs.cancel': 'jobs.background',
  'jobs.list': 'jobs.background',
  // §34 Services API (Stage E): brokered cross-plugin calls.
  'services.provide': 'services.provide',
  'services.connect': 'services.connect',
  'services.respond': 'services.provide',
  // §33 Secrets API (Stage E): Main Host keeps the tokens.
  'secrets.use': 'secrets.use',
  'secrets.manageOwn': 'secrets.manageOwn',
  'secrets.reveal': 'secrets.reveal',
};
const SDK_MAX_KV_KEY_BYTES = 512;
const SDK_MAX_KV_VALUE_BYTES = 8 * 1024 * 1024;
const SDK_MAX_SETTINGS_PATH_BYTES = 256;
const SDK_MAX_SETTINGS_VALUE_BYTES = 8 * 1024 * 1024;
const SDK_MAX_EVENT_NAME_BYTES = 128;
const SDK_MAX_EVENT_LIMIT = 64;
const SDK_MAX_EVENT_WAIT_MS = 5000;
const SDK_MAX_EVENT_SUBSCRIPTION_ID_BYTES = 64;
const SDK_EVENT_PUSH_QUEUE = 128;
const SDK_EVENT_LIVE_FALLBACK_WAIT_MS = 15000;
const SDK_MAX_NETWORK_URL_BYTES = 2048;
const SDK_MAX_NETWORK_HEADER_NAME_BYTES = 128;
const SDK_MAX_NETWORK_HEADER_VALUE_BYTES = 8 * 1024;
const SDK_MAX_NETWORK_BODY_BYTES = 8 * 1024 * 1024;
const SDK_NETWORK_MAX_HEADERS = 32;
// §29.1.5: opaque secret handle bound by the host executor; the plugin never
// sends secret values, only a handle id.
const SDK_MAX_NETWORK_SECRET_ID_BYTES = 128;
const SDK_MAX_PROVIDER_ID_BYTES = 64;
const SDK_MAX_CHATS_CURSOR_BYTES = 256;
const SDK_CHATS_MAX_LIST = 200;
const SDK_MAX_CHARACTERS_CURSOR_BYTES = 256;
const SDK_CHARACTERS_MAX_LIST = 200;
const SDK_MAX_LOREBOK_CURSOR_BYTES = 256;
const SDK_LOREBOK_MAX_LIST = 200;
const SDK_MAX_DB_SQL_BYTES = 4096;
const SDK_MAX_DB_PARAMS = 64;
// §30 Files API bounds (mirror the contracts; the host re-checks them).
const SDK_MAX_FILE_PATH_BYTES = 1024;
const SDK_MAX_FILE_CONTENT_BYTES = 4 * 1024 * 1024;
// §29 Socket API bounds (mirror the contracts).
const SDK_MAX_SOCKET_ID_BYTES = 64;
const SDK_MAX_SOCKET_MESSAGE_BYTES = 64 * 1024;
const SDK_MAX_SOCKET_HOST_BYTES = 255;
const SDK_MAX_SOCKET_RECEIVE = 64;
const SDK_SOCKET_WAIT_MS = 5000;
const SDK_MAX_WS_PROTOCOLS = 8;
// §13/§32 Process API bounds (mirror the contracts).
const SDK_MAX_EXECUTABLE_BYTES = 1024;
const SDK_MAX_ARGS = 64;
const SDK_MAX_ARG_BYTES = 1024;
const SDK_MAX_ENV = 64;
const SDK_MAX_ENV_KEY_BYTES = 128;
const SDK_MAX_ENV_VALUE_BYTES = 4096;
const SDK_MAX_CWD_BYTES = 1024;
const SDK_MAX_TIMEOUT_MS = 3600000;
const SDK_MAX_PROCESS_OUTPUT = 64;
const SDK_PROCESS_WAIT_MS = 5000;
// §19/§27 Jobs API bounds (mirror the contracts).
const SDK_MAX_JOBS = 8;
const SDK_MAX_JOB_NAME_BYTES = 128;
const SDK_MAX_JOB_PAYLOAD_BYTES = 64 * 1024;
const SDK_MIN_JOB_INTERVAL_MS = 100;
const SDK_MAX_JOB_INTERVAL_MS = 2147483647;
// §34 Services bounds (mirror the contracts).
const SDK_MAX_SERVICES = 8;
const SDK_MAX_SERVICE_PAYLOAD_BYTES = 16 * 1024;

function sdkCall(method, args) {
  const capability = SDK_OPERATION_CAPABILITY[method];
  if (capability === undefined) {
    return Promise.reject(
      brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, `unknown sdk operation: ${method}`),
    );
  }
  return invokeBrokerCall(method, args, { capability });
}

/** Validation errors (checked helpers throw) surface as rejections, so plugin
 * code handles them uniformly with `await`/`.catch` (§13 async API). */
function guardedSdkCall(method, buildArgs) {
  try {
    return sdkCall(method, buildArgs());
  } catch (error) {
    return Promise.reject(error);
  }
}

function sdkCheckedKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > SDK_MAX_KV_KEY_BYTES) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid kv key');
  }
  return key;
}

function sdkCheckedPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > SDK_MAX_SETTINGS_PATH_BYTES) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid settings path');
  }
  return path;
}

// §30 Files: plugin-relative POSIX paths only — absolute paths, drive
// letters, backslashes and `..` segments are rejected here (fail-fast) and
// re-verified by the host executor, which also checks symlink escapes.
function sdkCheckedFilePath(path) {
  if (path === '.') return path;
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > SDK_MAX_FILE_PATH_BYTES ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[a-z]:/iu.test(path)
  ) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid file path');
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid file path');
  }
  return path;
}

function sdkCheckedFileContent(content) {
  if (
    typeof content !== 'string' ||
    new TextEncoder().encode(content).length > SDK_MAX_FILE_CONTENT_BYTES
  ) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'file content exceeds the sdk bound');
  }
  return content;
}

function sdkCheckedSocketId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > SDK_MAX_SOCKET_ID_BYTES) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid socket id');
  }
  return id;
}

function sdkCheckedSocketData(data) {
  if (
    typeof data !== 'string' ||
    new TextEncoder().encode(data).length > SDK_MAX_SOCKET_MESSAGE_BYTES
  ) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'socket data exceeds the sdk bound');
  }
  return data;
}

function sdkCheckedSocketHost(host) {
  if (typeof host !== 'string' || host.length === 0 || host.length > SDK_MAX_SOCKET_HOST_BYTES) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid socket host');
  }
  return host;
}

function sdkCheckedSocketPort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid socket port');
  }
  return port;
}

function sdkCheckedSocketLimit(limit) {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > SDK_MAX_SOCKET_RECEIVE) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid socket receive limit');
  }
  return limit;
}

function sdkCheckedSocketWaitMs(waitMs) {
  if (waitMs === undefined) return undefined;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > SDK_SOCKET_WAIT_MS) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid socket waitMs');
  }
  return waitMs;
}

function sdkCheckedProcessExecutable(executable) {
  if (
    typeof executable !== 'string' ||
    executable.length === 0 ||
    executable.length > SDK_MAX_EXECUTABLE_BYTES ||
    !(executable.startsWith('/') || /^[a-z]:[\\/]/iu.test(executable))
  ) {
    // Absolute POSIX path or drive-letter path only; bare names are refused
    // so a PATH lookup can never resolve to an unexpected binary.
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'executable must be an absolute path');
  }
  return executable;
}

function sdkCheckedProcessArgs(args) {
  if (args === undefined) return undefined;
  if (
    !Array.isArray(args) ||
    args.length > SDK_MAX_ARGS ||
    args.some(
      (arg) => typeof arg !== 'string' || arg.length === 0 || arg.length > SDK_MAX_ARG_BYTES,
    )
  ) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid process args');
  }
  return args;
}

function sdkCheckedProcessCwd(cwd) {
  if (cwd === undefined) return undefined;
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > SDK_MAX_CWD_BYTES) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid process cwd');
  }
  return cwd;
}

function sdkCheckedProcessEnv(env) {
  if (env === undefined) return undefined;
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid process env');
  }
  const entries = Object.entries(env);
  if (entries.length > SDK_MAX_ENV) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'too many process env entries');
  }
  for (const [key, value] of entries) {
    if (
      key.length === 0 ||
      key.length > SDK_MAX_ENV_KEY_BYTES ||
      typeof value !== 'string' ||
      value.length > SDK_MAX_ENV_VALUE_BYTES
    ) {
      throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid process env entry');
    }
  }
  return env;
}

function sdkCheckedProcessTimeoutMs(timeoutMs) {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > SDK_MAX_TIMEOUT_MS) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid process timeoutMs');
  }
  return timeoutMs;
}

function sdkCheckedProcessOutputLimit(limit) {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > SDK_MAX_PROCESS_OUTPUT) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid process output limit');
  }
  return limit;
}

function sdkCheckedProcessWaitMs(waitMs) {
  if (waitMs === undefined) return undefined;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > SDK_PROCESS_WAIT_MS) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid process waitMs');
  }
  return waitMs;
}

function sdkCheckedJobName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > SDK_MAX_JOB_NAME_BYTES) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid job name');
  }
  return name;
}

function sdkCheckedJobInterval(intervalMs) {
  if (
    !Number.isInteger(intervalMs) ||
    intervalMs < SDK_MIN_JOB_INTERVAL_MS ||
    intervalMs > SDK_MAX_JOB_INTERVAL_MS
  ) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid job intervalMs');
  }
  return intervalMs;
}

function sdkCheckedJobAt(atMs) {
  if (!Number.isInteger(atMs) || atMs < 0 || atMs > SDK_MAX_JOB_INTERVAL_MS) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid job atMs');
  }
  return atMs;
}

function sdkCheckedValue(value, maxBytes) {
  try {
    const json = JSON.stringify(value);
    if (json === undefined || json.length > maxBytes) {
      throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'value exceeds the sdk size bound');
    }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === BROKER_ERROR_CODE.VALIDATION_FAILED) {
      throw error;
    }
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'value not serializable');
  }
  return value;
}

function sdkCheckedEventName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > SDK_MAX_EVENT_NAME_BYTES) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid event name');
  }
  return name;
}

function sdkCheckedEventCursor(cursor) {
  if (cursor === undefined || cursor === null) return undefined;
  if (!Number.isInteger(cursor) || cursor < 1) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid event cursor');
  }
  return cursor;
}

function sdkCheckedEventLimit(limit) {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > SDK_MAX_EVENT_LIMIT) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid event limit');
  }
  return limit;
}

function sdkCheckedEventWaitMs(waitMs) {
  if (waitMs === undefined) return undefined;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > SDK_MAX_EVENT_WAIT_MS) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid event waitMs');
  }
  return waitMs;
}

// ---- §18 live delivery (Stage F): sdk.events.subscribe.
// The subscription lives host-side; the host pushes `event-push` bridge
// messages over the runtime wire (HOST_BRIDGE_MESSAGE frames). This registry
// matches pushes to the plugin's async iterators. A bounded wait with a
// replay fallback keeps the iterator alive even if a push is lost (§18
// durable replay pacing): after LIVE_FALLBACK_WAIT without a push the
// iterator re-reads the ring from its last seq and dedupes.

const liveSubscriptions = new Map();

// ---- §19/§27 Jobs API (Stage E): worker-side onRun callbacks ----
// The plugin registers callbacks locally via `sdk.jobs.onRun(cb)`; the host
// fires scheduled jobs by pushing `job-run` bridge messages, which this
// registry dispatches to the matching callbacks. Bounded registrations
// (mirrors the host's JOBS_MAX_PER_PLUGIN).
const jobCallbacks = new Map();

function handleJobRun(message) {
  const envelope = message.envelope;
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    typeof envelope.jobId !== 'string' ||
    envelope.jobId.length === 0 ||
    typeof envelope.name !== 'string'
  ) {
    return;
  }
  const callback = jobCallbacks.get(envelope.jobId);
  if (callback === undefined) return;
  try {
    callback({
      jobId: envelope.jobId,
      name: envelope.name,
      payload: envelope.payload,
      scheduledAt: envelope.scheduledAt,
    });
  } catch (error) {
    // A broken job callback must not kill the worker; it surfaces through
    // the bounded console instead (§9.1.1).
    emitConsole('error', [
      `job handler failed (${envelope.jobId}):`,
      error instanceof Error ? error.message : String(error),
    ]);
  }
}

function makeJobsSdk() {
  const register = (options) => {
    const boundToken =
      options !== undefined &&
      options !== null &&
      typeof options === 'object' &&
      typeof options.onRun === 'object' &&
      options.onRun !== null &&
      typeof options.onRun.bind === 'function'
        ? options.onRun
        : null;
    return guardedSdkCall('jobs.register', () => {
      if (options === undefined || options === null || typeof options !== 'object') {
        throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid job options');
      }
      const args = { name: sdkCheckedJobName(options.name) };
      const hasInterval = options.intervalMs !== undefined;
      const hasAt = options.atMs !== undefined;
      if (hasInterval === hasAt) {
        throw brokerError(
          BROKER_ERROR_CODE.VALIDATION_FAILED,
          'jobs.register needs exactly one of intervalMs or atMs',
        );
      }
      if (hasInterval) args.intervalMs = sdkCheckedJobInterval(options.intervalMs);
      if (hasAt) args.atMs = sdkCheckedJobAt(options.atMs);
      if (options.payload !== undefined) {
        const json = JSON.stringify(options.payload);
        if (json === undefined || json.length > SDK_MAX_JOB_PAYLOAD_BYTES) {
          throw brokerError(
            BROKER_ERROR_CODE.VALIDATION_FAILED,
            'job payload exceeds the sdk bound',
          );
        }
        args.payload = options.payload;
      }
      return args;
    }).then((result) => {
      if (boundToken !== null && result !== null && typeof result === 'object') {
        const jobId = result.jobId;
        if (typeof jobId === 'string' && jobId.length > 0) boundToken.bind(jobId);
      }
      return result;
    });
  };
  const cancel = (jobId) =>
    guardedSdkCall('jobs.cancel', () => ({ jobId: sdkCheckedSocketId(jobId) })).then((result) => {
      jobCallbacks.delete(jobId);
      return result;
    });
  const list = () => guardedSdkCall('jobs.list', () => ({}));
  const onRun = (callback) => {
    if (typeof callback !== 'function') {
      throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'job callback must be a function');
    }
    return makeJobCallbackToken(callback);
  };
  return Object.freeze({ register, cancel, list, onRun });
}

// onRun returns a token; `jobs.register` accepts it as the `onRun` option so
// the jobId → callback binding is unambiguous:
//   const handle = sdk.jobs.onRun((e) => ...);
//   sdk.jobs.register({ name: 'x', intervalMs: 1000, onRun: handle });
function makeJobCallbackToken(callback) {
  let jobId = null;
  const token = {
    bind(jobIdValue) {
      jobId = jobIdValue;
      if (jobCallbacks.size >= SDK_MAX_JOBS) {
        throw brokerError(BROKER_ERROR_CODE.SERVICE_UNAVAILABLE, 'too many job callbacks');
      }
      jobCallbacks.set(jobIdValue, callback);
    },
    jobIdOf() {
      return jobId;
    },
  };
  return token;
}

// ---- §34 Services API (Stage E): brokered cross-plugin calls ----
// The plugin declares a service with `sdk.services.provide(options, handler)`;
// the host routes `service-call` bridge messages here. While a handler runs,
// `activeServiceChain` holds the causal chain (A→B→…) so nested
// `services.connect` calls append this plugin's id and the host rejects
// cycles with SERVICE_CALL_CYCLE (§26.2.1). The plugin execution model is a
// single actor, so one chain slot is the correct default (§26.2).
const serviceHandlers = new Map();
let activeServiceChain = [];

function handleServiceCall(message) {
  const envelope = message.envelope;
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    typeof envelope.callId !== 'string' ||
    envelope.callId.length === 0 ||
    typeof envelope.serviceId !== 'string' ||
    envelope.serviceId.length === 0 ||
    typeof envelope.method !== 'string'
  ) {
    return;
  }
  const handler = serviceHandlers.get(envelope.serviceId);
  if (handler === undefined) {
    respondServiceCall(envelope.callId, false, undefined, {
      code: BROKER_ERROR_CODE.NOT_FOUND,
      message: 'service handler not found',
    });
    return;
  }
  const chain =
    Array.isArray(envelope.chain) &&
    envelope.chain.every((entry) => typeof entry === 'string' && entry.length > 0)
      ? envelope.chain
      : [];
  const previousChain = activeServiceChain;
  activeServiceChain = chain;
  Promise.resolve()
    .then(() => handler(envelope.method, envelope.args))
    .then(
      (result) => {
        activeServiceChain = previousChain;
        respondServiceCall(envelope.callId, true, result, undefined);
      },
      (error) => {
        activeServiceChain = previousChain;
        respondServiceCall(envelope.callId, false, undefined, {
          code:
            error !== null && typeof error === 'object' && typeof error.code === 'string'
              ? error.code
              : 'INTERNAL',
          message:
            error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
        });
      },
    );
}

function respondServiceCall(callId, ok, result, error) {
  const args = { callId, ok };
  if (ok) args.result = result;
  else args.error = error;
  try {
    return invokeBrokerCall('services.respond', args, { capability: 'services.provide' });
  } catch {
    return Promise.resolve({ ok: false });
  }
}

function makeServicesSdk() {
  const provide = (options, handler) => {
    if (typeof handler !== 'function') {
      return Promise.reject(
        brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'service handler must be a function'),
      );
    }
    const args = guardedSdkCall('services.provide', () => {
      if (options === undefined || options === null || typeof options !== 'object') {
        throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid service options');
      }
      const result = {
        name: sdkCheckedServiceName(options.name),
        version: sdkCheckedServiceVersion(options.version),
        methods: sdkCheckedServiceMethods(options.methods),
      };
      return result;
    });
    return args.then((result) => {
      if (result !== null && typeof result === 'object') {
        const serviceId = result.serviceId;
        if (typeof serviceId === 'string' && serviceId.length > 0) {
          if (serviceHandlers.size >= SDK_MAX_SERVICES) {
            throw brokerError(BROKER_ERROR_CODE.SERVICE_UNAVAILABLE, 'too many service handlers');
          }
          serviceHandlers.set(serviceId, handler);
        }
      }
      return result;
    });
  };
  const connect = (options) => {
    let args;
    try {
      if (options === undefined || options === null || typeof options !== 'object') {
        throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid service call options');
      }
      args = {
        name: sdkCheckedServiceName(options.name),
        version: sdkCheckedServiceVersion(options.version),
        method: sdkCheckedServiceMethod(options.method),
      };
      if (options.args !== undefined) {
        const json = JSON.stringify(options.args);
        if (json === undefined || json.length > SDK_MAX_SERVICE_PAYLOAD_BYTES) {
          throw brokerError(
            BROKER_ERROR_CODE.VALIDATION_FAILED,
            'service call args exceed the sdk bound',
          );
        }
        args.args = options.args;
      }
      if (options.deadlineMs !== undefined) {
        if (
          !Number.isInteger(options.deadlineMs) ||
          options.deadlineMs < 1 ||
          options.deadlineMs > 300000
        ) {
          throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid service deadlineMs');
        }
        args.deadlineMs = options.deadlineMs;
      }
    } catch (error) {
      return Promise.reject(error);
    }
    // §26.2.1: forward the causal chain this worker received (the host
    // appends the caller id when pushing a service-call to the provider), so
    // the core and the host can both detect A→B→A deterministically. The
    // plugin's own id enters the chain only via the host's push.
    return invokeBrokerCall('services.connect', args, {
      capability: 'services.connect',
      causalChain: activeServiceChain,
    });
  };
  return Object.freeze({ provide, connect });
}

function sdkCheckedServiceName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid service name');
  }
  return name;
}

function sdkCheckedServiceVersion(version) {
  if (typeof version !== 'string' || version.length === 0 || version.length > 64) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid service version');
  }
  return version;
}

function sdkCheckedServiceMethod(method) {
  if (typeof method !== 'string' || method.length === 0 || method.length > 128) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid service method');
  }
  return method;
}

function sdkCheckedServiceMethods(methods) {
  if (!Array.isArray(methods) || methods.length === 0 || methods.length > 32) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid service methods');
  }
  const seen = new Set();
  for (const method of methods) {
    const checked = sdkCheckedServiceMethod(method);
    if (seen.has(checked)) {
      throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'duplicate service method');
    }
    seen.add(checked);
  }
  return methods;
}

// ---- §33 Secrets API (Stage E): opaque handles, Main Host keeps tokens ----
// `sdk.secrets.use({ connectionId })` returns an opaque handle bound to the
// connection's origin; pass it to `sdk.network.fetch(url, { secretId })`.
// `manageOwn` lists the plugin's own redacted connections; `reveal` returns
// the raw token and requires the trusted level (§11.3) — the host enforces
// it, the SDK just forwards the request.

const SDK_MAX_SECRET_CONNECTION_ID = 64;

function sdkCheckedConnectionId(connectionId) {
  if (
    typeof connectionId !== 'string' ||
    connectionId.length === 0 ||
    connectionId.length > SDK_MAX_SECRET_CONNECTION_ID
  ) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid connectionId');
  }
  return connectionId;
}

function makeSecretsSdk() {
  const use = (options) =>
    guardedSdkCall('secrets.use', () => {
      if (options === undefined || options === null || typeof options !== 'object') {
        throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid secrets.use options');
      }
      return { connectionId: sdkCheckedConnectionId(options.connectionId) };
    });
  const manageOwn = () => guardedSdkCall('secrets.manageOwn', () => ({}));
  const reveal = (options) =>
    guardedSdkCall('secrets.reveal', () => {
      if (options === undefined || options === null || typeof options !== 'object') {
        throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid secrets.reveal options');
      }
      return { connectionId: sdkCheckedConnectionId(options.connectionId) };
    });
  return Object.freeze({ use, manageOwn, reveal });
}

function handleEventPush(message) {
  const subscriptionId = message.subscriptionId;
  const sub =
    typeof subscriptionId === 'string' ? liveSubscriptions.get(subscriptionId) : undefined;
  if (sub === undefined || sub.closed) return;
  const envelope = message.envelope;
  // Structural guard: never forward garbage to the plugin (§15.11).
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    typeof envelope.seq !== 'number' ||
    !Number.isInteger(envelope.seq) ||
    envelope.seq < 1
  ) {
    return;
  }
  if (envelope.seq <= sub.lastSeq) return; // already consumed via replay
  if (sub.queue.length >= SDK_EVENT_PUSH_QUEUE) sub.queue.shift(); // bounded
  sub.queue.push(envelope);
  if (sub.wake !== null) {
    const wake = sub.wake;
    sub.wake = null;
    wake();
  }
}

function makeLiveSubscription(options, signal) {
  let name;
  let cursor;
  try {
    name = sdkCheckedEventName(options?.name);
    cursor = sdkCheckedEventCursor(options?.cursor);
  } catch (error) {
    return Promise.reject(error);
  }
  const args = { name };
  if (cursor !== undefined) args.cursor = cursor;

  const state = {
    id: null,
    name,
    lastSeq: cursor ?? 0,
    queue: [],
    wake: null,
    closed: false,
  };

  function close() {
    if (state.closed) return;
    state.closed = true;
    if (state.id !== null) liveSubscriptions.delete(state.id);
    if (state.wake !== null) {
      const wake = state.wake;
      state.wake = null;
      wake();
    }
    if (signal !== undefined) signal.removeEventListener('abort', onAbort);
    if (state.id !== null) {
      guardedSdkCall('events.unsubscribe', () => ({ subscriptionId: state.id })).catch(() => {
        // The host cleans up on worker death anyway; best-effort only.
      });
    }
  }

  const onAbort = () => close();

  async function next() {
    if (state.closed) return { done: true };
    for (;;) {
      while (state.queue.length > 0) {
        const envelope = state.queue.shift();
        if (envelope.seq <= state.lastSeq) continue; // dedupe vs replay
        state.lastSeq = envelope.seq;
        return { done: false, value: envelope };
      }
      if (state.closed) return { done: true };
      const outcome = await new Promise((resolveOutcome) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (state.wake === resolveOutcome) state.wake = null;
          resolveOutcome('timeout');
        }, SDK_EVENT_LIVE_FALLBACK_WAIT_MS);
        state.wake = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolveOutcome('wake');
        };
        if (state.closed) {
          clearTimeout(timer);
          resolveOutcome('closed');
        }
      });
      if (state.closed || outcome === 'closed') return { done: true };
      if (outcome === 'timeout') {
        // Fallback: bounded replay from the last seen seq catches anything
        // the push path lost while the ring window still covers it.
        try {
          const result = await guardedSdkCall('events.replay', () => ({
            name: state.name,
            ...(state.lastSeq > 0 ? { cursor: state.lastSeq } : {}),
            waitMs: 0,
          }));
          for (const envelope of result.events) {
            if (envelope.seq <= state.lastSeq) continue;
            if (state.queue.length < SDK_EVENT_PUSH_QUEUE) state.queue.push(envelope);
          }
        } catch {
          // Replay failed (revoke, deadline, shutdown): keep waiting on pushes.
        }
      }
    }
  }

  return guardedSdkCall('events.subscribe', () => args).then((result) => {
    const id = result === null || typeof result !== 'object' ? undefined : result.subscriptionId;
    if (
      typeof id !== 'string' ||
      id.length < 8 ||
      id.length > SDK_MAX_EVENT_SUBSCRIPTION_ID_BYTES
    ) {
      throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid subscription id');
    }
    if (state.closed) {
      // Aborted while the subscribe call was in flight: unsubscribe again.
      guardedSdkCall('events.unsubscribe', () => ({ subscriptionId: id })).catch(() => {});
      return Object.freeze({ next: async () => ({ done: true }), close });
    }
    state.id = id;
    liveSubscriptions.set(id, state);
    if (signal !== undefined) {
      if (signal.aborted) {
        close();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    const iterator = { next };
    return Object.freeze({
      [Symbol.asyncIterator]() {
        return iterator;
      },
      next,
      close,
    });
  });
}

function sdkCheckedNetworkUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > SDK_MAX_NETWORK_URL_BYTES) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid fetch url');
  }
  return url;
}

function sdkCheckedNetworkHeaders(headers) {
  if (headers === undefined || headers === null) return undefined;
  if (typeof headers !== 'object') {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid fetch headers');
  }
  const out = {};
  let count = 0;
  for (const [name, value] of Object.entries(headers)) {
    count += 1;
    if (count > SDK_NETWORK_MAX_HEADERS) {
      throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'too many fetch headers');
    }
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      name.length > SDK_MAX_NETWORK_HEADER_NAME_BYTES ||
      typeof value !== 'string' ||
      value.length > SDK_MAX_NETWORK_HEADER_VALUE_BYTES
    ) {
      throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid fetch header');
    }
    out[name] = value;
  }
  return out;
}

function sdkCheckedNetworkBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'string' || body.length > SDK_MAX_NETWORK_BODY_BYTES) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid fetch body');
  }
  return body;
}

function sdkCheckedNetworkRedirect(redirect) {
  if (redirect === undefined) return undefined;
  if (redirect !== 'follow' && redirect !== 'manual') {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid fetch redirect mode');
  }
  return redirect;
}

function sdkCheckedNetworkSecretId(secretId) {
  if (secretId === undefined) return undefined;
  if (
    typeof secretId !== 'string' ||
    secretId.length === 0 ||
    secretId.length > SDK_MAX_NETWORK_SECRET_ID_BYTES
  ) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid fetch secret handle');
  }
  return secretId;
}

function sdkCheckedProviderId(providerId) {
  if (
    typeof providerId !== 'string' ||
    providerId.length === 0 ||
    providerId.length > SDK_MAX_PROVIDER_ID_BYTES
  ) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid provider id');
  }
  return providerId;
}

function sdkCheckedChatsCursor(cursor) {
  if (cursor === undefined) return undefined;
  if (typeof cursor !== 'string' || cursor.length > SDK_MAX_CHATS_CURSOR_BYTES) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid chats cursor');
  }
  return cursor;
}

function sdkCheckedChatsLimit(limit) {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > SDK_CHATS_MAX_LIST) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid chats limit');
  }
  return limit;
}

function sdkCheckedChatsCharacterId(characterId) {
  if (characterId === undefined) return undefined;
  if (
    typeof characterId !== 'string' ||
    characterId.length === 0 ||
    characterId.length > SDK_MAX_PROVIDER_ID_BYTES
  ) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid chats characterId');
  }
  return characterId;
}

function sdkCheckedChatId(chatId) {
  if (
    typeof chatId !== 'string' ||
    chatId.length === 0 ||
    chatId.length > SDK_MAX_PROVIDER_ID_BYTES
  ) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid chat id');
  }
  return chatId;
}

function sdkCheckedCharactersCursor(cursor) {
  if (cursor === undefined) return undefined;
  if (typeof cursor !== 'string' || cursor.length > SDK_MAX_CHARACTERS_CURSOR_BYTES) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid characters cursor');
  }
  return cursor;
}

function sdkCheckedCharactersLimit(limit) {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > SDK_CHARACTERS_MAX_LIST) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid characters limit');
  }
  return limit;
}

function sdkCheckedCharacterId(characterId) {
  if (
    typeof characterId !== 'string' ||
    characterId.length === 0 ||
    characterId.length > SDK_MAX_PROVIDER_ID_BYTES
  ) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid character id');
  }
  return characterId;
}

function sdkCheckedLorebookCursor(cursor) {
  if (cursor === undefined) return undefined;
  if (typeof cursor !== 'string' || cursor.length > SDK_MAX_LOREBOK_CURSOR_BYTES) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid lorebook cursor');
  }
  return cursor;
}

function sdkCheckedLorebookLimit(limit) {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > SDK_LOREBOK_MAX_LIST) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid lorebook limit');
  }
  return limit;
}

function sdkCheckedLorebookId(bookId) {
  if (
    typeof bookId !== 'string' ||
    bookId.length === 0 ||
    bookId.length > SDK_MAX_PROVIDER_ID_BYTES
  ) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid lorebook id');
  }
  return bookId;
}

function sdkCheckedSql(sql) {
  if (typeof sql !== 'string' || sql.length === 0 || sql.length > SDK_MAX_DB_SQL_BYTES) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid sql');
  }
  return sql;
}

function sdkCheckedParams(params) {
  if (params === undefined) return [];
  if (!Array.isArray(params) || params.length > SDK_MAX_DB_PARAMS) {
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid sql params');
  }
  for (const param of params) {
    if (param === null || typeof param === 'string' || typeof param === 'boolean') continue;
    if (typeof param === 'number' && Number.isFinite(param)) continue;
    throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid sql param value');
  }
  return params;
}

function makeSdk() {
  const kv = Object.freeze({
    get(key) {
      return guardedSdkCall('storage.kv.get', () => ({ key: sdkCheckedKey(key) }));
    },
    set(key, value) {
      return guardedSdkCall('storage.kv.set', () => ({
        key: sdkCheckedKey(key),
        value: sdkCheckedValue(value, SDK_MAX_KV_VALUE_BYTES),
      }));
    },
    delete(key) {
      return guardedSdkCall('storage.kv.delete', () => ({ key: sdkCheckedKey(key) }));
    },
    list() {
      return guardedSdkCall('storage.kv.list', () => ({}));
    },
  });
  const settings = Object.freeze({
    get(path) {
      return guardedSdkCall('settings.get', () => ({ path: sdkCheckedPath(path) }));
    },
    set(path, value) {
      return guardedSdkCall('settings.set', () => ({
        path: sdkCheckedPath(path),
        value: sdkCheckedValue(value, SDK_MAX_SETTINGS_VALUE_BYTES),
      }));
    },
  });
  const events = Object.freeze({
    // Pull-based cursor/replay (§18, ADR-0025 §J1). Host emits; the plugin
    // asks for events after its last seen seq, optionally waiting (bounded)
    // for the next one.
    replay(options) {
      return guardedSdkCall('events.replay', () => {
        if (options === undefined || options === null || typeof options !== 'object') {
          throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid event replay options');
        }
        const args = {
          name: sdkCheckedEventName(options.name),
          limit: sdkCheckedEventLimit(options.limit),
          waitMs: sdkCheckedEventWaitMs(options.waitMs),
        };
        if (options.cursor !== undefined && options.cursor !== null) {
          args.cursor = sdkCheckedEventCursor(options.cursor);
        }
        return args;
      });
    },
    // §18 live delivery (Stage F): async-iterator subscription. Resolves to
    // a handle with `next()` / `close()` / `[Symbol.asyncIterator]`; events
    // are pushed host-ward in real time, with a bounded replay fallback if
    // a push is lost. `signal` (optional AbortSignal) closes the iterator.
    subscribe(options, signal) {
      return makeLiveSubscription(options, signal);
    },
  });
  const network = Object.freeze({
    fetch(url, options) {
      return guardedSdkCall('network.http.fetch', () => {
        if (options === undefined || options === null || typeof options !== 'object') {
          options = {};
        }
        const args = { url: sdkCheckedNetworkUrl(url) };
        const method = options.method;
        if (method !== undefined) {
          if (
            typeof method !== 'string' ||
            !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)
          ) {
            throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid fetch method');
          }
          args.method = method;
        }
        const headers = sdkCheckedNetworkHeaders(options.headers);
        if (headers !== undefined) args.headers = headers;
        const body = sdkCheckedNetworkBody(options.body);
        if (body !== undefined) args.body = body;
        const redirect = sdkCheckedNetworkRedirect(options.redirect);
        if (redirect !== undefined) args.redirect = redirect;
        const secretId = sdkCheckedNetworkSecretId(options.secretId);
        if (secretId !== undefined) args.secretId = secretId;
        return args;
      });
    },
    // §29 Socket API (Stage E): handle-based ws/tcp/listen/udp over the
    // broker. The plugin never touches raw Node sockets.
    websocket: Object.freeze({
      open(url, options) {
        return guardedSdkCall('network.websocket.open', () => {
          const args = { url: sdkCheckedNetworkUrl(url) };
          if (options !== undefined && options !== null && typeof options === 'object') {
            const protocols = options.protocols;
            if (protocols !== undefined) {
              if (
                !Array.isArray(protocols) ||
                protocols.length > SDK_MAX_WS_PROTOCOLS ||
                protocols.some(
                  (protocol) =>
                    typeof protocol !== 'string' || protocol.length === 0 || protocol.length > 64,
                )
              ) {
                throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid ws protocols');
              }
              args.protocols = protocols;
            }
          }
          return args;
        });
      },
      send(id, data) {
        return guardedSdkCall('network.websocket.send', () => ({
          id: sdkCheckedSocketId(id),
          data: sdkCheckedSocketData(data),
        }));
      },
      receive(id, options) {
        return guardedSdkCall('network.websocket.receive', () => ({
          id: sdkCheckedSocketId(id),
          limit: sdkCheckedSocketLimit(options?.limit),
          waitMs: sdkCheckedSocketWaitMs(options?.waitMs),
        }));
      },
      close(id) {
        return guardedSdkCall('network.websocket.close', () => ({ id: sdkCheckedSocketId(id) }));
      },
    }),
    tcp: Object.freeze({
      connect(host, port, options) {
        return guardedSdkCall('network.tcp.connect', () => {
          const args = {
            host: sdkCheckedSocketHost(host),
            port: sdkCheckedSocketPort(port),
          };
          if (options !== undefined && options !== null && typeof options === 'object') {
            if (options.tls === true) args.tls = true;
          }
          return args;
        });
      },
      send(id, data) {
        return guardedSdkCall('network.tcp.send', () => ({
          id: sdkCheckedSocketId(id),
          data: sdkCheckedSocketData(data),
        }));
      },
      receive(id, options) {
        return guardedSdkCall('network.tcp.receive', () => ({
          id: sdkCheckedSocketId(id),
          limit: sdkCheckedSocketLimit(options?.limit),
          waitMs: sdkCheckedSocketWaitMs(options?.waitMs),
        }));
      },
      close(id) {
        return guardedSdkCall('network.tcp.close', () => ({ id: sdkCheckedSocketId(id) }));
      },
    }),
    listen: Object.freeze({
      open(options) {
        return guardedSdkCall('network.listen.open', () => {
          const args = {};
          if (options !== undefined && options !== null && typeof options === 'object') {
            if (options.host !== undefined) args.host = sdkCheckedSocketHost(options.host);
            if (options.port !== undefined) args.port = sdkCheckedSocketPort(options.port);
          }
          return args;
        });
      },
      accept(id, options) {
        return guardedSdkCall('network.listen.accept', () => ({
          id: sdkCheckedSocketId(id),
          waitMs: sdkCheckedSocketWaitMs(options?.waitMs),
        }));
      },
      close(id) {
        return guardedSdkCall('network.listen.close', () => ({ id: sdkCheckedSocketId(id) }));
      },
    }),
    udp: Object.freeze({
      open(options) {
        return guardedSdkCall('network.udp.open', () => {
          const args = {};
          if (options !== undefined && options !== null && typeof options === 'object') {
            if (options.bindHost !== undefined)
              args.bindHost = sdkCheckedSocketHost(options.bindHost);
            if (options.bindPort !== undefined)
              args.bindPort = sdkCheckedSocketPort(options.bindPort);
          }
          return args;
        });
      },
      send(id, data, host, port) {
        return guardedSdkCall('network.udp.send', () => ({
          id: sdkCheckedSocketId(id),
          data: sdkCheckedSocketData(data),
          host: sdkCheckedSocketHost(host),
          port: sdkCheckedSocketPort(port),
        }));
      },
      receive(id, options) {
        return guardedSdkCall('network.udp.receive', () => ({
          id: sdkCheckedSocketId(id),
          waitMs: sdkCheckedSocketWaitMs(options?.waitMs),
        }));
      },
      close(id) {
        return guardedSdkCall('network.udp.close', () => ({ id: sdkCheckedSocketId(id) }));
      },
    }),
  });
  // §13/§32 Process API (Stage E): scoped spawn by default; unrestricted
  // mode requires the separate `system.unrestricted` host grant (§32.2).
  // `shell` and `detached` are structurally impossible — the SDK has no such
  // options and the host always spawns shell:false, detached:false.
  const processApi = Object.freeze({
    spawn(options) {
      return guardedSdkCall('process.spawn', () => {
        if (options === undefined || options === null || typeof options !== 'object') {
          throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid spawn options');
        }
        const args = { executable: sdkCheckedProcessExecutable(options.executable) };
        const procArgs = sdkCheckedProcessArgs(options.args);
        if (procArgs !== undefined) args.args = procArgs;
        const cwd = sdkCheckedProcessCwd(options.cwd);
        if (cwd !== undefined) args.cwd = cwd;
        const env = sdkCheckedProcessEnv(options.env);
        if (env !== undefined) args.env = env;
        const timeoutMs = sdkCheckedProcessTimeoutMs(options.timeoutMs);
        if (timeoutMs !== undefined) args.timeoutMs = timeoutMs;
        if (options.stdout !== undefined) {
          if (options.stdout !== 'capture' && options.stdout !== 'ignore') {
            throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid stdout mode');
          }
          args.stdout = options.stdout;
        }
        if (options.stderr !== undefined) {
          if (options.stderr !== 'capture' && options.stderr !== 'ignore') {
            throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid stderr mode');
          }
          args.stderr = options.stderr;
        }
        return args;
      });
    },
    output(id, options) {
      return guardedSdkCall('process.output', () => ({
        id: sdkCheckedSocketId(id),
        limit: sdkCheckedProcessOutputLimit(options?.limit),
        waitMs: sdkCheckedProcessWaitMs(options?.waitMs),
      }));
    },
    signal(id, signal) {
      return guardedSdkCall('process.signal', () => {
        if (signal !== 'SIGTERM' && signal !== 'SIGKILL' && signal !== 'SIGINT') {
          throw brokerError(BROKER_ERROR_CODE.VALIDATION_FAILED, 'invalid process signal');
        }
        return { id: sdkCheckedSocketId(id), signal };
      });
    },
    wait(id, options) {
      return guardedSdkCall('process.wait', () => ({
        id: sdkCheckedSocketId(id),
        waitMs: sdkCheckedProcessWaitMs(options?.waitMs),
      }));
    },
    close(id) {
      return guardedSdkCall('process.close', () => ({ id: sdkCheckedSocketId(id) }));
    },
  });
  const models = Object.freeze({
    list(providerId) {
      return guardedSdkCall('models.list', () => ({
        providerId: sdkCheckedProviderId(providerId),
      }));
    },
  });
  const chats = Object.freeze({
    list(options) {
      return guardedSdkCall('chats.list', () => {
        const args = {};
        const cursor = sdkCheckedChatsCursor(options?.cursor);
        if (cursor !== undefined) args.cursor = cursor;
        const limit = sdkCheckedChatsLimit(options?.limit);
        if (limit !== undefined) args.limit = limit;
        const characterId = sdkCheckedChatsCharacterId(options?.characterId);
        if (characterId !== undefined) args.characterId = characterId;
        return args;
      });
    },
    read(chatId) {
      return guardedSdkCall('chats.read', () => ({
        chatId: sdkCheckedChatId(chatId),
      }));
    },
  });
  const characters = Object.freeze({
    list(options) {
      return guardedSdkCall('characters.list', () => {
        const args = {};
        const cursor = sdkCheckedCharactersCursor(options?.cursor);
        if (cursor !== undefined) args.cursor = cursor;
        const limit = sdkCheckedCharactersLimit(options?.limit);
        if (limit !== undefined) args.limit = limit;
        return args;
      });
    },
    read(characterId) {
      return guardedSdkCall('characters.read', () => ({
        characterId: sdkCheckedCharacterId(characterId),
      }));
    },
  });
  const lorebook = Object.freeze({
    list(options) {
      return guardedSdkCall('lorebook.list', () => {
        const args = {};
        const cursor = sdkCheckedLorebookCursor(options?.cursor);
        if (cursor !== undefined) args.cursor = cursor;
        const limit = sdkCheckedLorebookLimit(options?.limit);
        if (limit !== undefined) args.limit = limit;
        const characterId = sdkCheckedChatsCharacterId(options?.characterId);
        if (characterId !== undefined) args.characterId = characterId;
        return args;
      });
    },
    read(bookId) {
      return guardedSdkCall('lorebook.read', () => ({
        bookId: sdkCheckedLorebookId(bookId),
      }));
    },
    entries(bookId) {
      return guardedSdkCall('lorebook.entries', () => ({
        bookId: sdkCheckedLorebookId(bookId),
      }));
    },
  });
  const db = Object.freeze({
    query(sql, params) {
      return guardedSdkCall('database.core.query', () => ({
        sql: sdkCheckedSql(sql),
        params: sdkCheckedParams(params),
      }));
    },
  });
  // §30 Files API (Stage E): plugin-owned data directory. All paths are
  // plugin-relative; the host confines every operation to the plugin root.
  const files = Object.freeze({
    read(path) {
      return guardedSdkCall('files.read', () => ({ path: sdkCheckedFilePath(path) }));
    },
    write(path, content) {
      return guardedSdkCall('files.write', () => ({
        path: sdkCheckedFilePath(path),
        content: sdkCheckedFileContent(content),
      }));
    },
    stat(path) {
      return guardedSdkCall('files.stat', () => ({ path: sdkCheckedFilePath(path) }));
    },
    list(path) {
      return guardedSdkCall('files.list', () => ({ path: sdkCheckedFilePath(path) }));
    },
    rename(from, to) {
      return guardedSdkCall('files.rename', () => ({
        from: sdkCheckedFilePath(from),
        to: sdkCheckedFilePath(to),
      }));
    },
    remove(path) {
      return guardedSdkCall('files.remove', () => ({ path: sdkCheckedFilePath(path) }));
    },
  });
  return Object.freeze({
    kv,
    settings,
    events,
    network,
    models,
    chats,
    characters,
    lorebook,
    db,
    files,
    process: processApi,
    jobs: makeJobsSdk(),
    services: makeServicesSdk(),
    secrets: makeSecretsSdk(),
  });
}

// Vetted endowments (§5.4, ADR-0028): the compartment receives no process,
// no require, no Buffer, no fetch, no WebSocket, no SharedArrayBuffer, no raw
// WebAssembly and no ambient timers. Timers arrive via the host registry
// (Stage A). Text/URL/Abort primitives are untouched Web-IDL globals.
const endowments = Object.freeze({
  console: makeConsoleSink(),
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
  queueMicrotask: globalThis.queueMicrotask,
  // The ONLY bridge into the Capability Broker (§10 flow): plugin code cannot
  // reach the runtime supervisor or the host by any other means.
  bridge: makeRuntimeBridge(),
  // Typed Core SDK (Stage D): capability-checked operations over the bridge.
  sdk: makeSdk(),
});

// ---- Phase 2: one Compartment per Worker (§5.4, ADR-0027).
// The plugin module graph arrives over the bridge AFTER hardened-ready
// (§15.8: workerData stays small). The compartment's import/resolve hooks
// close over this mutable state and serve ONLY the signed graph once set.
const graphState = { graph: null };

function resolveHook(specifier, referrer) {
  const prepared = graphState.graph;
  if (prepared === null) {
    throw graphError(MODULE_ERROR_CODE.MODULE_NOT_IN_GRAPH, {
      specifier,
      detail: 'module graph not loaded',
    });
  }
  const referrerRecord = prepared.byLocation.get(referrer);
  if (referrerRecord === undefined) {
    throw graphError(MODULE_ERROR_CODE.MODULE_NOT_IN_GRAPH, { specifier, referrer });
  }
  // All resolution happened in the trusted builder; the worker is a pure
  // lookup over the signed graph (§8.9). Dynamic imports are builder-signed
  // too (§6.4), so unknown specifiers are rejected here.
  const resolvedId = referrerRecord.resolvedImports[specifier];
  if (resolvedId === undefined) {
    throw graphError(MODULE_ERROR_CODE.MODULE_NOT_IN_GRAPH, { specifier, referrer });
  }
  return moduleLocation(prepared.pluginId, resolvedId);
}

async function importHook(specifier) {
  const prepared = graphState.graph;
  if (prepared === null) {
    throw graphError(MODULE_ERROR_CODE.MODULE_NOT_IN_GRAPH, {
      specifier,
      detail: 'module graph not loaded',
    });
  }
  const record = prepared.byLocation.get(specifier);
  if (record === undefined) {
    throw graphError(MODULE_ERROR_CODE.MODULE_NOT_IN_GRAPH, { specifier });
  }
  if (typeof record.source !== 'string') {
    throw graphError(MODULE_ERROR_CODE.PACKAGE_INVALID, {
      id: record.id,
      detail: 'record carries no source payload',
    });
  }
  const digest = sha256Hex(record.source);
  if (digest !== record.digest) {
    throw graphError(MODULE_ERROR_CODE.MODULE_DIGEST_MISMATCH, { id: record.id });
  }
  if (record.kind === 'json') {
    try {
      JSON.parse(record.source);
    } catch {
      throw graphError(MODULE_ERROR_CODE.PACKAGE_INVALID, {
        id: record.id,
        detail: 'invalid JSON module',
      });
    }
    return new ModuleSource(`export default ${record.source}`, record.location);
  }
  try {
    return new ModuleSource(record.source, record.location);
  } catch (error) {
    throw graphError(MODULE_ERROR_CODE.PACKAGE_INVALID, {
      id: record.id,
      detail: 'not valid SES-compatible ES module',
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

const compartmentStart = performance.now();
const pluginCompartment = new Compartment(
  endowments,
  {},
  { resolveHook, importHook, noAggregateLoadErrors: true },
);
const compartmentMs = performance.now() - compartmentStart;

// Stage A gate: prove no Node authority is visible to plugin code (§53, B16).
const PROBE_SOURCE = `(() => ({
  process: typeof process,
  require: typeof require,
  buffer: typeof Buffer,
  fetch: typeof fetch,
  setInterval: typeof setInterval,
  webAssembly: typeof WebAssembly,
  worker: typeof Worker,
  sharedArrayBuffer: typeof SharedArrayBuffer,
  hasCompartment: typeof Compartment,
  marker: (() => { const box = { value: 1 }; return box.value + 1; })(),
}))()`;

let probeResult = null;
try {
  probeResult = pluginCompartment.evaluate(PROBE_SOURCE);
} catch (error) {
  emitConsole('error', [
    'compartment probe failed:',
    error instanceof Error ? error.message : String(error),
  ]);
}

const visible = (name) => probeResult !== null && probeResult[name] !== 'undefined';
const probe = {
  process: visible('process'),
  require: visible('require'),
  buffer: visible('buffer'),
  fetch: visible('fetch'),
  setInterval: visible('setInterval'),
  webAssembly: visible('webAssembly'),
  worker: visible('worker'),
  sharedArrayBuffer: visible('sharedArrayBuffer'),
  hasCompartment: probeResult !== null && probeResult.hasCompartment !== 'undefined',
  marker: probeResult === null ? -1 : Number(probeResult.marker),
};
const authorityNames = [
  'process',
  'require',
  'buffer',
  'fetch',
  'setInterval',
  'webAssembly',
  'worker',
  'sharedArrayBuffer',
];
const noNodeAuthority =
  probeResult !== null && probe.marker === 2 && authorityNames.every((name) => !probe[name]);

const bootstrapMs = performance.now() - bootstrapStart;

bridgePort.postMessage({
  kind: 'hardened-ready',
  workerId,
  workerEpoch,
  lockdownMs,
  compartmentMs,
  bootstrapMs,
  noNodeAuthority,
  probe,
  // §22/§40 diagnostics: the emergency ceiling this worker was spawned with.
  // The trusted bootstrap reads it from worker_threads; the plugin
  // Compartment never sees it.
  emergencyLimits: {
    maxOldGenerationSizeMb: resourceLimits.maxOldGenerationSizeMb ?? 0,
    maxYoungGenerationSizeMb: resourceLimits.maxYoungGenerationSizeMb ?? 0,
  },
});

// The port keeps the thread alive. On terminate we ack and exit cleanly; the
// supervisor force-terminates the thread as the two-phase fallback (§25.1).
bridgePort.on('message', (message) => {
  if (message === null || typeof message !== 'object') return;
  if (message.kind === 'terminate') {
    // Best-effort final batch so the last plugin logs are not lost (§9.1.1).
    flushLogBatch(true);
    bridgePort.postMessage({ kind: 'terminate-ack', workerId, workerEpoch });
    process.exit(0);
  } else if (message.kind === 'log-batch-ack') {
    // §9.1.1 rule 7/8: the Runtime replenishes log credits; without credit
    // the worker stops flushing (the ring is the only log buffer).
    logCredits.replenish();
    flushLogBatch(false);
  } else if (message.kind === 'load-module-graph') {
    handleLoadModuleGraph(message);
  } else if (message.kind === 'rpc-response') {
    handleRpcResponse(message);
  } else if (message.kind === 'rpc-response-stream') {
    handleRpcResponseStream(message);
  } else if (message.kind === 'event-push') {
    handleEventPush(message);
  } else if (message.kind === 'job-run') {
    handleJobRun(message);
  } else if (message.kind === 'service-call') {
    handleServiceCall(message);
  }
});

// Periodic flush for ring content below the threshold (§9.1.1 batching).
setInterval(() => flushLogBatch(false), CONSOLE_FLUSH_INTERVAL_MS);

// ---- Plugin module-graph loading (Stage B, ТЗ §6, §8.6).
// The runtime posts a serialized signed graph; the worker validates the
// shape, verifies per-module digests and evaluates the entry module inside
// the plugin Compartment. Result: the entry export names plus a JSON-safe
// snapshot of serializable exports. Capability calls go through the
// `bridge.invoke` endowment (Stage C, §10) while the graph evaluates.

function prepareGraph(graph) {
  if (graph === null || typeof graph !== 'object') {
    throw graphError(MODULE_ERROR_CODE.PACKAGE_INVALID, { detail: 'graph must be an object' });
  }
  const { pluginId: graphPluginId, entry, records } = graph;
  if (typeof graphPluginId !== 'string' || graphPluginId.length === 0) {
    throw graphError(MODULE_ERROR_CODE.PACKAGE_INVALID, { detail: 'pluginId is required' });
  }
  if (typeof entry !== 'string' || entry.length === 0) {
    throw graphError(MODULE_ERROR_CODE.PACKAGE_INVALID, { detail: 'entry is required' });
  }
  if (!Array.isArray(records)) {
    throw graphError(MODULE_ERROR_CODE.PACKAGE_INVALID, { detail: 'records must be an array' });
  }
  const byLocation = new Map();
  for (const record of records) {
    if (
      record === null ||
      typeof record !== 'object' ||
      typeof record.id !== 'string' ||
      typeof record.location !== 'string' ||
      record.resolvedImports === null ||
      typeof record.resolvedImports !== 'object'
    ) {
      throw graphError(MODULE_ERROR_CODE.PACKAGE_INVALID, { detail: 'malformed module record' });
    }
    byLocation.set(record.location, record);
  }
  const entryLocation = moduleLocation(graphPluginId, entry);
  if (!byLocation.has(entryLocation)) {
    throw graphError(MODULE_ERROR_CODE.MODULE_NOT_IN_GRAPH, {
      specifier: entryLocation,
      detail: 'entry module is not present in the graph',
    });
  }
  return { pluginId: graphPluginId, entry, byLocation };
}

function snapshotNamespace(namespace) {
  const snapshot = {};
  for (const key of Object.keys(namespace)) {
    const value = namespace[key];
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') continue;
    try {
      const serialized = JSON.parse(JSON.stringify(value));
      if (serialized !== undefined) snapshot[key] = serialized;
    } catch {
      // Non-serializable export (circular, exotic); omitted from the snapshot.
    }
  }
  return snapshot;
}

function errorToWire(error) {
  const knownCodes = {
    ...MODULE_ERROR_CODE,
    ...BROKER_ERROR_CODE,
  };
  const code =
    error !== null &&
    typeof error === 'object' &&
    typeof error.code === 'string' &&
    Object.prototype.hasOwnProperty.call(knownCodes, error.code)
      ? error.code
      : MODULE_ERROR_CODE.MODULE_EVALUATION_FAILED;
  let stack = null;
  try {
    if (error instanceof Error && typeof error.stack === 'string') {
      stack = error.stack;
    }
  } catch {
    stack = null;
  }
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    stack,
  };
}

function handleLoadModuleGraph(message) {
  let graph;
  try {
    if (
      message !== null &&
      typeof message === 'object' &&
      message.graphBytes instanceof Uint8Array
    ) {
      // Large-graph transport (Stage F part 11): the runtime forwarded the
      // data-pipe payload opaque; this worker is the single decode point
      // (§15.1). The payload mirrors the MODULE_GRAPH control body
      // ({ workerId, workerEpoch, graph }); the data-pipe cap bounds input.
      const parsed = JSON.parse(new TextDecoder().decode(message.graphBytes));
      graph =
        parsed !== null && typeof parsed === 'object' && 'graph' in parsed ? parsed.graph : parsed;
    } else if (message !== null && typeof message === 'object' && 'graph' in message) {
      graph = message.graph;
    } else {
      graph = message;
    }
    const prepared = prepareGraph(graph);
    graphState.graph = prepared;
    const entryLocation = moduleLocation(prepared.pluginId, prepared.entry);
    pluginCompartment.import(entryLocation).then(
      async ({ namespace }) => {
        // No top-level await in Compartments: import-time broker calls
        // settle after the import promise. Report the load only once they
        // settled (bounded) so the host can observe their results.
        await awaitPendingCallsDrained(BROKER_IMPORT_CALL_DRAIN_MS);
        // The snapshot is diagnostic metadata; a huge export must not blow
        // the BRIDGE_MESSAGE control frame (which would kill the runtime).
        const snapshot = snapshotNamespace(namespace);
        const serialized = JSON.stringify(snapshot);
        const snapshotOmitted = serialized !== undefined && serialized.length > SNAPSHOT_MAX_BYTES;
        moduleGraphReported = true;
        bridgePort.postMessage({
          kind: 'module-graph-loaded',
          workerId,
          workerEpoch,
          exportNames: Object.keys(namespace),
          ...(snapshotOmitted ? { snapshotOmitted: true } : { snapshot }),
        });
        if (pendingFatalExit) process.exit(1);
      },
      (error) => {
        moduleGraphReported = true;
        bridgePort.postMessage({
          kind: 'module-graph-error',
          workerId,
          workerEpoch,
          ...errorToWire(error),
        });
        if (pendingFatalExit) process.exit(1);
      },
    );
  } catch (error) {
    moduleGraphReported = true;
    bridgePort.postMessage({
      kind: 'module-graph-error',
      workerId,
      workerEpoch,
      ...errorToWire(error),
    });
    if (pendingFatalExit) process.exit(1);
  }
}
