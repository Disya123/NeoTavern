/**
 * Wire contract manifest constants.
 *
 * `WIRE_SCHEMA_HASH` is the sha256 (lowercase hex) of the canonical contract
 * bundle emitted by `tools/contract-codegen/codegen.mjs`. This value must
 * equal `schemaHash` in `packages/contracts/generated/contract-manifest.json`;
 * `pnpm contracts:check` fails on drift.
 */
export const WIRE_SCHEMA_HASH = '06c4c0465471c9a95433850f84b1d09ac03db4dedd619133b397e37ae36e065b';
