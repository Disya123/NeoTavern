/**
 * Product wire contracts (Phase 0): DTO schemas, envelopes, wire-safe rules,
 * the error model and the operation registry. Importing this module registers
 * the wire formats with TypeBox as a side effect so `Value.Check` works for
 * `format: 'uuid'` / `format: 'rfc3339'` / `format: 'decimal-string'`.
 */
import { registerWireFormats } from './formats.js';

registerWireFormats();

export * from './formats.js';
export * from './rules.js';
export * from './errors.js';
export * from './envelope.js';
export * from './dto.js';
export * from './registry.js';
export * from './manifest.js';
