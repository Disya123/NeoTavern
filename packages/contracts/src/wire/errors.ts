/**
 * Wire error model: canonical error codes, the `ContractViolation` error
 * body, `ContractCompileError` (raised by `compileWireContract`) and the
 * `ProductErrorDto` schema that carries error details on the wire.
 */
import { Type, type Static } from '@sinclair/typebox';
import type { WireViolation } from './rules.js';

/** Canonical wire error codes (see the operation registry `allowedErrorCodes`). */
export const WIRE_ERROR_CODES = [
  'INTERNAL',
  'VALIDATION',
  'CONTRACT_VIOLATION',
  'NOT_FOUND',
  'CONFLICT',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'OUTCOME_UNKNOWN',
  'DATA_ROOT_IN_USE',
  'UNSUPPORTED_SCHEMA',
  'RECOVERY_REQUIRED',
  'CANCELLED',
  'PROVIDER_ERROR',
  'QUOTA_EXCEEDED',
  'CAPABILITY_UNAVAILABLE',
] as const;

/** Union of canonical wire error codes. */
export type WireErrorCode = (typeof WIRE_ERROR_CODES)[number];

/**
 * Product error DTO (`wire.error.dto`) carried inside the error response
 * envelope. `params` is tolerant by design so backends can attach arbitrary
 * machine-readable detail; `code` must be one of the canonical codes.
 */
export const ProductErrorDtoSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 64 }),
    params: Type.Object({}, { additionalProperties: true }),
    traceId: Type.Optional(Type.String()),
    correlationId: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { $id: 'wire.error.dto', additionalProperties: false },
);
export type ProductErrorDto = Static<typeof ProductErrorDtoSchema>;

/**
 * Runtime contract violation returned in an error envelope: the receiving
 * side detected that a payload deviated from the compiled wire contract.
 */
export interface ContractViolation {
  code: 'contract_violation';
  /** Operation that produced the violation, when known. */
  operationId?: string;
  direction: 'request' | 'response' | 'event';
  contractMajor: number;
  correlationId: string;
  issues: Array<{ path: string; rule: string }>;
}

/** One group of violations (all from a single schema or operation) aggregated by `ContractCompileError`. */
export interface ContractViolationGroup {
  /** Human-readable context for the group, e.g. `schema 'wire.meta.dto' is not wire-safe`. */
  message: string;
  violations: WireViolation[];
}

/**
 * Thrown by `compileWireContract` when the wire contract fails to compile.
 * Aggregates every violation across all schemas, operations and fixtures so
 * callers see the full problem set in one error.
 */
export class ContractCompileError extends Error {
  /** All violation groups found during compilation. */
  readonly violations: ContractViolationGroup[];

  constructor(violations: ContractViolationGroup[]) {
    const detail = violations
      .map((group) => {
        const count = group.violations.length;
        return `${group.message} (${count} violation${count === 1 ? '' : 's'})`;
      })
      .join('; ');
    super(`contract compile failed: ${detail}`);
    this.name = 'ContractCompileError';
    this.violations = violations;
  }
}
