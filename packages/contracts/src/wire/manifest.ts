/**
 * Wire contract manifest constants.
 *
 * `WIRE_SCHEMA_HASH` is the sha256 (lowercase hex) of the canonical contract
 * bundle emitted by `tools/contract-codegen/codegen.mjs`. This value must
 * equal `schemaHash` in `packages/contracts/generated/contract-manifest.json`;
 * `pnpm contracts:check` fails on drift.
 */
export const WIRE_SCHEMA_HASH = 'ae9bd5c77dece74989119c39c2e00c7ea0034e41fc7fdb56e069ec65956b153a';
