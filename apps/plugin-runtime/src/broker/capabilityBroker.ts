/**
 * Capability Broker core inside the Plugin Runtime (ТЗ v3.2 §10, §11, §26.2.1).
 *
 * The decision authority lives in Main Host (ADR-0027: host owns grants,
 * revoke, consent); this module is the runtime-side admission point that
 * implements the §10.1 checks on every call and the §10.2 revoke semantics:
 *
 * - envelope validation (defense in depth; the worker bootstrap validates too);
 * - deadline admission (fail fast, §26.1.1) and in-flight deadline abort;
 * - service-cycle detection over the causal chain A→B→C (§26.2.1): a chain
 *   that already contains the caller's pluginId is a re-entrant cycle and is
 *   rejected with SERVICE_CALL_CYCLE before any work starts;
 * - revocation overlay: `revoke()` rejects new calls and aborts matching
 *   in-flight ones with CAPABILITY_REVOKED (B14 revoke race);
 * - policy decision (grant/trust/consent) delegated to an injected
 *   `BrokerPolicy` — in production that is the host-side broker state, in
 *   tests an in-memory grant repository.
 *
 * The core is transport-free: the bridge gateway (`brokerGateway.ts`) feeds
 * it worker bridge messages and replies over the worker's control port.
 */
import type { BrokerCallRequest, BrokerWireError } from '@neotavern/contracts';
import { BROKER_MAX_CAUSAL_CHAIN, BROKER_MAX_DEADLINE_MS } from '@neotavern/contracts';

/** Stable codes the core itself raises (ТЗ §41; mirrored by the bootstrap). */
export const BrokerErrorCode = {
  CAPABILITY_DENIED: 'CAPABILITY_DENIED',
  CAPABILITY_REVOKED: 'CAPABILITY_REVOKED',
  TRUST_REQUIRED: 'TRUST_REQUIRED',
  POLICY_DENIED: 'POLICY_DENIED',
  OPERATION_DEADLINE: 'OPERATION_DEADLINE',
  SERVICE_CALL_CYCLE: 'SERVICE_CALL_CYCLE',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INTERNAL: 'INTERNAL',
} as const;
export type BrokerErrorCodeValue = (typeof BrokerErrorCode)[keyof typeof BrokerErrorCode];

/** Structured failure raised inside the core or by a policy. */
export class BrokerCallError extends Error {
  readonly code: BrokerErrorCodeValue | string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: BrokerErrorCodeValue | string,
    options: { message?: string; retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(options.message ?? code);
    this.name = 'BrokerCallError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/** Decision for one call; `code` is a §41 code (deny reason is never a
 * user-facing sentence, AGENTS.md §5). */
export type BrokerDecision =
  { allowed: true } | { allowed: false; code: string; details?: Record<string, unknown> };

/** The decision/execution authority injected into the core. */
export interface BrokerPolicy {
  /** Grant/trust/consent decision (§10.1). Must not throw. */
  authorize(call: BrokerCallRequest): BrokerDecision;
  /** Run the admitted operation. Throw BrokerCallError (or code-like error)
   * to fail the call. `signal` aborts on revoke or deadline. */
  execute(call: BrokerCallRequest, signal: AbortSignal): Promise<unknown>;
}

export interface BrokerCallHandle {
  requestId: string;
  /** Fires on revoke, deadline or broker shutdown. */
  signal: AbortSignal;
  /** Settles with the operation result or rejects with BrokerCallError. */
  promise: Promise<unknown>;
}

interface InFlight {
  pluginId: string;
  capabilityName: string;
  controller: AbortController;
  deadlineTimer: NodeJS.Timeout;
}

/** Worker identity stamped on host-ward RPC requests (§16.1, part 9b). */
export interface BrokerWorkerRef {
  workerId: number;
  workerEpoch: number;
}

/**
 * Opaque broker call (Stage F part 13): a call whose arguments ride the data
 * pipe. The wire payload (`payloadBytes`, the mirrored
 * `PluginRuntimeRpcRequestBody` JSON) stays opaque to the runtime — the
 * metadata fields mirror the envelope so admission, revocation and deadline
 * handling work without decoding it (§15.1). Endpoint cores that consume the
 * args (the in-process reference core) decode the payload themselves.
 */
export interface OpaqueBrokerCall {
  requestId: string;
  pluginId: string;
  capabilityName: string;
  causalChain: string[];
  deadlineAt: number;
  payloadBytes: Uint8Array;
}

export interface CapabilityBrokerCore {
  /**
   * Admit a call: validate, admit, register in-flight, execute. The optional
   * `worker` reference is used by host-forwarding implementations to route
   * responses and attribute calls; the local core ignores it.
   */
  submit(call: BrokerCallRequest, worker?: BrokerWorkerRef): BrokerCallHandle;
  /**
   * Admit a data-pipe call (opaque args, Stage F part 13). Host-forwarding
   * cores relay `payloadBytes` without decoding; endpoint cores (the local
   * reference core) decode and run the policy as usual.
   */
  submitOpaque(call: OpaqueBrokerCall, worker?: BrokerWorkerRef): BrokerCallHandle;
  /**
   * Revoke a capability (or all of a plugin when `name` is omitted): new
   * calls are rejected, matching in-flight calls are aborted. Returns the
   * number of in-flight calls aborted (§10.2, B14).
   */
  revoke(pluginId: string, name?: string, reason?: string): number;
  /** True when the plugin/capability pair is revoked. */
  isRevoked(pluginId: string, name: string): boolean;
  /** In-flight call count (diagnostics, §40). */
  pendingCount(): number;
  /** Abort every in-flight call (worker teardown / runtime shutdown). */
  shutdown(): void;
}

/** Structural guard shared by the core and the gateway (mirrors §15.11
 * bounds without importing TypeBox into the runtime hot path). */
export function assertBrokerCallShape(value: unknown): value is BrokerCallRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record['requestId'] !== 'string' || record['requestId'].length < 8) return false;
  if (typeof record['method'] !== 'string' || record['method'].length === 0) return false;
  if (typeof record['deadlineAt'] !== 'number' || !Number.isFinite(record['deadlineAt'])) {
    return false;
  }
  const caller = record['caller'] as Record<string, unknown> | undefined;
  if (typeof caller !== 'object' || caller === null) return false;
  if (typeof caller['pluginId'] !== 'string' || caller['pluginId'].length === 0) return false;
  if (typeof caller['installationId'] !== 'string' || caller['installationId'].length === 0) {
    return false;
  }
  const trustLevel = caller['trustLevel'];
  if (trustLevel !== 'sandbox' && trustLevel !== 'extended' && trustLevel !== 'trusted') {
    return false;
  }
  const capability = record['capability'] as Record<string, unknown> | undefined;
  if (typeof capability !== 'object' || capability === null) return false;
  if (typeof capability['name'] !== 'string' || capability['name'].length === 0) return false;
  if (
    !Array.isArray(record['causalChain']) ||
    record['causalChain'].length > BROKER_MAX_CAUSAL_CHAIN
  ) {
    return false;
  }
  if (
    record['causalChain'].some(
      (entry) => typeof entry !== 'string' || entry.length === 0 || entry.length > 160,
    )
  ) {
    return false;
  }
  return true;
}

function invalidCall(message: string): BrokerCallError {
  return new BrokerCallError(BrokerErrorCode.VALIDATION_FAILED, { message });
}

/** Build the wire failure shape; unknown error objects degrade to INTERNAL
 * (never leak plugin stack or realm details host-ward, §40.1.1). */
export function toBrokerError(error: unknown): BrokerWireError {
  if (error instanceof BrokerCallError) {
    return {
      code: error.code,
      message: error.message.slice(0, 2000),
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (error instanceof Error) {
    const code = /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : BrokerErrorCode.INTERNAL;
    return { code, message: error.message.slice(0, 2000), retryable: false };
  }
  return { code: BrokerErrorCode.INTERNAL, message: 'internal broker failure', retryable: false };
}

export function createCapabilityBrokerCore(
  policy: BrokerPolicy,
  options?: { now?: () => number },
): CapabilityBrokerCore {
  const now = options?.now ?? Date.now;
  const inFlight = new Map<string, InFlight>();
  const revokedPairs = new Set<string>();
  const revokedPlugins = new Set<string>();

  const pairKey = (pluginId: string, name: string): string => `${pluginId}\u0000${name}`;

  const isRevokedKey = (pluginId: string, name: string): boolean =>
    revokedPlugins.has(pluginId) || revokedPairs.has(pairKey(pluginId, name));

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

  function submit(call: BrokerCallRequest): BrokerCallHandle {
    const controller = new AbortController();
    const handle: BrokerCallHandle = {
      requestId: call.requestId,
      signal: controller.signal,
      promise: Promise.resolve(),
    };
    let deadlineTimer: NodeJS.Timeout | undefined;

    const run = async (): Promise<unknown> => {
      if (!assertBrokerCallShape(call)) throw invalidCall('malformed broker call envelope');
      if (call.deadlineAt < now()) {
        throw new BrokerCallError(BrokerErrorCode.OPERATION_DEADLINE, {
          message: 'call deadline already passed',
        });
      }
      if (call.deadlineAt > now() + BROKER_MAX_DEADLINE_MS) {
        throw new BrokerCallError(BrokerErrorCode.VALIDATION_FAILED, {
          message: 'call deadline exceeds the broker cap',
        });
      }
      // §26.2.1: the caller appends its own id to the chain; a chain that
      // already contains it is a re-entrant cycle — fail fast.
      if (call.causalChain.includes(call.caller.pluginId)) {
        throw new BrokerCallError(BrokerErrorCode.SERVICE_CALL_CYCLE, {
          message: 'service call would close a cycle',
          details: { chain: [...call.causalChain, call.caller.pluginId] },
        });
      }
      if (isRevokedKey(call.caller.pluginId, call.capability.name)) {
        throw new BrokerCallError(BrokerErrorCode.CAPABILITY_REVOKED, {
          message: 'capability revoked before the call started',
          details: { capabilityName: call.capability.name },
        });
      }
      const decision = policy.authorize(call);
      if (!decision.allowed) {
        throw new BrokerCallError(decision.code, { details: decision.details });
      }
      if (inFlight.has(call.requestId)) {
        throw new BrokerCallError(BrokerErrorCode.VALIDATION_FAILED, {
          message: 'duplicate in-flight requestId',
        });
      }
      const deadlineMs = Math.max(0, call.deadlineAt - now());
      deadlineTimer = setTimeout(() => {
        const pending = inFlight.get(call.requestId);
        if (!pending) return;
        pending.controller.abort(
          new BrokerCallError(BrokerErrorCode.OPERATION_DEADLINE, {
            message: 'call deadline exceeded while in flight',
          }),
        );
        clearTimeout(pending.deadlineTimer);
        inFlight.delete(call.requestId);
      }, deadlineMs);
      inFlight.set(call.requestId, {
        pluginId: call.caller.pluginId,
        capabilityName: call.capability.name,
        controller,
        deadlineTimer,
      });
      try {
        return await policy.execute(call, controller.signal);
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        inFlight.delete(call.requestId);
      }
    };

    handle.promise = run();
    return handle;
  }

  function submitOpaque(call: OpaqueBrokerCall): BrokerCallHandle {
    // Endpoint core: the args live in the payload, so decode here — exactly
    // once (§15.1). The runtime's host-forwarding core never decodes.
    try {
      const decoded = JSON.parse(new TextDecoder().decode(call.payloadBytes)) as {
        call?: unknown;
      };
      if (!assertBrokerCallShape(decoded.call)) {
        return invalidOpaqueHandle(call.requestId, 'malformed data-pipe call envelope');
      }
      return submit(decoded.call as BrokerCallRequest);
    } catch {
      return invalidOpaqueHandle(call.requestId, 'malformed data-pipe call payload');
    }
  }

  function invalidOpaqueHandle(requestId: string, message: string): BrokerCallHandle {
    const error = new BrokerCallError(BrokerErrorCode.VALIDATION_FAILED, { message });
    const handle: BrokerCallHandle = {
      requestId,
      signal: new AbortController().signal,
      promise: Promise.reject(error),
    };
    void handle.promise.catch(() => undefined);
    return handle;
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
      return isRevokedKey(pluginId, name);
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
  };
}
