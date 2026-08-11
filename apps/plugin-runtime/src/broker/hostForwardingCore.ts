/**
 * Host-forwarding broker core (ТЗ v3.2 §10, §15.2, §26.2.1; ADR-0027;
 * Stage D part 9b).
 *
 * Where the reference core runs the policy locally, this core relays every
 * admitted call host-ward as an RPC_REQUEST control frame and settles the
 * worker-side promise from the matching RPC_RESPONSE. It still enforces the
 * protocol-level envelope (shape, deadline cap and expiry, causal cycles,
 * local revocation state, duplicate requestIds) so admission and in-flight
 * abort decisions are protocol-level, not per-implementation (§10, §15.1);
 * the actual capability decision stays in Main Host.
 *
 * Revocation flows host → runtime (BROKER_REVOKE frame): the runtime records
 * the revoked pair so new calls fail fast before crossing the wire, and
 * aborts matching in-flight calls so worker-side pending promises reject
 * with CAPABILITY_REVOKED. A dead worker (restart/terminate) aborts its
 * in-flight calls through {@link abortWorker}.
 */
import {
  BROKER_MAX_DEADLINE_MS,
  type BrokerCallRequest,
  type PluginRuntimeRpcRequestBody,
  type PluginRuntimeRpcRequestDataBody,
  type PluginRuntimeRpcResponseBody,
} from '@neotavern/contracts';
import {
  BrokerErrorCode,
  BrokerCallError,
  type BrokerCallHandle,
  type BrokerWorkerRef,
  type OpaqueBrokerCall,
} from './capabilityBroker.js';

/** Default cap on concurrent calls awaiting the host (§20 in-flight bounds). */
const DEFAULT_MAX_INFLIGHT = 1024;

export interface HostForwardingOptions {
  /** Host-ward RPC_REQUEST frame sender (runtime-main provides it). */
  sendRpcRequest: (body: PluginRuntimeRpcRequestBody) => void;
  /**
   * Host-ward RPC_REQUEST_DATA frame sender (Stage F part 13; runtime-main
   * writes the opaque payload to the fd 4 data pipe). Optional: transports
   * without a data pipe fail large-args calls with backpressure instead of
   * hanging.
   */
  sendRpcRequestData?: (body: PluginRuntimeRpcRequestDataBody) => void;
  /** Injectable clock (tests use a fake clock for deadline expiry). */
  now?: () => number;
  /** Cap on concurrent in-flight calls; excess fails with SERVICE_UNAVAILABLE. */
  maxInflight?: number;
}

interface InFlightEntry {
  worker: BrokerWorkerRef;
  pluginId: string;
  capabilityName: string;
  controller: AbortController;
  deadlineTimer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export interface HostForwardingCore {
  /** Admit a call and relay it host-ward (CapabilityBrokerCore). */
  submit(call: BrokerCallRequest, worker?: BrokerWorkerRef): BrokerCallHandle;
  /**
   * Admit a data-pipe call (opaque args, Stage F part 13) and relay the
   * payload host-ward without decoding it (§15.1). Admission, deadline and
   * revocation use the mirrored metadata fields.
   */
  submitOpaque(call: OpaqueBrokerCall, worker?: BrokerWorkerRef): BrokerCallHandle;
  /** Revoke a capability (or all of a plugin); aborts matching in-flight. */
  revoke(pluginId: string, name?: string, reason?: string): number;
  /** True when the plugin/capability pair is locally revoked. */
  isRevoked(pluginId: string, name: string): boolean;
  /** In-flight call count (diagnostics, §40). */
  pendingCount(): number;
  /** Abort every in-flight call (runtime shutdown). */
  shutdown(): void;
  /**
   * Settle the matching in-flight call from a host RPC_RESPONSE frame.
   * Returns false when the requestId is unknown or the echoed worker
   * identity does not match (stale response racing a restart).
   */
  handleRpcResponse(body: PluginRuntimeRpcResponseBody): boolean;
  /** Abort every in-flight call of a terminated worker instance. */
  abortWorker(workerId: number, workerEpoch: number): number;
}

export function createHostForwardingCore(options: HostForwardingOptions): HostForwardingCore {
  const now = options.now ?? Date.now;
  const maxInflight = options.maxInflight ?? DEFAULT_MAX_INFLIGHT;
  const inFlight = new Map<string, InFlightEntry>();
  const revokedPairs = new Set<string>();
  const revokedPlugins = new Set<string>();

  const pairKey = (pluginId: string, name: string): string => `${pluginId}\u0000${name}`;

  function abortInFlight(
    pluginId: string,
    name: string | undefined,
    reason: string | undefined,
  ): number {
    let aborted = 0;
    for (const [requestId, pending] of inFlight) {
      if (pending.pluginId !== pluginId) continue;
      if (name !== undefined && pending.capabilityName !== name) continue;
      pending.controller.abort(
        new BrokerCallError(BrokerErrorCode.CAPABILITY_REVOKED, {
          message: reason ?? 'capability revoked while the call was in flight',
          details: { pluginId, capabilityName: pending.capabilityName },
        }),
      );
      clearTimeout(pending.deadlineTimer);
      inFlight.delete(requestId);
      aborted += 1;
    }
    return aborted;
  }

  interface AdmitParams {
    requestId: string;
    pluginId: string;
    capabilityName: string;
    causalChain: string[];
    deadlineAt: number;
    worker: BrokerWorkerRef;
    controller: AbortController;
    /** Called after the entry is registered; return false to fail the call
     * (e.g. data-pipe backpressure). */
    onAdmitted: () => boolean;
  }

  /** Shared admission + in-flight registration for control and data calls. */
  function admitAndRegister(params: AdmitParams): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (params.deadlineAt < now()) {
        reject(
          new BrokerCallError(BrokerErrorCode.OPERATION_DEADLINE, {
            message: 'call deadline already passed',
          }),
        );
        return;
      }
      if (params.deadlineAt > now() + BROKER_MAX_DEADLINE_MS) {
        reject(
          new BrokerCallError(BrokerErrorCode.VALIDATION_FAILED, {
            message: 'call deadline exceeds the broker cap',
          }),
        );
        return;
      }
      // §26.2.1: the caller appends its own id to the chain; a chain that
      // already contains it is a re-entrant cycle — fail fast.
      if (params.causalChain.includes(params.pluginId)) {
        reject(
          new BrokerCallError(BrokerErrorCode.SERVICE_CALL_CYCLE, {
            message: 'service call would close a cycle',
            details: { chain: [...params.causalChain, params.pluginId] },
          }),
        );
        return;
      }
      if (
        revokedPlugins.has(params.pluginId) ||
        revokedPairs.has(pairKey(params.pluginId, params.capabilityName))
      ) {
        reject(
          new BrokerCallError(BrokerErrorCode.CAPABILITY_REVOKED, {
            message: 'capability revoked before the call started',
            details: { capabilityName: params.capabilityName },
          }),
        );
        return;
      }
      if (inFlight.has(params.requestId)) {
        reject(
          new BrokerCallError(BrokerErrorCode.VALIDATION_FAILED, {
            message: 'duplicate in-flight requestId',
          }),
        );
        return;
      }
      if (inFlight.size >= maxInflight) {
        reject(
          new BrokerCallError(BrokerErrorCode.SERVICE_UNAVAILABLE, {
            message: 'broker forwarding capacity reached',
          }),
        );
        return;
      }
      const entry: InFlightEntry = {
        worker: params.worker,
        pluginId: params.pluginId,
        capabilityName: params.capabilityName,
        controller: params.controller,
        deadlineTimer: undefined as unknown as NodeJS.Timeout,
        resolve,
        reject,
      };
      // Abort (revoke/deadline/shutdown/worker exit) rejects the pending
      // promise with the abort reason; a settled promise ignores late
      // settles, so a response racing a revoke is safe.
      params.controller.signal.addEventListener(
        'abort',
        () => {
          const reason =
            params.controller.signal.reason instanceof Error
              ? params.controller.signal.reason
              : new BrokerCallError(BrokerErrorCode.CAPABILITY_REVOKED, {
                  message: 'call aborted',
                });
          reject(reason);
        },
        { once: true },
      );
      const deadlineMs = Math.max(0, params.deadlineAt - now());
      entry.deadlineTimer = setTimeout(() => {
        const pending = inFlight.get(params.requestId);
        if (!pending) return;
        pending.controller.abort(
          new BrokerCallError(BrokerErrorCode.OPERATION_DEADLINE, {
            message: 'call deadline exceeded while awaiting the host',
          }),
        );
        clearTimeout(pending.deadlineTimer);
        inFlight.delete(params.requestId);
      }, deadlineMs);
      inFlight.set(params.requestId, entry);
      if (params.onAdmitted() === false) {
        clearTimeout(entry.deadlineTimer);
        inFlight.delete(params.requestId);
        params.controller.abort(
          new BrokerCallError(BrokerErrorCode.SERVICE_UNAVAILABLE, {
            message: 'data pipe backpressure',
          }),
        );
      }
    });
  }

  function submit(call: BrokerCallRequest, worker?: BrokerWorkerRef): BrokerCallHandle {
    const workerRef = worker ?? {
      workerId: 0,
      workerEpoch: 0,
    };
    const controller = new AbortController();
    const handle: BrokerCallHandle = {
      requestId: call.requestId,
      signal: controller.signal,
      promise: Promise.resolve(),
    };
    handle.promise = admitAndRegister({
      requestId: call.requestId,
      pluginId: call.caller.pluginId,
      capabilityName: call.capability.name,
      causalChain: call.causalChain,
      deadlineAt: call.deadlineAt,
      worker: workerRef,
      controller,
      onAdmitted: () => {
        options.sendRpcRequest({
          workerId: workerRef.workerId,
          workerEpoch: workerRef.workerEpoch,
          call,
        });
        return true;
      },
    });
    return handle;
  }

  function submitOpaque(call: OpaqueBrokerCall, worker?: BrokerWorkerRef): BrokerCallHandle {
    const workerRef = worker ?? {
      workerId: 0,
      workerEpoch: 0,
    };
    const controller = new AbortController();
    const handle: BrokerCallHandle = {
      requestId: call.requestId,
      signal: controller.signal,
      promise: Promise.resolve(),
    };
    handle.promise = admitAndRegister({
      requestId: call.requestId,
      pluginId: call.pluginId,
      capabilityName: call.capabilityName,
      causalChain: call.causalChain,
      deadlineAt: call.deadlineAt,
      worker: workerRef,
      controller,
      onAdmitted: () => {
        const send = options.sendRpcRequestData;
        if (send === undefined) {
          // Transport without a data pipe: fail fast rather than hang.
          return false;
        }
        send({
          workerId: workerRef.workerId,
          workerEpoch: workerRef.workerEpoch,
          payloadBytes: call.payloadBytes,
        });
        return true;
      },
    });
    return handle;
  }

  function handleRpcResponse(body: PluginRuntimeRpcResponseBody): boolean {
    const pending = inFlight.get(body.requestId);
    if (!pending) return false;
    if (
      pending.worker.workerId !== body.workerId ||
      pending.worker.workerEpoch !== body.workerEpoch
    ) {
      // Stale response racing a worker restart; drop it.
      return false;
    }
    clearTimeout(pending.deadlineTimer);
    inFlight.delete(body.requestId);
    if (body.ok) {
      pending.resolve(body.result);
    } else {
      const error = body.error;
      const details =
        typeof error?.details === 'object' && error?.details !== null
          ? (error.details as Record<string, unknown>)
          : undefined;
      pending.reject(
        new BrokerCallError(error?.code ?? BrokerErrorCode.INTERNAL, {
          message: error?.message ?? 'host call failed',
          retryable: error?.retryable,
          details,
        }),
      );
    }
    return true;
  }

  function abortWorker(workerId: number, workerEpoch: number): number {
    let aborted = 0;
    for (const [requestId, pending] of inFlight) {
      if (pending.worker.workerId !== workerId) continue;
      if (pending.worker.workerEpoch !== workerEpoch) continue;
      pending.controller.abort(
        new BrokerCallError(BrokerErrorCode.SERVICE_UNAVAILABLE, {
          message: 'worker terminated while the call was in flight',
          details: { workerId, workerEpoch },
        }),
      );
      clearTimeout(pending.deadlineTimer);
      inFlight.delete(requestId);
      aborted += 1;
    }
    return aborted;
  }

  return {
    submit,
    submitOpaque,
    revoke(pluginId, name, reason) {
      if (name === undefined) {
        revokedPlugins.add(pluginId);
      } else {
        revokedPairs.add(pairKey(pluginId, name));
      }
      return abortInFlight(pluginId, name, reason);
    },
    isRevoked(pluginId, name) {
      return revokedPlugins.has(pluginId) || revokedPairs.has(pairKey(pluginId, name));
    },
    pendingCount() {
      return inFlight.size;
    },
    shutdown() {
      for (const [, pending] of inFlight) {
        pending.controller.abort(
          new BrokerCallError(BrokerErrorCode.CAPABILITY_REVOKED, {
            message: 'broker shutting down',
          }),
        );
        clearTimeout(pending.deadlineTimer);
      }
      inFlight.clear();
    },
    handleRpcResponse,
    abortWorker,
  };
}
