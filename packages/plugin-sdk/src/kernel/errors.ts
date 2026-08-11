/**
 * Plugin SDK revision-4 kernel: stable error model.
 *
 * Every operation that crosses the host↔plugin boundary fails with a
 * machine-readable code, a retryability hint and structured details — never a
 * ready-made human string (AGENTS.md §5, rev4 §A2). The wire shape is a plain
 * object so it survives structured clone across realms without losing
 * prototype-less class identity.
 */

/** Stable kernel-level error codes (rev4 §A2, §M2). */
export const KernelErrorCode = {
  /** Unknown method or unsupported protocol feature. */
  PROTOCOL_UNSUPPORTED: 'PROTOCOL_UNSUPPORTED',
  /** Envelope failed validation or carried an unknown required version. */
  PROTOCOL_INVALID: 'PROTOCOL_INVALID',
  /** Handshake rejected (nonce replay, wrong source, version mismatch). */
  HANDSHAKE_REJECTED: 'HANDSHAKE_REJECTED',
  /** The requested capability is not granted, expired or revoked. */
  CAPABILITY_DENIED: 'CAPABILITY_DENIED',
  /** A granted capability was revoked while the operation was in flight. */
  CAPABILITY_REVOKED: 'CAPABILITY_REVOKED',
  /** The call needs a higher trust level than the caller holds (ТЗ §11). */
  TRUST_REQUIRED: 'TRUST_REQUIRED',
  /** Policy (admin override, consent state) denied the operation. */
  POLICY_DENIED: 'POLICY_DENIED',
  /** Operation exceeded a resource budget (rev4 §M2). */
  PLUGIN_QUOTA_EXCEEDED: 'PLUGIN_QUOTA_EXCEEDED',
  /**
   * Soft resource pressure: retryable, the host queues or rejects with a
   * suggested `retryAfterMs` (ТЗ §19).
   */
  RESOURCE_PRESSURE: 'RESOURCE_PRESSURE',
  /** Hard per-plugin limit reached; the operation/process was terminated. */
  RESOURCE_LIMIT_EXCEEDED: 'RESOURCE_LIMIT_EXCEEDED',
  /** The requested resource profile is not allowed by policy. */
  RESOURCE_PROFILE_DENIED: 'RESOURCE_PROFILE_DENIED',
  /** Operation aborted by caller (`AbortSignal`) or by the host. */
  OPERATION_ABORTED: 'OPERATION_ABORTED',
  /** Operation exceeded its deadline. */
  OPERATION_DEADLINE: 'OPERATION_DEADLINE',
  /** Compare-and-set conflict: expectedRevision did not match. */
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  /** Idempotent replay with a different request body. */
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  /** Validation failed for params/registration payload. */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** Target entity (chat, message, blob, job…) does not exist. */
  NOT_FOUND: 'NOT_FOUND',
  /** Stream closed or failed mid-transfer. */
  STREAM_FAILED: 'STREAM_FAILED',
  /** Backend plugin runtime is unavailable or crashed. */
  BACKEND_UNAVAILABLE: 'BACKEND_UNAVAILABLE',
  /** Cross-plugin service id does not exist (rev4 §D services). */
  SERVICE_NOT_FOUND: 'SERVICE_NOT_FOUND',
  /** The providing plugin was removed or its frame is gone. */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** The method is not declared by the service. */
  SERVICE_METHOD_NOT_FOUND: 'SERVICE_METHOD_NOT_FOUND',
  /** The provider's handler threw; details.providerCode keeps its code. */
  SERVICE_ERROR: 'SERVICE_ERROR',
  /** Service call exceeded its deadline. */
  SERVICE_TIMEOUT: 'SERVICE_TIMEOUT',
  /** The provider's declared version does not satisfy the consumer. */
  SERVICE_VERSION_MISMATCH: 'SERVICE_VERSION_MISMATCH',
  /** The call would close a service cycle A→B→A (ТЗ §26.2.1). */
  SERVICE_CALL_CYCLE: 'SERVICE_CALL_CYCLE',
  /** Compute worker could not be spawned or crashed (rev4 §C2). */
  WORKER_SPAWN_FAILED: 'WORKER_SPAWN_FAILED',
  /** Event subscription cursor fell outside the replay window (rev4 §J1). */
  EVENT_CURSOR_EXPIRED: 'EVENT_CURSOR_EXPIRED',
  /** Buffered events were evicted before the consumer read them (§41). */
  EVENT_BUFFER_EVICTED: 'EVENT_BUFFER_EVICTED',
  /** Network destination rejected by the SSRF policy (§29.1). */
  NETWORK_DESTINATION_DENIED: 'NETWORK_DESTINATION_DENIED',
  /** A redirect target was rejected by the capability policy (§29.1.3). */
  NETWORK_REDIRECT_DENIED: 'NETWORK_REDIRECT_DENIED',
  /** Catch-all for unexpected host-side failures. */
  INTERNAL: 'INTERNAL',
} as const;

export type KernelErrorCodeValue = (typeof KernelErrorCode)[keyof typeof KernelErrorCode];

/** Serialized error shape crossing the wire (rev4 §A2). */
export interface PluginErrorWire {
  code: string;
  retryable: boolean;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
}

const RETRYABLE: ReadonlySet<string> = new Set([
  KernelErrorCode.PLUGIN_QUOTA_EXCEEDED,
  KernelErrorCode.RESOURCE_PRESSURE,
  KernelErrorCode.OPERATION_DEADLINE,
  KernelErrorCode.BACKEND_UNAVAILABLE,
  KernelErrorCode.STREAM_FAILED,
  KernelErrorCode.WORKER_SPAWN_FAILED,
  KernelErrorCode.SERVICE_UNAVAILABLE,
  KernelErrorCode.SERVICE_TIMEOUT,
  KernelErrorCode.INTERNAL,
]);

/** Error type thrown inside plugin/host code for kernel failures. */
export class KernelError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    options: {
      message?: string;
      retryable?: boolean;
      retryAfterMs?: number;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(options.message ?? code, { cause: options.cause });
    this.name = 'KernelError';
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details;
  }

  /** Plain-object form safe for structured clone / JSON. */
  toWire(): PluginErrorWire {
    return {
      code: this.code,
      retryable: this.retryable,
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function isKernelError(value: unknown): value is KernelError {
  return value instanceof KernelError;
}

/** Normalize any thrown value into the wire error shape. */
export function toWireError(value: unknown): PluginErrorWire {
  if (isKernelError(value)) return value.toWire();
  if (value instanceof Error && value.name === 'AbortError') {
    return { code: KernelErrorCode.OPERATION_ABORTED, retryable: false };
  }
  const code =
    value instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(value.message)
      ? value.message
      : KernelErrorCode.INTERNAL;
  return {
    code,
    retryable: RETRYABLE.has(code),
    details: { message: value instanceof Error ? safeMessage(value.message) : undefined },
  };
}

/** Rehydrate a wire error into a KernelError for throwing. */
export function fromWireError(wire: PluginErrorWire): KernelError {
  return new KernelError(wire.code, {
    retryable: wire.retryable,
    ...(wire.retryAfterMs === undefined ? {} : { retryAfterMs: wire.retryAfterMs }),
    ...(wire.details === undefined ? {} : { details: wire.details }),
  });
}

/**
 * Structural validation of an incoming wire error object. Unknown fields are
 * dropped, never trusted (rev4 §A2 "неизвестные поля игнорируются").
 */
export function parseWireError(value: unknown): PluginErrorWire | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['code'] !== 'string' || record['code'].length === 0) return null;
  const wire: PluginErrorWire = {
    code: record['code'],
    retryable: typeof record['retryable'] === 'boolean' ? record['retryable'] : false,
  };
  if (typeof record['retryAfterMs'] === 'number' && Number.isFinite(record['retryAfterMs'])) {
    wire.retryAfterMs = Math.max(0, Math.floor(record['retryAfterMs']));
  }
  if (
    typeof record['details'] === 'object' &&
    record['details'] !== null &&
    !Array.isArray(record['details'])
  ) {
    wire.details = record['details'] as Record<string, unknown>;
  }
  return wire;
}

function safeMessage(message: string): string {
  return message.length > 500 ? message.slice(0, 500) : message;
}
