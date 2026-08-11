/**
 * Plugin SDK revision-4 kernel: protocol envelopes and handshake (rev4 §A1/A2).
 *
 * `window.postMessage` is used exactly once — to deliver the MessagePort and a
 * one-time nonce. Everything after the ACK travels over the MessagePort, so a
 * compromised sibling frame can neither inject nor observe SDK traffic.
 */
import { KernelErrorCode, KernelError, type PluginErrorWire } from './errors.js';

/** Protocol major the host and SDK speak. Bumps are incompatible (rev4 §A4). */
export const PROTOCOL_VERSION = '2.0.0';
/** SDK kernel version. */
export const KERNEL_SDK_VERSION = '1.0.0';

/** Max serialized envelope size; larger envelopes are rejected whole. */
export const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;

export interface PluginHandshake {
  protocolVersion: string;
  sdkVersion: string;
  pluginId: string;
  installationId: string;
  instanceId: string;
  requestedFeatures: string[];
}

export interface HostHandshake {
  protocolVersion: string;
  hostVersion: string;
  grantedCapabilities: Array<{
    name: string;
    scope?: unknown;
    revision: number;
    grantedAt: number;
  }>;
  supportedFeatures: Record<string, number>;
  limits: unknown;
  /**
   * Resolved design-token values for SDK UI widgets (`api.ui.modelMenu`):
   * `{ '--st-color-…': 'rgb(…)' }` as read from the host document. Optional
   * for compatibility; widgets fall back to their built-in palette.
   */
  themeTokens?: Record<string, string>;
}

/** The one-shot bootstrap payload sent over `window.postMessage` (rev4 §A1). */
export interface BootstrapMessage {
  type: 'neotavern.kernel.bootstrap';
  pluginId: string;
  nonce: string;
  port: MessagePort;
}

/** Discriminated envelope kinds crossing the port. */
export type Envelope =
  | {
      kind: 'rpc.request';
      id: string;
      instanceId: string;
      method: string;
      params: unknown;
      deadline: number | null;
      idempotencyKey?: string;
    }
  | { kind: 'rpc.response'; id: string; ok: true; result: unknown }
  | { kind: 'rpc.response'; id: string; ok: false; error: PluginErrorWire }
  | { kind: 'rpc.cancel'; id: string }
  | { kind: 'evt.emit'; event: string; payload: unknown; eventId: string; cursor?: string }
  | {
      kind: 'stream.open';
      streamId: string;
      direction: 'host-to-plugin' | 'plugin-to-host';
      meta: Record<string, unknown>;
    }
  | { kind: 'stream.credit'; streamId: string; bytes: number }
  | { kind: 'stream.chunk'; streamId: string; seq: number; buffer: ArrayBuffer }
  | { kind: 'stream.end'; streamId: string }
  | { kind: 'stream.error'; streamId: string; error: PluginErrorWire }
  | { kind: 'stream.cancel'; streamId: string }
  | { kind: 'capability.revoked'; name: string; revision: number }
  | { kind: 'lifecycle'; state: string };

/** Structural validation of an incoming envelope. Malformed → null. */
export function parseEnvelope(value: unknown): Envelope | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  if (typeof kind !== 'string') return null;
  switch (kind) {
    case 'rpc.request': {
      if (typeof record['id'] !== 'string' || typeof record['method'] !== 'string') return null;
      if (typeof record['instanceId'] !== 'string') return null;
      const envelope: Envelope = {
        kind: 'rpc.request',
        id: record['id'],
        instanceId: record['instanceId'],
        method: record['method'],
        params: record['params'],
        deadline: typeof record['deadline'] === 'number' ? record['deadline'] : null,
      };
      if (typeof record['idempotencyKey'] === 'string')
        envelope.idempotencyKey = record['idempotencyKey'];
      return envelope;
    }
    case 'rpc.response': {
      if (typeof record['id'] !== 'string') return null;
      if (record['ok'] === true) {
        return { kind: 'rpc.response', id: record['id'], ok: true, result: record['result'] };
      }
      if (
        record['ok'] === false &&
        typeof record['error'] === 'object' &&
        record['error'] !== null
      ) {
        return {
          kind: 'rpc.response',
          id: record['id'],
          ok: false,
          error: record['error'] as PluginErrorWire,
        };
      }
      return null;
    }
    case 'rpc.cancel':
      return typeof record['id'] === 'string' ? { kind: 'rpc.cancel', id: record['id'] } : null;
    case 'evt.emit':
      if (typeof record['event'] !== 'string' || typeof record['eventId'] !== 'string') return null;
      return {
        kind: 'evt.emit',
        event: record['event'],
        payload: record['payload'],
        eventId: record['eventId'],
        ...(typeof record['cursor'] === 'string' ? { cursor: record['cursor'] } : {}),
      };
    case 'stream.open':
      if (typeof record['streamId'] !== 'string') return null;
      if (record['direction'] !== 'host-to-plugin' && record['direction'] !== 'plugin-to-host')
        return null;
      return {
        kind: 'stream.open',
        streamId: record['streamId'],
        direction: record['direction'],
        meta:
          typeof record['meta'] === 'object' && record['meta'] !== null
            ? (record['meta'] as Record<string, unknown>)
            : {},
      };
    case 'stream.credit':
      return typeof record['streamId'] === 'string' &&
        typeof record['bytes'] === 'number' &&
        record['bytes'] > 0
        ? { kind: 'stream.credit', streamId: record['streamId'], bytes: record['bytes'] }
        : null;
    case 'stream.chunk':
      if (typeof record['streamId'] !== 'string' || typeof record['seq'] !== 'number') return null;
      if (!(record['buffer'] instanceof ArrayBuffer)) return null;
      return {
        kind: 'stream.chunk',
        streamId: record['streamId'],
        seq: record['seq'],
        buffer: record['buffer'],
      };
    case 'stream.end':
      return typeof record['streamId'] === 'string'
        ? { kind: 'stream.end', streamId: record['streamId'] }
        : null;
    case 'stream.error':
      if (
        typeof record['streamId'] !== 'string' ||
        typeof record['error'] !== 'object' ||
        record['error'] === null
      ) {
        return null;
      }
      return {
        kind: 'stream.error',
        streamId: record['streamId'],
        error: record['error'] as PluginErrorWire,
      };
    case 'capability.revoked':
      return typeof record['name'] === 'string' && typeof record['revision'] === 'number'
        ? { kind: 'capability.revoked', name: record['name'], revision: record['revision'] }
        : null;
    case 'lifecycle':
      return typeof record['state'] === 'string'
        ? { kind: 'lifecycle', state: record['state'] }
        : null;
    default:
      // Unknown kinds are ignored by design (forward compat, rev4 §A2).
      return null;
  }
}

/** Envelope size guard: serialized size must stay bounded. */
export function envelopeFitsBudget(envelope: Envelope, maxBytes: number): boolean {
  try {
    return JSON.stringify(envelope).length <= maxBytes;
  } catch {
    return false;
  }
}

/** Validate a plugin handshake (rev4 §A1). */
export function validatePluginHandshake(
  value: unknown,
  expectedNonce: string | null,
): PluginHandshake {
  if (typeof value !== 'object' || value === null) {
    throw new KernelError(KernelErrorCode.HANDSHAKE_REJECTED, {
      details: { reason: 'not-an-object' },
    });
  }
  const record = value as Record<string, unknown>;
  if (expectedNonce !== null && record['nonce'] !== expectedNonce) {
    throw new KernelError(KernelErrorCode.HANDSHAKE_REJECTED, {
      details: { reason: 'nonce-mismatch' },
    });
  }
  if (
    typeof record['protocolVersion'] !== 'string' ||
    typeof record['pluginId'] !== 'string' ||
    typeof record['instanceId'] !== 'string'
  ) {
    throw new KernelError(KernelErrorCode.HANDSHAKE_REJECTED, {
      details: { reason: 'missing-fields' },
    });
  }
  return {
    protocolVersion: record['protocolVersion'],
    sdkVersion: typeof record['sdkVersion'] === 'string' ? record['sdkVersion'] : '0.0.0',
    pluginId: record['pluginId'],
    installationId:
      typeof record['installationId'] === 'string' ? record['installationId'] : record['pluginId'],
    instanceId: record['instanceId'],
    requestedFeatures: Array.isArray(record['requestedFeatures'])
      ? record['requestedFeatures'].filter(
          (feature): feature is string => typeof feature === 'string',
        )
      : [],
  };
}
