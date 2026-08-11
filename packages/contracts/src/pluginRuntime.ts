/**
 * Plugin Runtime wire-protocol contracts (ТЗ Plugin SDK vNext v3.2 §15–§16,
 * §40, §41).
 *
 * Single source of truth for everything that crosses the Main Host ↔ Plugin
 * Runtime boundary and the Runtime ↔ Worker boundary: the fixed-size routing
 * header (§15.2), frame types, the bounded control-payload codec (§15.11),
 * the handshake and command frames, worker telemetry (§40) and the error
 * envelopes (§15.7, §40.1.1).
 *
 * The codec deliberately depends only on Web platform primitives
 * (Uint8Array/DataView/TextEncoder), so both the host and the runtime consume
 * it without pulling in Node stream types.
 */
import { Type, type Static } from '@sinclair/typebox';
import { BrokerCallRequestSchema, BrokerWireErrorSchema } from './capabilityBroker.js';

/** Wire protocol version for this generation of the Plugin Runtime. */
export const PLUGIN_RUNTIME_PROTOCOL_VERSION = 1;

/** Fixed size of the routing header in bytes (§15.2). */
export const PLUGIN_RUNTIME_HEADER_BYTES = 32;

/** Control payload cap in bytes (§15.3: control frames must stay small). */
export const PLUGIN_RUNTIME_MAX_CONTROL_PAYLOAD_BYTES = 64 * 1024;

/** Bulk data payload cap in bytes (data pipes, §15.9). */
export const PLUGIN_RUNTIME_MAX_DATA_PAYLOAD_BYTES = 256 * 1024 * 1024;

/** Max nesting depth for decoded control payloads (§15.11). */
export const PLUGIN_RUNTIME_MAX_JSON_DEPTH = 64;

/** Max byte length of one string inside a decoded control payload (§15.11). */
export const PLUGIN_RUNTIME_MAX_STRING_BYTES = 32 * 1024;

/**
 * §17 credit streams: per-chunk byte bound for streamed response bodies.
 * Both the credit quantum and the wire chunk cap; the TZ example uses
 * `CREDIT 256 KiB / DATA <= 256 KiB`.
 */
export const RPC_STREAM_CHUNK_BYTES = 256 * 1024;

/** Initial credit window of a new response stream: one chunk. */
export const RPC_STREAM_INITIAL_CREDIT_BYTES = RPC_STREAM_CHUNK_BYTES;

/**
 * Bounded stream registry on the host producer (§17: no unbounded queues).
 * Exceeding it fails the response (a broker error), never a silent stall.
 */
export const RPC_STREAM_MAX_CONCURRENT = 16;

/**
 * Hard bound on the assembled response body per stream. The network body cap
 * is 8 MiB (`NETWORK_MAX_BODY_BYTES`); this leaves headroom for the response
 * envelope and JSON escaping of the encoded body. Enforced by both the host
 * producer (refuses to stream a larger body) and the worker consumer
 * (defense-in-depth fail of the call).
 */
export const RPC_STREAM_MAX_ACCUMULATED_BYTES = 16 * 1024 * 1024;

/**
 * §9.1.1 batched console channel: one batch of plugin log records travelling
 * host-ward as a LOG_BATCH frame. The worker is the single encode point
 * (bounded JSON payload, decoded exactly once by the host; the runtime
 * forwards it opaque — §15.1). `payloadBytes` carries the worker-encoded
 * `PluginRuntimeLogBatchPayload` JSON.
 */
export const PLUGIN_RUNTIME_LOG_BATCH_MAX_BYTES = 16 * 1024;

/** Max records per LOG_BATCH frame (§9.1.1 flush batching). */
export const PLUGIN_RUNTIME_LOG_BATCH_MAX_RECORDS = 256;

/** Max bytes of one formatted log message (§9.1.2 bounded formatting). */
export const PLUGIN_RUNTIME_LOG_MAX_MESSAGE_BYTES = 4000;

/** Max coalesce count of identical consecutive records before dropping. */
export const PLUGIN_RUNTIME_LOG_MAX_COALESCED_COUNT = 1_000_000;

/** Supported console levels (§9.1.2 first version). */
export const PLUGIN_RUNTIME_LOG_LEVELS = [
  'debug',
  'log',
  'info',
  'warn',
  'error',
  'trace',
] as const;
export type PluginRuntimeLogLevel = (typeof PLUGIN_RUNTIME_LOG_LEVELS)[number];

/**
 * §9.1.4 fatal diagnostics: max bytes of the bounded fatal envelope a dying
 * worker may emit. The envelope has its own reserved path (FATAL_DIAGNOSTIC
 * frame) and cannot be displaced by ordinary log flood.
 */
export const PLUGIN_RUNTIME_FATAL_MAX_BYTES = 8000;

/**
 * Frame types on the host ↔ runtime wire (§15.2). Values are wire bytes and
 * MUST NOT be renumbered once released; only additive changes allowed.
 */
export const PluginRuntimeFrameType = {
  /** runtime -> host: handshake identity (version, epoch, pid, capabilities). */
  HELLO: 0x01,
  /** host -> runtime: handshake accepted. */
  HELLO_ACK: 0x02,
  /** runtime -> host: a worker finished its SES bootstrap (ADR-0028). */
  WORKER_READY: 0x04,
  /** host -> runtime: activate a worker. */
  WORKER_SPAWN: 0x05,
  /** host -> runtime: terminate a worker (two-phase, §25.1). */
  WORKER_TERMINATE: 0x06,
  /** runtime -> host: worker terminated. */
  WORKER_TERMINATED: 0x07,
  /** opaque plugin RPC payload routed host ↔ runtime (§15.1). */
  RPC_REQUEST: 0x10,
  /** opaque plugin RPC reply routed host ↔ runtime (§15.1). */
  RPC_RESPONSE: 0x11,
  /** opaque plugin event routed runtime -> host. */
  EVENT: 0x12,
  /** host -> runtime: revoke a plugin capability (§10.2, Stage D part 9b). */
  BROKER_REVOKE: 0x13,
  /**
   * host -> runtime: signed module graph for a spawned worker (Stage A).
   * Sent after WORKER_READY, addressed by worker id/epoch; the runtime
   * forwards it to the worker's control port as a `load-module-graph`
   * bridge message. The graph itself is plugin payload and stays opaque
   * to the wire (§15.1) — the worker validates its shape and digests.
   */
  MODULE_GRAPH: 0x14,
  /**
   * runtime -> host: app-level worker bridge message that no runtime
   * component understands (module-graph-loaded/error today, live delivery
   * in Stage F). Payload is opaque (§15.1); the host narrows by kind.
   */
  BRIDGE_MESSAGE: 0x15,
  /**
   * host -> runtime: app-level worker bridge message routed to one worker
   * (Stage F live delivery: `event-push` subscriptions). The runtime only
   * checks the worker identity and forwards the payload to the worker's
   * control port; the worker narrows by kind.
   */
  HOST_BRIDGE_MESSAGE: 0x16,
  /**
   * host -> runtime: module graph for a spawned worker, transported on the
   * data pipe (fd 3, §15.9). Used when the signed graph does not fit the
   * control path (§15.3/§15.11 string bounds); the payload is the same
   * `{ workerId, workerEpoch, graph }` JSON body as MODULE_GRAPH, but stays
   * opaque to the wire and is decoded exactly once by the worker (§15.1).
   */
  MODULE_GRAPH_DATA: 0x17,
  /**
   * host -> runtime: broker-call result for one worker, transported on the
   * data pipe (fd 3, §15.9). Used when the response body (e.g. a large
   * network fetch body) exceeds the control path; the payload is the same
   * `PluginRuntimeRpcResponseBody` JSON as RPC_RESPONSE but stays opaque to
   * the wire and is decoded exactly once by the worker (§15.1).
   */
  RPC_RESPONSE_DATA: 0x18,
  /**
   * worker -> host (via the runtime): broker-call request with arguments
   * transported on the data pipe (fd 4, §15.9). Used when the call args
   * (e.g. a large KV/settings value) exceed the control path; the payload
   * is the same `PluginRuntimeRpcRequestBody` JSON as RPC_REQUEST but stays
   * opaque to the runtime and is decoded exactly once by the host (§15.1).
   */
  RPC_REQUEST_DATA: 0x19,
  /**
   * host -> runtime: one chunk of a broker-call response body streamed over
   * the data pipe (fd 3, §17 credit-based backpressure). Used when the
   * encoded `PluginRuntimeRpcResponseBody` JSON exceeds one chunk; each
   * frame carries at most `RPC_STREAM_CHUNK_BYTES` of the SAME opaque body
   * JSON as RPC_RESPONSE, the last chunk has `final: true`. The payload is
   * a JSON header (`{ requestId, seq, final }` — JSON text can never
   * contain a raw NUL) followed by a NUL byte and the raw chunk bytes; the
   * runtime forwards it opaque and the worker is the single assembly and
   * decode point (§15.1).
   */
  RPC_RESPONSE_STREAM: 0x1a,
  /**
   * runtime -> host: one batch of plugin console records (§9.1.1). The
   * payload is the worker-encoded `PluginRuntimeLogBatchPayload` JSON,
   * forwarded opaque by the runtime — the host is the single decode point
   * (§15.1). The runtime never decodes or re-encodes the batch; a bounded
   * payload keeps control frames small (§15.3). The host consumes the batch
   * (log router), emits the synthetic suppressed-record when
   * `droppedCount > 0`, and answers LOG_BATCH_ACK to replenish the worker's
   * log credits.
   */
  LOG_BATCH: 0x1b,
  /**
   * host -> runtime: credit ack for one consumed LOG_BATCH frame (§9.1.1).
   * The runtime validates the worker identity and forwards `{ kind:
   * 'log-batch-ack', seq }` to the worker's control port; the worker
   * replenishes its flush credit (bounded). Without acks the worker stops
   * flushing — its ring stays the only log buffer (no secondary unbounded
   * queue, §9.1.1 rule 5).
   */
  LOG_BATCH_ACK: 0x1c,
  /**
   * runtime -> host: worker fatal diagnostic (§9.1.4, §26.1.3/4). Emitted
   * by the dying worker over the bridge and forwarded immediately; the
   * envelope is small and bounded and cannot be displaced by log flood.
   * The host keeps the last envelope per worker for crash attribution.
   */
  FATAL_DIAGNOSTIC: 0x1d,
  /** runtime -> host: periodic resource telemetry (§40). */
  TELEMETRY: 0x20,
  /** host -> runtime: liveness probe. */
  PING: 0x21,
  /** runtime -> host: liveness reply carrying telemetry (§40). */
  PONG: 0x22,
  /** host -> runtime: graceful shutdown of the whole runtime. */
  TERMINATE: 0x30,
  /** runtime -> host: shutdown acknowledged. */
  TERMINATE_ACK: 0x31,
  /** runtime -> host: protocol/runtime error (wire body is a WireError). */
  ERROR: 0x40,
} as const;
export type PluginRuntimeFrameTypeValue =
  (typeof PluginRuntimeFrameType)[keyof typeof PluginRuntimeFrameType];

/** TypeBox schema for wire frame-type values. */
export const PluginRuntimeFrameTypeSchema = Type.Union(
  Object.values(PluginRuntimeFrameType).map((value) => Type.Literal(value)),
);

/** Header flag bits (§15.2). */
export const PluginRuntimeFrameFlag = {
  /** The frame is transported on the data pipe (bulk path, §15.9). */
  DATA: 1 << 0,
  /**
   * Control-class frame that must not queue behind bulk data. Used to mark
   * TERMINATE/HELLO-family frames so the receiver can short-circuit queues.
   */
  CRITICAL: 1 << 1,
} as const;

/** Fixed-size routing header (§15.2). */
export interface PluginRuntimeHotHeader {
  protocolVersion: number;
  frameType: PluginRuntimeFrameTypeValue;
  flags: number;
  runtimeEpoch: number;
  workerId: number;
  workerEpoch: number;
  requestId: number;
  payloadLength: number;
}

export const PluginRuntimeHotHeaderSchema = Type.Object(
  {
    protocolVersion: Type.Integer({ minimum: 1, maximum: 0xffff }),
    frameType: PluginRuntimeFrameTypeSchema,
    flags: Type.Integer({ minimum: 0, maximum: 0xffff }),
    runtimeEpoch: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    workerId: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    workerEpoch: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    requestId: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    payloadLength: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type PluginRuntimeHotHeaderStatic = Static<typeof PluginRuntimeHotHeaderSchema>;

/** One framed unit: routing header plus opaque payload. */
export interface PluginRuntimeFrame {
  header: PluginRuntimeHotHeader;
  payload: Uint8Array;
}

/** Wire-error codes raised by the codec itself (§41, §15.11 bounds). */
export const PluginRuntimeProtocolErrorCode = {
  VERSION_MISMATCH: 'PLUGIN_RUNTIME_VERSION_MISMATCH',
  BAD_HEADER: 'PLUGIN_RUNTIME_BAD_HEADER',
  FRAME_TOO_LARGE: 'PLUGIN_RUNTIME_FRAME_TOO_LARGE',
  BAD_PAYLOAD: 'PLUGIN_RUNTIME_BAD_PAYLOAD',
  DECODE_DEPTH: 'PLUGIN_RUNTIME_DECODE_DEPTH',
  DECODE_STRING: 'PLUGIN_RUNTIME_DECODE_STRING',
} as const;
export type PluginRuntimeProtocolErrorCodeValue =
  (typeof PluginRuntimeProtocolErrorCode)[keyof typeof PluginRuntimeProtocolErrorCode];

/** Structured codec/protocol failure. Never contains plugin data. */
export class PluginRuntimeProtocolError extends Error {
  readonly code: PluginRuntimeProtocolErrorCodeValue;
  readonly details: unknown;
  constructor(code: PluginRuntimeProtocolErrorCodeValue, details?: unknown) {
    super(code);
    this.name = 'PluginRuntimeProtocolError';
    this.code = code;
    this.details = details;
  }
}

const KNOWN_FRAME_TYPES = new Set<number>(Object.values(PluginRuntimeFrameType));

function isKnownFrameType(value: number): boolean {
  return KNOWN_FRAME_TYPES.has(value);
}

/** Serialize a routing header into the fixed 32-byte layout (§15.2). */
export function encodeHeader(header: PluginRuntimeHotHeader): Uint8Array {
  if (header.protocolVersion < 1 || header.protocolVersion > 0xffff) {
    throw new PluginRuntimeProtocolError(PluginRuntimeProtocolErrorCode.BAD_HEADER, {
      field: 'protocolVersion',
    });
  }
  if (!isKnownFrameType(header.frameType)) {
    throw new PluginRuntimeProtocolError(PluginRuntimeProtocolErrorCode.BAD_HEADER, {
      field: 'frameType',
    });
  }
  if (!Number.isSafeInteger(header.payloadLength) || header.payloadLength < 0) {
    throw new PluginRuntimeProtocolError(PluginRuntimeProtocolErrorCode.BAD_HEADER, {
      field: 'payloadLength',
    });
  }
  const bytes = new Uint8Array(PLUGIN_RUNTIME_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, header.protocolVersion);
  view.setUint8(2, header.frameType);
  view.setUint8(3, header.flags);
  view.setUint32(4, header.runtimeEpoch);
  view.setUint32(8, header.workerId);
  view.setUint32(12, header.workerEpoch);
  view.setUint32(16, header.requestId);
  view.setBigUint64(20, BigInt(header.payloadLength));
  return bytes;
}

/**
 * Parse a routing header. Version is NOT enforced here: a differing
 * `protocolVersion` is a handshake decision, not a framing failure.
 */
export function parseHeader(bytes: Uint8Array): PluginRuntimeHotHeader {
  if (bytes.byteLength < PLUGIN_RUNTIME_HEADER_BYTES) {
    throw new PluginRuntimeProtocolError(PluginRuntimeProtocolErrorCode.BAD_HEADER, {
      got: bytes.byteLength,
      want: PLUGIN_RUNTIME_HEADER_BYTES,
    });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, PLUGIN_RUNTIME_HEADER_BYTES);
  const frameType = view.getUint8(2);
  if (!isKnownFrameType(frameType)) {
    throw new PluginRuntimeProtocolError(PluginRuntimeProtocolErrorCode.BAD_HEADER, {
      frameType,
    });
  }
  const payloadLength = view.getBigUint64(20);
  if (payloadLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PluginRuntimeProtocolError(PluginRuntimeProtocolErrorCode.FRAME_TOO_LARGE, {
      payloadLength: payloadLength.toString(),
    });
  }
  return {
    protocolVersion: view.getUint16(0),
    frameType: frameType as PluginRuntimeFrameTypeValue,
    flags: view.getUint8(3),
    runtimeEpoch: view.getUint32(4),
    workerId: view.getUint32(8),
    workerEpoch: view.getUint32(12),
    requestId: view.getUint32(16),
    payloadLength: Number(payloadLength),
  };
}

/**
 * Encode a control-frame payload (bounded JSON, §15.11). The body is decoded
 * exactly once at the consuming endpoint (§15.1 single-serialization rule).
 */
export function encodeControlBody(body: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  if (bytes.byteLength > PLUGIN_RUNTIME_MAX_CONTROL_PAYLOAD_BYTES) {
    throw new PluginRuntimeProtocolError(PluginRuntimeProtocolErrorCode.FRAME_TOO_LARGE, {
      bytes: bytes.byteLength,
      max: PLUGIN_RUNTIME_MAX_CONTROL_PAYLOAD_BYTES,
    });
  }
  return bytes;
}

/** Decode a control-frame payload with §15.11 bounds (size, depth, strings). */
export function decodeControlBody(bytes: Uint8Array): unknown {
  if (bytes.byteLength > PLUGIN_RUNTIME_MAX_CONTROL_PAYLOAD_BYTES) {
    throw new PluginRuntimeProtocolError(PluginRuntimeProtocolErrorCode.FRAME_TOO_LARGE, {
      bytes: bytes.byteLength,
      max: PLUGIN_RUNTIME_MAX_CONTROL_PAYLOAD_BYTES,
    });
  }
  const text = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new PluginRuntimeProtocolError(PluginRuntimeProtocolErrorCode.BAD_PAYLOAD, { cause });
  }
  assertBoundedJson(parsed);
  return parsed;
}

/**
 * Encode a data-pipe payload (bulk path, §15.9): plain JSON without the
 * control-payload string/depth bounds — the endpoint (worker) validates
 * shape and size, and the frame never passes through the control decoder
 * (§15.1 single-serialization rule). Bounded only by the data-payload cap.
 */
export function encodeDataBody(body: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  if (bytes.byteLength > PLUGIN_RUNTIME_MAX_DATA_PAYLOAD_BYTES) {
    throw new PluginRuntimeProtocolError(PluginRuntimeProtocolErrorCode.FRAME_TOO_LARGE, {
      bytes: bytes.byteLength,
      max: PLUGIN_RUNTIME_MAX_DATA_PAYLOAD_BYTES,
    });
  }
  return bytes;
}

/**
 * Iterative, stack-based bounds check over a decoded tree (§15.11): no
 * recursion limit surprises, bounded CPU, bounded nesting and string sizes.
 */
function assertBoundedJson(root: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const encoder = new TextEncoder();
  while (stack.length > 0) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number };
    if (depth > PLUGIN_RUNTIME_MAX_JSON_DEPTH) {
      throw new PluginRuntimeProtocolError(PluginRuntimeProtocolErrorCode.DECODE_DEPTH, {
        depth,
        max: PLUGIN_RUNTIME_MAX_JSON_DEPTH,
      });
    }
    if (typeof value === 'string') {
      if (encoder.encode(value).byteLength > PLUGIN_RUNTIME_MAX_STRING_BYTES) {
        throw new PluginRuntimeProtocolError(PluginRuntimeProtocolErrorCode.DECODE_STRING, {
          max: PLUGIN_RUNTIME_MAX_STRING_BYTES,
        });
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        stack.push({ value: value[i], depth: depth + 1 });
      }
    } else if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        if (encoder.encode(key).byteLength > PLUGIN_RUNTIME_MAX_STRING_BYTES) {
          throw new PluginRuntimeProtocolError(PluginRuntimeProtocolErrorCode.DECODE_STRING, {
            max: PLUGIN_RUNTIME_MAX_STRING_BYTES,
          });
        }
        stack.push({
          value: (value as Record<string, unknown>)[key],
          depth: depth + 1,
        });
      }
    }
  }
}

/** Assemble header + payload into one contiguous wire frame. */
function assembleFrame(
  header: Omit<PluginRuntimeHotHeader, 'payloadLength'>,
  payload: Uint8Array,
): Uint8Array {
  const full = encodeHeader({ ...header, payloadLength: payload.byteLength });
  const frame = new Uint8Array(PLUGIN_RUNTIME_HEADER_BYTES + payload.byteLength);
  frame.set(full, 0);
  frame.set(payload, PLUGIN_RUNTIME_HEADER_BYTES);
  return frame;
}

/** Split a complete wire frame into header + payload. */
function splitFrame(bytes: Uint8Array): PluginRuntimeFrame {
  if (bytes.byteLength < PLUGIN_RUNTIME_HEADER_BYTES) {
    throw new PluginRuntimeProtocolError(PluginRuntimeProtocolErrorCode.BAD_HEADER, {
      got: bytes.byteLength,
      want: PLUGIN_RUNTIME_HEADER_BYTES,
    });
  }
  const header = parseHeader(bytes.subarray(0, PLUGIN_RUNTIME_HEADER_BYTES));
  if (bytes.byteLength !== PLUGIN_RUNTIME_HEADER_BYTES + header.payloadLength) {
    throw new PluginRuntimeProtocolError(PluginRuntimeProtocolErrorCode.BAD_HEADER, {
      got: bytes.byteLength,
      want: PLUGIN_RUNTIME_HEADER_BYTES + header.payloadLength,
    });
  }
  return { header, payload: bytes.slice(PLUGIN_RUNTIME_HEADER_BYTES) };
}

/** Encode a control frame: fixed header + bounded JSON body. */
export function encodeControlFrame(
  header: Omit<PluginRuntimeHotHeader, 'payloadLength'>,
  body: unknown,
): Uint8Array {
  return assembleFrame(header, encodeControlBody(body));
}

/** Decode a complete control frame (header + bounded JSON body). */
export function decodeControlFrame(bytes: Uint8Array): PluginRuntimeFrame & { body: unknown } {
  const { header, payload } = splitFrame(bytes);
  return { header, payload, body: decodeControlBody(payload) };
}

/** Encode a data frame: fixed header + opaque payload (no decode in Runtime). */
export function encodeDataFrame(
  header: Omit<PluginRuntimeHotHeader, 'payloadLength'>,
  payload: Uint8Array,
): Uint8Array {
  return assembleFrame(header, payload);
}

/** Split a complete data frame (payload stays opaque). */
export function decodeDataFrame(bytes: Uint8Array): PluginRuntimeFrame {
  return splitFrame(bytes);
}

/**
 * Incremental frame parser for a framed byte stream (host control pipe,
 * runtime stdin, data pipes). Feeds stream chunks and returns complete
 * frames. Bounds: a frame's payload may not exceed `maxPayloadBytes` and the
 * parser never buffers beyond header + one payload.
 */
export class PluginRuntimeFrameParser {
  private buffer = new Uint8Array(0);
  readonly maxPayloadBytes: number;

  constructor(options?: { maxPayloadBytes?: number }) {
    this.maxPayloadBytes = options?.maxPayloadBytes ?? PLUGIN_RUNTIME_MAX_CONTROL_PAYLOAD_BYTES;
  }

  push(chunk: Uint8Array): PluginRuntimeFrame[] {
    if (chunk.byteLength === 0) return [];
    const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.byteLength);
    this.buffer = merged;

    const frames: PluginRuntimeFrame[] = [];
    for (;;) {
      if (this.buffer.byteLength < PLUGIN_RUNTIME_HEADER_BYTES) break;
      const header = parseHeader(this.buffer.subarray(0, PLUGIN_RUNTIME_HEADER_BYTES));
      if (header.payloadLength > this.maxPayloadBytes) {
        throw new PluginRuntimeProtocolError(PluginRuntimeProtocolErrorCode.FRAME_TOO_LARGE, {
          payloadLength: header.payloadLength,
          max: this.maxPayloadBytes,
        });
      }
      const total = PLUGIN_RUNTIME_HEADER_BYTES + header.payloadLength;
      if (this.buffer.byteLength < total) break;
      const frame: PluginRuntimeFrame = {
        header,
        // Owned copy: the buffer is reused and we must never hand out a view
        // into it (the transfer path later needs owned ArrayBuffers, §15.6).
        payload: this.buffer.slice(PLUGIN_RUNTIME_HEADER_BYTES, total),
      };
      this.buffer = this.buffer.slice(total);
      frames.push(frame);
    }

    if (this.buffer.byteLength > PLUGIN_RUNTIME_HEADER_BYTES + this.maxPayloadBytes) {
      throw new PluginRuntimeProtocolError(PluginRuntimeProtocolErrorCode.FRAME_TOO_LARGE, {
        buffered: this.buffer.byteLength,
      });
    }
    return frames;
  }
}

/**
 * Worker bootstrap identifiers passed through `workerData` (§15.8, ADR-0028).
 * Only small immutable values; module source, manifests and package archives
 * travel after HARDENED_READY over the bounded transport instead.
 */
export const PluginRuntimeWorkerBootstrapDataSchema = Type.Object(
  {
    protocolVersion: Type.Integer({ minimum: 1 }),
    workerId: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    workerEpoch: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    pluginId: Type.String({ minLength: 1, maxLength: 160 }),
    installationId: Type.String({ minLength: 1, maxLength: 160 }),
    moduleGraphDigest: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export type PluginRuntimeWorkerBootstrapData = Static<
  typeof PluginRuntimeWorkerBootstrapDataSchema
>;

/** Handshake frame bodies (§15.2, version gating). */
export const PluginRuntimeHelloSchema = Type.Object(
  {
    protocolVersion: Type.Integer({ minimum: 1 }),
    runtimeEpoch: Type.Integer({ minimum: 0 }),
    pid: Type.Integer({ minimum: 0 }),
    capabilities: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
      maxItems: 64,
    }),
  },
  { additionalProperties: false },
);
export type PluginRuntimeHello = Static<typeof PluginRuntimeHelloSchema>;

export const PluginRuntimeHelloAckSchema = Type.Object(
  {
    protocolVersion: Type.Integer({ minimum: 1 }),
    runtimeEpoch: Type.Integer({ minimum: 0 }),
    accepted: Type.Boolean(),
    reason: Type.Optional(Type.String({ maxLength: 256 })),
  },
  { additionalProperties: false },
);
export type PluginRuntimeHelloAck = Static<typeof PluginRuntimeHelloAckSchema>;

/** Host -> runtime: activate a worker. */
export const PluginRuntimeWorkerSpawnSchema = Type.Object(
  {
    workerId: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    pluginId: Type.String({ minLength: 1, maxLength: 160 }),
    installationId: Type.String({ minLength: 1, maxLength: 160 }),
    moduleGraphDigest: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    /**
     * §22/§38: plugin memory hint (MiB, manifest `resources.memoryHintMiB`).
     * The runtime raises the emergency heap ceiling toward the hint when
     * headroom permits. Advisory — not a quota.
     */
    memoryHintMiB: Type.Optional(Type.Integer({ minimum: 0, maximum: 0xffff })),
    /**
     * §39 admin override (`plugins.overrides.<id>.maxHeapMiB`). Wins over
     * the headroom calculation. 0/absent = no override.
     */
    maxHeapOverrideMiB: Type.Optional(Type.Integer({ minimum: 0, maximum: 0xffff })),
  },
  { additionalProperties: false },
);
export type PluginRuntimeWorkerSpawn = Static<typeof PluginRuntimeWorkerSpawnSchema>;

/** Host -> runtime: terminate one worker (two-phase, §25.1). */
export const PluginRuntimeWorkerTerminateSchema = Type.Object(
  {
    workerId: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    reason: Type.Optional(Type.String({ maxLength: 256 })),
  },
  { additionalProperties: false },
);
export type PluginRuntimeWorkerTerminate = Static<typeof PluginRuntimeWorkerTerminateSchema>;

/** Result of the no-Node-authority probe run inside the plugin Compartment. */
export const PluginRuntimeAuthorityProbeSchema = Type.Object(
  {
    process: Type.Boolean(),
    require: Type.Boolean(),
    buffer: Type.Boolean(),
    fetch: Type.Boolean(),
    setInterval: Type.Boolean(),
    webAssembly: Type.Boolean(),
    worker: Type.Boolean(),
    sharedArrayBuffer: Type.Boolean(),
    hasCompartment: Type.Boolean(),
    marker: Type.Integer(),
  },
  { additionalProperties: false },
);
export type PluginRuntimeAuthorityProbe = Static<typeof PluginRuntimeAuthorityProbeSchema>;

/** runtime -> host: a worker finished its SES bootstrap (ADR-0028). */
export const PluginRuntimeWorkerReadySchema = Type.Object(
  {
    workerId: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    workerEpoch: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    pluginId: Type.String({ minLength: 1, maxLength: 160 }),
    installationId: Type.String({ minLength: 1, maxLength: 160 }),
    lockdownMs: Type.Number({ minimum: 0 }),
    compartmentMs: Type.Number({ minimum: 0 }),
    bootstrapMs: Type.Number({ minimum: 0 }),
    noNodeAuthority: Type.Boolean(),
    probe: PluginRuntimeAuthorityProbeSchema,
    /**
     * §22/§40: the emergency heap ceiling this worker was spawned with,
     * reported by the trusted bootstrap from `worker_threads.resourceLimits`.
     * Optional so older runtimes keep validating (additive wire rule).
     */
    emergencyLimits: Type.Optional(
      Type.Object(
        {
          maxOldGenerationSizeMb: Type.Integer({ minimum: 0, maximum: 0xffff }),
          maxYoungGenerationSizeMb: Type.Integer({ minimum: 0, maximum: 0xffff }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type PluginRuntimeWorkerReady = Static<typeof PluginRuntimeWorkerReadySchema>;

/**
 * Bounded fatal diagnostic envelope (§9.1.4, §40.1.1): what a dying worker
 * can still say about an uncaught exception or unhandled rejection. Small by
 * construction (PLUGIN_RUNTIME_FATAL_MAX_BYTES) and carried on the reserved
 * FATAL_DIAGNOSTIC path — never displaced by ordinary log flood.
 */
export const PluginRuntimeFatalEnvelopeSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal('uncaught-exception'), Type.Literal('unhandled-rejection')]),
    name: Type.String({ maxLength: 256 }),
    message: Type.String({ maxLength: 2000 }),
    /** Bounded stack lines; may be absent when SES taming censored it. */
    stack: Type.Optional(Type.String({ maxLength: PLUGIN_RUNTIME_FATAL_MAX_BYTES })),
  },
  { additionalProperties: false },
);
export type PluginRuntimeFatalEnvelope = Static<typeof PluginRuntimeFatalEnvelopeSchema>;

/** runtime -> host: worker terminated. */
export const PluginRuntimeWorkerTerminatedSchema = Type.Object(
  {
    workerId: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    workerEpoch: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    code: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    signal: Type.Union([Type.Null(), Type.String({ maxLength: 32 })]),
    /**
     * §9.1.4: the worker's last bounded fatal envelope, attached when the
     * FATAL_DIAGNOSTIC frame may have raced the exit (crash attribution).
     */
    fatal: Type.Optional(PluginRuntimeFatalEnvelopeSchema),
  },
  { additionalProperties: false },
);
export type PluginRuntimeWorkerTerminated = Static<typeof PluginRuntimeWorkerTerminatedSchema>;

/** One formatted plugin console record (§9.1.1/§9.1.2, §15.7). */
export const PluginRuntimeLogRecordSchema = Type.Object(
  {
    level: Type.Union(
      PLUGIN_RUNTIME_LOG_LEVELS.map((value) => Type.Literal(value)),
      { description: 'console level (debug/log/info/warn/error/trace)' },
    ),
    message: Type.String({ maxLength: PLUGIN_RUNTIME_LOG_MAX_MESSAGE_BYTES }),
    at: Type.Integer({ minimum: 0, maximum: 0x7fffffffffff }),
    /**
     * Coalesced identical consecutive records (§9.1.1 rule 3): the host
     * renders the record once and may expand `count` for the user. Omitted
     * when 1.
     */
    count: Type.Optional(
      Type.Integer({ minimum: 2, maximum: PLUGIN_RUNTIME_LOG_MAX_COALESCED_COUNT }),
    ),
  },
  { additionalProperties: false },
);
export type PluginRuntimeLogRecord = Static<typeof PluginRuntimeLogRecordSchema>;

/**
 * Worker-encoded LOG_BATCH payload (decoded exactly once by the host;
 * §15.1). `droppedCount` counts records dropped/coalesced-past-budget since
 * the previous batch — the host MUST emit the synthetic suppressed-record
 * `[NT] N plugin log records suppressed` when it is non-zero (§9.1.1 rule 9).
 */
export const PluginRuntimeLogBatchPayloadSchema = Type.Object(
  {
    seq: Type.Integer({ minimum: 0, maximum: 0x7fffffff }),
    droppedCount: Type.Integer({ minimum: 0, maximum: 0x7fffffff }),
    records: Type.Array(PluginRuntimeLogRecordSchema, {
      maxItems: PLUGIN_RUNTIME_LOG_BATCH_MAX_RECORDS,
    }),
  },
  { additionalProperties: false },
);
export type PluginRuntimeLogBatchPayload = Static<typeof PluginRuntimeLogBatchPayloadSchema>;

/**
 * Worker bridge message `log-batch` shape (§9.1.1). `payloadBytes` is the
 * worker-encoded `PluginRuntimeLogBatchPayload` JSON — the runtime forwards
 * it opaque to the LOG_BATCH frame (§15.1); the host decodes once.
 */
export const PluginRuntimeLogBatchBodySchema = Type.Object(
  {
    kind: Type.Literal('log-batch'),
    workerId: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    workerEpoch: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    seq: Type.Integer({ minimum: 0, maximum: 0x7fffffff }),
    droppedCount: Type.Integer({ minimum: 0, maximum: 0x7fffffff }),
    payloadBytes: Type.Uint8Array({ maxByteLength: PLUGIN_RUNTIME_LOG_BATCH_MAX_BYTES }),
  },
  { additionalProperties: false },
);
export type PluginRuntimeLogBatchBody = Static<typeof PluginRuntimeLogBatchBodySchema>;

/** LOG_BATCH_ACK control payload (host -> runtime -> worker, §9.1.1). */
export const PluginRuntimeLogBatchAckBodySchema = Type.Object(
  {
    workerId: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    workerEpoch: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    seq: Type.Integer({ minimum: 0, maximum: 0x7fffffff }),
  },
  { additionalProperties: false },
);
export type PluginRuntimeLogBatchAckBody = Static<typeof PluginRuntimeLogBatchAckBodySchema>;

/**
 * FATAL_DIAGNOSTIC control payload (runtime -> host, §9.1.4). `envelope` is
 * the bounded fatal record of the dying worker; the frame is emitted as soon
 * as the bridge message arrives and never waits for log credits.
 */
export const PluginRuntimeFatalDiagnosticBodySchema = Type.Object(
  {
    workerId: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    workerEpoch: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    envelope: PluginRuntimeFatalEnvelopeSchema,
  },
  { additionalProperties: false },
);
export type PluginRuntimeFatalDiagnosticBody = Static<
  typeof PluginRuntimeFatalDiagnosticBodySchema
>;

/** Resource telemetry (§40). One per Worker plus a process-level aggregate. */
export const PluginRuntimeTelemetrySchema = Type.Object(
  {
    at: Type.Integer({ minimum: 0 }),
    runtimeEpoch: Type.Integer({ minimum: 0 }),
    pid: Type.Integer({ minimum: 0 }),
    uptimeMs: Type.Integer({ minimum: 0 }),
    rssMiB: Type.Number({ minimum: 0 }),
    heapUsedMiB: Type.Number({ minimum: 0 }),
    heapTotalMiB: Type.Number({ minimum: 0 }),
    externalMiB: Type.Number({ minimum: 0 }),
    arrayBuffersMiB: Type.Number({ minimum: 0 }),
    cpuMs: Type.Number({ minimum: 0 }),
    eventLoopUtilization: Type.Number({ minimum: 0, maximum: 1 }),
    workerCount: Type.Integer({ minimum: 0 }),
    workerRestarts: Type.Integer({ minimum: 0 }),
    runtimeRestarts: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type PluginRuntimeTelemetry = Static<typeof PluginRuntimeTelemetrySchema>;

/** Wire error shape (§15.7) for RPC failures crossing the worker boundary. */
export const PluginRuntimeWireErrorSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 64 }),
    message: Type.String({ maxLength: 2000 }),
    details: Type.Optional(Type.Unknown()),
    retryable: Type.Boolean(),
    stackToken: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export type PluginRuntimeWireError = Static<typeof PluginRuntimeWireErrorSchema>;

/** Deep error envelope captured inside the worker realm (§40.1.1). */
export const PluginRuntimeErrorEnvelopeSchema = Type.Recursive((Self) =>
  Type.Object(
    {
      errorId: Type.String({ minLength: 1, maxLength: 128 }),
      name: Type.String({ minLength: 1, maxLength: 256 }),
      message: Type.String({ maxLength: 2000 }),
      frames: Type.Array(
        Type.Object(
          {
            moduleUrl: Type.String({ minLength: 1, maxLength: 1024 }),
            line: Type.Integer({ minimum: 0, maximum: 0x7fffffff }),
            column: Type.Integer({ minimum: 0, maximum: 0x7fffffff }),
            functionName: Type.Optional(Type.String({ maxLength: 256 })),
          },
          { additionalProperties: false },
        ),
        { maxItems: 256 },
      ),
      cause: Type.Optional(Self),
      annotations: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 64 })),
      truncated: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
);
export type PluginRuntimeErrorEnvelope = Static<typeof PluginRuntimeErrorEnvelopeSchema>;

/**
 * Worker bridge messages (Runtime ↔ Worker, §16). Transferred via
 * MessagePort with protocol values only (§15.7): no arbitrary class instances.
 */
export const PluginRuntimeBridgeMessageSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('hardened-ready'),
      workerId: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
      workerEpoch: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
      lockdownMs: Type.Number({ minimum: 0 }),
      compartmentMs: Type.Number({ minimum: 0 }),
      bootstrapMs: Type.Number({ minimum: 0 }),
      noNodeAuthority: Type.Boolean(),
      probe: PluginRuntimeAuthorityProbeSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('log'),
      workerId: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
      workerEpoch: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
      level: Type.Union([
        Type.Literal('log'),
        Type.Literal('info'),
        Type.Literal('warn'),
        Type.Literal('error'),
        Type.Literal('debug'),
      ]),
      message: Type.String({ maxLength: 4000 }),
      at: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
  // §9.1.1 BoundedConsoleSink: batched plugin console records. The worker
  // encodes the batch exactly once; the runtime forwards `payloadBytes`
  // opaque to the LOG_BATCH frame (§15.1) and the host decodes once.
  PluginRuntimeLogBatchBodySchema,
  // §9.1.4 fatal diagnostics: the dying worker's bounded envelope on the
  // reserved path. Never credit-gated, never displaced by log flood.
  Type.Object(
    {
      kind: Type.Literal('fatal-diagnostic'),
      workerId: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
      workerEpoch: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
      envelope: PluginRuntimeFatalEnvelopeSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('terminate'),
      reason: Type.Optional(Type.String({ maxLength: 256 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('terminate-ack'),
      workerId: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
      workerEpoch: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    },
    { additionalProperties: false },
  ),
  // Stage C: capability broker calls (ТЗ §10, §26.2.1). The worker posts a
  // full BrokerCallRequest envelope; the runtime admits it and forwards it
  // host-ward over RPC_REQUEST frames. `rpc-response` mirrors the result.
  Type.Object(
    {
      kind: Type.Literal('rpc-request'),
      call: BrokerCallRequestSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('rpc-response'),
      requestId: Type.String({ minLength: 1, maxLength: 64 }),
      ok: Type.Boolean(),
      result: Type.Optional(Type.Unknown()),
      error: Type.Optional(BrokerWireErrorSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('event'),
      name: Type.String({ minLength: 1, maxLength: 256 }),
      payload: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: false },
  ),
]);
export type PluginRuntimeBridgeMessage = Static<typeof PluginRuntimeBridgeMessageSchema>;

/**
 * RPC_REQUEST control payload (worker → host via the runtime, §15.2). The
 * runtime stamps the worker identity so the host can attribute the call; the
 * `call` field is the full broker envelope (identity, capability, deadline,
 * causal chain).
 */
export const PluginRuntimeRpcRequestBodySchema = Type.Object(
  {
    workerId: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    workerEpoch: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    call: BrokerCallRequestSchema,
  },
  { additionalProperties: false },
);
export type PluginRuntimeRpcRequestBody = Static<typeof PluginRuntimeRpcRequestBodySchema>;

/**
 * Payload of an RPC_REQUEST_DATA frame (worker → host via the runtime, fd 4,
 * §15.9). The runtime forwards the opaque `payloadBytes` verbatim — it never
 * decodes them (§15.1); the host decodes the mirrored
 * `PluginRuntimeRpcRequestBody` JSON exactly once. Identity lives both in the
 * hot header (routing, epoch races) and inside the payload so the decoded
 * shape equals the control-path body the broker host already consumes.
 */
export interface PluginRuntimeRpcRequestDataBody {
  workerId: number;
  workerEpoch: number;
  payloadBytes: Uint8Array;
}

/**
 * RPC_RESPONSE control payload (host → worker via the runtime, §15.2).
 * Mirrors the worker bridge `rpc-response` so the runtime can route by
 * `requestId`; the echoed worker identity lets it drop responses that race a
 * worker restart.
 */
export const PluginRuntimeRpcResponseBodySchema = Type.Object(
  {
    workerId: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    workerEpoch: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    requestId: Type.String({ minLength: 8, maxLength: 64 }),
    ok: Type.Boolean(),
    result: Type.Optional(Type.Unknown()),
    error: Type.Optional(BrokerWireErrorSchema),
  },
  { additionalProperties: false },
);
export type PluginRuntimeRpcResponseBody = Static<typeof PluginRuntimeRpcResponseBodySchema>;

/**
 * §17 credit streams: routing header of one RPC_RESPONSE_STREAM chunk. Rides
 * in the frame payload as `JSON.stringify(this) + '\x00' + chunkBytes`; the
 * raw NUL is an unambiguous separator because JSON text can never contain a
 * raw NUL byte (control characters must be escaped as `\u0000`). `seq` is
 * zero-based and must be contiguous; the last chunk sets `final: true`.
 */
export interface PluginRuntimeRpcResponseStreamHeader {
  requestId: string;
  seq: number;
  final: boolean;
}

/**
 * §17 credit streams: consumer credit grant (worker -> host via the runtime).
 * The worker grants `bytes` of new credit after consuming a chunk; the host
 * producer never creates the next chunk without a free window. Travels as an
 * app-level BRIDGE_MESSAGE with `kind: 'rpc-stream-credit'`; the runtime
 * relays it opaque and the host client consumes it without re-emitting it as
 * an app-level bridge message.
 */
export const PluginRuntimeStreamCreditBodySchema = Type.Object(
  {
    workerId: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    workerEpoch: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    requestId: Type.String({ minLength: 8, maxLength: 64 }),
    bytes: Type.Integer({ minimum: 1, maximum: RPC_STREAM_CHUNK_BYTES }),
  },
  { additionalProperties: false },
);
export type PluginRuntimeStreamCreditBody = Static<typeof PluginRuntimeStreamCreditBodySchema>;

/**
 * BROKER_REVOKE control payload (host → runtime, §10.2). The host owns the
 * decision (ADR-0027); this command tells the runtime to reject new calls
 * for the plugin/capability and abort matching in-flight ones so worker-side
 * pending promises fail fast with CAPABILITY_REVOKED.
 */
export const PluginRuntimeBrokerRevokeBodySchema = Type.Object(
  {
    pluginId: Type.String({ minLength: 1, maxLength: 160 }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    reason: Type.Optional(Type.String({ maxLength: 256 })),
  },
  { additionalProperties: false },
);
export type PluginRuntimeBrokerRevokeBody = Static<typeof PluginRuntimeBrokerRevokeBodySchema>;

/**
 * MODULE_GRAPH payload (host → runtime, Stage A). `graph` is the signed
 * `PluginModuleGraph` as opaque plugin payload: the worker re-validates its
 * structure and per-module digests before evaluating anything, so the wire
 * only needs identity routing. `workerEpoch` must match the record's current
 * epoch; the host learns it from the WORKER_READY frame.
 */
export const PluginRuntimeModuleGraphBodySchema = Type.Object(
  {
    workerId: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    workerEpoch: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    graph: Type.Unknown(),
  },
  { additionalProperties: false },
);
export type PluginRuntimeModuleGraphBody = Static<typeof PluginRuntimeModuleGraphBodySchema>;

/**
 * BRIDGE_MESSAGE / HOST_BRIDGE_MESSAGE payload (both directions, Stage A/F).
 * Carries an app-level worker bridge message that no runtime component
 * decodes (§15.1): the receiving side narrows by `message.kind`
 * (module-graph-loaded/error host-ward; event-push worker-ward). Identity
 * fields in the frame header mirror the body.
 */
export const PluginRuntimeBridgeMessageBodySchema = Type.Object(
  {
    workerId: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    workerEpoch: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    message: Type.Unknown(),
  },
  { additionalProperties: false },
);
export type PluginRuntimeBridgeMessageBody = Static<typeof PluginRuntimeBridgeMessageBodySchema>;
