/**
 * Wire contract manifest constants.
 *
 * `WIRE_SCHEMA_HASH` is the sha256 (lowercase hex) of the canonical contract
 * bundle emitted by `tools/contract-codegen/codegen.mjs`. This value must
 * equal `schemaHash` in `packages/contracts/generated/contract-manifest.json`;
 * `pnpm contracts:check` fails on drift.
 */
export const WIRE_SCHEMA_HASH = '5e272e1823a5f344f1d45567a0f07bb90f62b6c09088762f937712a13735ad45';
