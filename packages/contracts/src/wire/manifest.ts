/**
 * Wire contract manifest constants.
 *
 * `WIRE_SCHEMA_HASH` is the sha256 (lowercase hex) of the canonical contract
 * bundle emitted by `tools/contract-codegen/codegen.mjs`. This value must
 * equal `schemaHash` in `packages/contracts/generated/contract-manifest.json`;
 * `pnpm contracts:check` fails on drift.
 */
export const WIRE_SCHEMA_HASH = '304304cf54ea6d1931a754d5e74fcfb4f0dbf3d4d7f1d346b401cb71aac2dc49';
