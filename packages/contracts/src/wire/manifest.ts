/**
 * Wire contract manifest constants.
 *
 * `WIRE_SCHEMA_HASH` is the sha256 (lowercase hex) of the canonical contract
 * bundle emitted by `tools/contract-codegen/codegen.mjs`. This value must
 * equal `schemaHash` in `packages/contracts/generated/contract-manifest.json`;
 * `pnpm contracts:check` fails on drift.
 */
export const WIRE_SCHEMA_HASH = 'e52c0ec2b0743c653852e8301ae31400d90348fb64df2a56f52915b01b983908';
