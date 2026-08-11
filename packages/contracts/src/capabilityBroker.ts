/**
 * Capability Broker wire contracts (ТЗ Plugin SDK vNext v3.2 §10–§12,
 * §26.2.1, §34, §41).
 *
 * Single source of truth for everything a plugin call carries when it crosses
 * the worker boundary on its way to the Capability Broker:
 *
 * - caller identity (pluginId / installationId / trust level, §10.1, §11);
 * - the capability request (name + scope, §12 catalog granularity);
 * - the operation being performed (method + args);
 * - a wall-clock deadline (§10.1 "deadline", §26.1.1);
 * - the causal call chain A→B→C used for service-cycle detection (§26.2.1);
 * - an optional idempotency key (§34) and the observed grant revision.
 *
 * The broker lives in Main Host (ADR-0027); the runtime side enforces the
 * same envelope so admission and in-flight abort decisions are protocol-level,
 * not per-implementation (§10, §15.1 single-serialization rule).
 */
import { Type, type Static } from '@sinclair/typebox';

/** Trust levels (ТЗ §11). The level never changes the runtime, only the set
 * of grants a call may rely on. */
export const BrokerTrustLevel = {
  SANDBOX: 'sandbox',
  EXTENDED: 'extended',
  TRUSTED: 'trusted',
} as const;
export type BrokerTrustLevelValue = (typeof BrokerTrustLevel)[keyof typeof BrokerTrustLevel];

export const BrokerTrustLevelSchema = Type.Union([
  Type.Literal(BrokerTrustLevel.SANDBOX),
  Type.Literal(BrokerTrustLevel.EXTENDED),
  Type.Literal(BrokerTrustLevel.TRUSTED),
]);

/** Who is calling (§10.1 identity block). */
export const BrokerCallerIdentitySchema = Type.Object(
  {
    pluginId: Type.String({ minLength: 1, maxLength: 160 }),
    installationId: Type.String({ minLength: 1, maxLength: 160 }),
    trustLevel: BrokerTrustLevelSchema,
  },
  { additionalProperties: false },
);
export type BrokerCallerIdentity = Static<typeof BrokerCallerIdentitySchema>;

/** Capability request: catalog name plus scope granularity (§12). */
export const BrokerCapabilitySchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    scope: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export type BrokerCapability = Static<typeof BrokerCapabilitySchema>;

/** Max hops in the causal call chain (§26.2.1). */
export const BROKER_MAX_CAUSAL_CHAIN = 16;

/** Default per-call deadline; callers may clamp to a lower value. */
export const BROKER_DEFAULT_DEADLINE_MS = 10_000;

/** Hard cap a caller can request; the broker never accepts more (§10.1). */
export const BROKER_MAX_DEADLINE_MS = 60_000;

/**
 * A broker call as posted by the worker bridge (Runtime ↔ Worker §16) and
 * forwarded host-ward over the RPC_REQUEST/RPC_RESPONSE frames (§15.2).
 * `causalChain` lists the pluginIds already on the call path (A→B→C); the
 * caller appends its own id, so a chain that already contains it is a
 * re-entrant cycle and fails fast with SERVICE_CALL_CYCLE (§26.2.1).
 */
export const BrokerCallRequestSchema = Type.Object(
  {
    requestId: Type.String({ minLength: 8, maxLength: 64 }),
    caller: BrokerCallerIdentitySchema,
    method: Type.String({ minLength: 1, maxLength: 256 }),
    args: Type.Optional(Type.Unknown()),
    capability: BrokerCapabilitySchema,
    /** Grant revision the caller observed; mismatch is a revoke race. */
    revision: Type.Optional(Type.Integer({ minimum: 0, maximum: 0xffffffff })),
    deadlineAt: Type.Integer({ minimum: 0, maximum: 0x7fffffffffff }),
    causalChain: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), {
      maxItems: BROKER_MAX_CAUSAL_CHAIN,
    }),
    idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export type BrokerCallRequest = Static<typeof BrokerCallRequestSchema>;

/** Host-side failure of one call (no stack, no plugin realm details). */
export const BrokerWireErrorSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 64 }),
    message: Type.String({ maxLength: 2000 }),
    retryable: Type.Boolean(),
    details: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export type BrokerWireError = Static<typeof BrokerWireErrorSchema>;

/** Reply to a broker call (Runtime ↔ Worker §16; host → runtime RPC_RESPONSE). */
export const BrokerCallResultSchema = Type.Object(
  {
    requestId: Type.String({ minLength: 8, maxLength: 64 }),
    ok: Type.Boolean(),
    result: Type.Optional(Type.Unknown()),
    error: Type.Optional(BrokerWireErrorSchema),
  },
  { additionalProperties: false },
);
export type BrokerCallResult = Static<typeof BrokerCallResultSchema>;

/**
 * Host → runtime revocation command (§10.2): new calls for the capability are
 * rejected and in-flight ones are aborted. `revision` is the grant revision
 * the host observed at revoke time; `name` is the catalog capability name.
 */
export const BrokerRevokeCommandSchema = Type.Object(
  {
    kind: Type.Literal('broker-revoke'),
    pluginId: Type.String({ minLength: 1, maxLength: 160 }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    revision: Type.Optional(Type.Integer({ minimum: 0, maximum: 0xffffffff })),
    reason: Type.Optional(Type.String({ maxLength: 256 })),
  },
  { additionalProperties: false },
);
export type BrokerRevokeCommand = Static<typeof BrokerRevokeCommandSchema>;
