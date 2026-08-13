/**
 * Shared wire request-envelope framing (ТЗ §6.3/§15.1).
 *
 * Every local-kernel transport (Tauri IPC, mobile WebView bridge) must emit
 * byte-identical request envelopes for the same operation, so the kernel
 * adapter cannot tell which shell produced a call. This module is the single
 * source of that framing; transports only supply the per-call request id.
 */
import { WIRE_PROTOCOL, WIRE_SCHEMA_HASH, type ProductErrorDto } from '@neotavern/contracts';

/** Structural shape of the outgoing request envelope (`wire.request.envelope`). */
export interface WireRequestEnvelope {
  wireProtocol: { major: number; minor: number };
  schemaHash: string;
  requestId: string;
  operationId: string;
  payload: unknown;
}

/** Structural shape of the response envelope (`wire.response.envelope`). */
export type WireResponseEnvelope =
  | { kind: 'ok'; requestId: string; result: unknown }
  | { kind: 'error'; requestId: string; error: ProductErrorDto };

/**
 * Build a `wire.request.envelope` for one operation call. Property order is
 * preserved by `JSON.stringify`, so every local transport serializes the same
 * bytes for the same request id/operation/payload.
 */
export function buildRequestEnvelope(options: {
  requestId: string;
  operationId: string;
  payload: unknown;
}): WireRequestEnvelope {
  return {
    wireProtocol: { major: WIRE_PROTOCOL.major, minor: WIRE_PROTOCOL.minor },
    schemaHash: WIRE_SCHEMA_HASH,
    requestId: options.requestId,
    operationId: options.operationId,
    payload: options.payload,
  };
}
