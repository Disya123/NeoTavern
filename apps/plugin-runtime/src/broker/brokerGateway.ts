/**
 * Broker bridge gateway (ТЗ v3.2 §10, §16).
 *
 * Sits between the worker bridge and the broker core: it recognizes
 * `rpc-request` bridge messages (§16, typed in `@neotavern/contracts`), submits the
 * embedded BrokerCallRequest to the core and posts the `rpc-response` back to
 * the worker's control port. The supervisor stays transport-pure (§16.1: it
 * routes, it does not decode application payloads) — it only forwards
 * unrecognized bridge messages to this handler.
 *
 * Revocation does not flow worker-ward: the host sends revoke commands to the
 * runtime (BrokerRevokeCommand, Stage D integration); the gateway exposes
 * `revoke` so the runtime-side owner (runtime main, tests) can forward them.
 */
import type { BrokerCallRequest } from '@neotavern/contracts';
import { PLUGIN_RUNTIME_MAX_DATA_PAYLOAD_BYTES } from '@neotavern/contracts';
import type { WorkerRecord } from '../supervisor.js';
import {
  assertBrokerCallShape,
  toBrokerError,
  type CapabilityBrokerCore,
  type OpaqueBrokerCall,
} from './capabilityBroker.js';

interface BridgeRpcRequest {
  kind: 'rpc-request';
  call: unknown;
}

interface BridgeRpcRequestData {
  kind: 'rpc-request-data';
  requestId: string;
  pluginId: string;
  capabilityName: string;
  causalChain: string[];
  deadlineAt: number;
  payloadBytes: Uint8Array;
}

function isRpcRequest(value: unknown): value is BridgeRpcRequest {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as Record<string, unknown>)['kind'] === 'rpc-request'
  );
}

function isRpcRequestData(value: unknown): value is BridgeRpcRequestData {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record['kind'] !== 'rpc-request-data') return false;
  if (typeof record['requestId'] !== 'string' || record['requestId'].length < 8) return false;
  if (typeof record['pluginId'] !== 'string' || record['pluginId'].length === 0) return false;
  if (typeof record['capabilityName'] !== 'string' || record['capabilityName'].length === 0) {
    return false;
  }
  if (!Array.isArray(record['causalChain'])) return false;
  if (typeof record['deadlineAt'] !== 'number' || !Number.isFinite(record['deadlineAt'])) {
    return false;
  }
  if (!(record['payloadBytes'] instanceof Uint8Array)) return false;
  return true;
}

export interface BrokerGateway {
  /**
   * Bridge message handler for the supervisor's `onBridgeMessage` hook.
   * Returns true when the message was consumed by the broker (rpc-request);
   * false for app-level messages the runtime should forward host-ward.
   */
  handleBridgeMessage(record: WorkerRecord, message: unknown): boolean;
  /** Forward a host-side revoke command (§10.2). Returns aborted call count. */
  revoke(pluginId: string, name?: string, reason?: string): number;
  /** Abort all in-flight calls (runtime shutdown). */
  shutdown(): void;
}

export function createBrokerGateway(core: CapabilityBrokerCore): BrokerGateway {
  return {
    handleBridgeMessage(record, message) {
      if (isRpcRequestData(message)) {
        // Stage F part 13: large args ride the data pipe. The runtime does
        // not decode the payload (§15.1); it still admits the call against
        // the mirrored metadata so revocation and deadlines apply.
        return handleRpcRequestData(record, message, core);
      }
      if (!isRpcRequest(message)) return false;
      const call = message.call;
      // Shape-guard before touching the core; malformed envelopes get a
      // structured failure rather than an unhandled rejection.
      if (!assertBrokerCallShape(call)) {
        record.control.postMessage({
          kind: 'rpc-response',
          requestId: isBrokerCallLike(message.call) ? message.call.requestId : 'invalid-call',
          ok: false,
          error: toBrokerError(
            Object.assign(new Error('VALIDATION_FAILED'), {
              message: 'malformed broker call envelope',
            }),
          ),
        });
        return true;
      }
      const typed = call as BrokerCallRequest;
      const handle = core.submit(typed, {
        workerId: record.workerId,
        workerEpoch: record.workerEpoch,
      });
      void handle.promise.then(
        (result) => {
          record.control.postMessage({
            kind: 'rpc-response',
            requestId: typed.requestId,
            ok: true,
            result,
          });
        },
        (error: unknown) => {
          record.control.postMessage({
            kind: 'rpc-response',
            requestId: typed.requestId,
            ok: false,
            error: toBrokerError(error),
          });
        },
      );
      return true;
    },
    revoke(pluginId, name, reason) {
      return core.revoke(pluginId, name, reason);
    },
    shutdown() {
      core.shutdown();
    },
  };
}

function isBrokerCallLike(value: unknown): value is { requestId: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)['requestId'] === 'string'
  );
}

/**
 * Admit a data-pipe call (Stage F part 13). The payload is opaque to the
 * runtime; the mirrored metadata is validated here so malformed messages get
 * a structured failure instead of an unhandled rejection, mirroring the
 * control path. The response is routed back exactly like `rpc-request`.
 */
function handleRpcRequestData(
  record: WorkerRecord,
  message: BridgeRpcRequestData,
  core: CapabilityBrokerCore,
): boolean {
  if (message.payloadBytes.byteLength > PLUGIN_RUNTIME_MAX_DATA_PAYLOAD_BYTES) {
    record.control.postMessage({
      kind: 'rpc-response',
      requestId: message.requestId,
      ok: false,
      error: toBrokerError(
        Object.assign(new Error('VALIDATION_FAILED'), {
          message: 'data-pipe call payload too large',
        }),
      ),
    });
    return true;
  }
  const opaque: OpaqueBrokerCall = {
    requestId: message.requestId,
    pluginId: message.pluginId,
    capabilityName: message.capabilityName,
    causalChain: message.causalChain,
    deadlineAt: message.deadlineAt,
    payloadBytes: message.payloadBytes,
  };
  const handle = core.submitOpaque(opaque, {
    workerId: record.workerId,
    workerEpoch: record.workerEpoch,
  });
  void handle.promise.then(
    (result) => {
      record.control.postMessage({
        kind: 'rpc-response',
        requestId: message.requestId,
        ok: true,
        result,
      });
    },
    (error: unknown) => {
      record.control.postMessage({
        kind: 'rpc-response',
        requestId: message.requestId,
        ok: false,
        error: toBrokerError(error),
      });
    },
  );
  return true;
}
