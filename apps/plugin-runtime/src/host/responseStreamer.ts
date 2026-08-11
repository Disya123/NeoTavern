/**
 * §17 credit streams: host-side chunking state machine for large broker-call
 * response bodies (Stage F part 14).
 *
 * The consumer (the worker) grants credit host-ward as it consumes chunks;
 * this producer never creates the next chunk without a free window. The
 * window starts at one chunk (`RPC_STREAM_INITIAL_CREDIT_BYTES`) and is
 * replenished by `grant()`; each grant produces at most one chunk, so at any
 * moment at most one chunk is in flight per stream and the stream registry is
 * bounded (`RPC_STREAM_MAX_CONCURRENT`). No unbounded arrays/queues (§17).
 *
 * Each produced frame carries `header JSON + NUL + raw chunk` (see
 * `PluginRuntimeRpcResponseStreamHeader`); the payload stays opaque to the
 * runtime and is assembled + decoded exactly once by the worker (§15.1).
 */
import {
  RPC_STREAM_CHUNK_BYTES,
  RPC_STREAM_INITIAL_CREDIT_BYTES,
  RPC_STREAM_MAX_ACCUMULATED_BYTES,
  RPC_STREAM_MAX_CONCURRENT,
  type PluginRuntimeRpcResponseStreamHeader,
} from '@neotavern/contracts';

export const RESPONSE_STREAM_ERROR_TOO_LARGE = 'RESPONSE_STREAM_TOO_LARGE';
export const RESPONSE_STREAM_ERROR_LIMIT = 'RESPONSE_STREAM_LIMIT';
export const RESPONSE_STREAM_ERROR_DUPLICATE = 'RESPONSE_STREAM_DUPLICATE';
export const RESPONSE_STREAM_ERROR_EMPTY = 'RESPONSE_STREAM_EMPTY';

/** One chunk ready for the wire: routing identity + encoded payload. */
export interface RpcResponseStreamFrame {
  workerId: number;
  workerEpoch: number;
  requestId: string;
  header: PluginRuntimeRpcResponseStreamHeader;
  chunk: Uint8Array;
  /** Header JSON + NUL + chunk bytes (§17 payload layout). */
  payload: Uint8Array;
}

export type RpcResponseStreamBeginResult =
  | { kind: 'frame'; frame: RpcResponseStreamFrame }
  | { kind: 'error'; code: string; message: string };

interface ResponseStreamState {
  workerId: number;
  workerEpoch: number;
  body: Uint8Array;
  offset: number;
  credit: number;
  seq: number;
}

export interface ResponseStreamerOptions {
  chunkBytes?: number;
  initialCreditBytes?: number;
  maxConcurrent?: number;
  maxAccumulatedBytes?: number;
}

export class ResponseStreamer {
  private readonly chunkBytes: number;
  private readonly initialCreditBytes: number;
  private readonly maxConcurrent: number;
  private readonly maxAccumulatedBytes: number;
  private readonly streams = new Map<string, ResponseStreamState>();

  constructor(options?: ResponseStreamerOptions) {
    this.chunkBytes = options?.chunkBytes ?? RPC_STREAM_CHUNK_BYTES;
    this.initialCreditBytes =
      options?.initialCreditBytes ?? options?.chunkBytes ?? RPC_STREAM_INITIAL_CREDIT_BYTES;
    this.maxConcurrent = options?.maxConcurrent ?? RPC_STREAM_MAX_CONCURRENT;
    this.maxAccumulatedBytes = options?.maxAccumulatedBytes ?? RPC_STREAM_MAX_ACCUMULATED_BYTES;
  }

  /**
   * Start streaming `bodyBytes` (the already encoded response body JSON).
   * Produces the first frame immediately (within the initial credit window).
   * Fails with a stable code instead of streaming when the body exceeds the
   * accumulated cap, the registry is full, or the requestId is a duplicate.
   */
  begin(
    workerId: number,
    workerEpoch: number,
    requestId: string,
    bodyBytes: Uint8Array,
  ): RpcResponseStreamBeginResult {
    if (bodyBytes.byteLength > this.maxAccumulatedBytes) {
      return {
        kind: 'error',
        code: RESPONSE_STREAM_ERROR_TOO_LARGE,
        message: 'response body exceeds the streaming cap',
      };
    }
    if (this.streams.has(requestId)) {
      return {
        kind: 'error',
        code: RESPONSE_STREAM_ERROR_DUPLICATE,
        message: 'a response stream for this requestId is already in flight',
      };
    }
    if (this.streams.size >= this.maxConcurrent) {
      return {
        kind: 'error',
        code: RESPONSE_STREAM_ERROR_LIMIT,
        message: 'too many concurrent response streams',
      };
    }
    this.streams.set(requestId, {
      workerId,
      workerEpoch,
      body: bodyBytes,
      offset: 0,
      credit: this.initialCreditBytes,
      seq: 0,
    });
    const frame = this.pumpOne(requestId);
    if (frame === null) {
      // Empty body (defensive; the client never streams one): no frame.
      this.streams.delete(requestId);
      return { kind: 'error', code: RESPONSE_STREAM_ERROR_EMPTY, message: 'empty response body' };
    }
    return { kind: 'frame', frame };
  }

  /**
   * Replenish credit for an in-flight stream. Validates identity and the
   * byte count against the per-chunk bound. Returns the next chunk to send,
   * or null when the stream is unknown/finished or the window is still
   * smaller than one chunk (malformed grants are ignored, never fatal).
   */
  grant(
    workerId: number,
    workerEpoch: number,
    requestId: string,
    bytes: number,
  ): RpcResponseStreamFrame | null {
    if (!Number.isInteger(bytes) || bytes < 1 || bytes > this.chunkBytes) return null;
    const state = this.streams.get(requestId);
    if (state === undefined || state.workerId !== workerId || state.workerEpoch !== workerEpoch) {
      return null;
    }
    state.credit += bytes;
    return this.pumpOne(requestId);
  }

  /** True while a stream for `requestId` is still in flight. */
  isActive(requestId: string): boolean {
    return this.streams.has(requestId);
  }

  /** Number of in-flight streams (bounded by `RPC_STREAM_MAX_CONCURRENT`). */
  get activeCount(): number {
    return this.streams.size;
  }

  private pumpOne(requestId: string): RpcResponseStreamFrame | null {
    const state = this.streams.get(requestId);
    if (state === undefined) return null;
    if (state.offset >= state.body.byteLength) {
      this.streams.delete(requestId);
      return null;
    }
    if (state.credit < this.chunkBytes) return null; // no free window yet
    const end = Math.min(state.offset + this.chunkBytes, state.body.byteLength);
    const chunk = state.body.subarray(state.offset, end);
    const final = end === state.body.byteLength;
    const header: PluginRuntimeRpcResponseStreamHeader = {
      requestId,
      seq: state.seq,
      final,
    };
    const payload = encodeResponseStreamPayload(header, chunk);
    state.offset = end;
    state.credit -= chunk.byteLength;
    state.seq += 1;
    if (final) this.streams.delete(requestId);
    return {
      workerId: state.workerId,
      workerEpoch: state.workerEpoch,
      requestId,
      header,
      chunk,
      payload,
    };
  }
}

/**
 * §17 payload layout: `JSON.stringify(header) + '\x00' + chunkBytes`. The raw
 * NUL is a safe separator because JSON text can never contain a raw NUL byte.
 */
function encodeResponseStreamPayload(
  header: PluginRuntimeRpcResponseStreamHeader,
  chunk: Uint8Array,
): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const payload = new Uint8Array(headerBytes.byteLength + 1 + chunk.byteLength);
  payload.set(headerBytes, 0);
  payload.set(chunk, headerBytes.byteLength + 1);
  return payload;
}
