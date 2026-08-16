/**
 * check-kernel-dispatch — ARC-01/ARC-07 parity gate.
 *
 * Every Product Wire operation registered in `packages/contracts/src/wire/registry.ts`
 * must have a Rust Kernel dispatch arm in `crates/runtime-kernel/src/lib.rs`:
 * either a unary arm of the main `match op` block or the streaming path
 * (`dispatch_stream` special-cases `generation.start` / `generation.retry`).
 *
 * A registered operation with no dispatch arm means the kernel would answer
 * `OperationNotFound` to a valid contract — a contract/code split that CI
 * must catch. An arm with no registered operation is dead surface that would
 * silently diverge from the registry.
 *
 * Usage: `node scripts/check-kernel-dispatch.mjs` (exit 0 = parity).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'packages', 'contracts', 'src', 'wire', 'registry.ts');
const KERNEL = join(ROOT, 'crates', 'runtime-kernel', 'src', 'lib.rs');

/** Operation ids registered via `op('…', …)` in the wire registry. */
function registryOps(source) {
  const ids = [...source.matchAll(/\bop\(\s*['"]([a-z0-9.]+)['"]/g)].map((match) => match[1]);
  return [...new Set(ids)].sort();
}

/**
 * Kernel dispatch arms: top-level unary arms of the main `match op` block
 * (8-space indent, `"id" =>`) plus the streaming special-case list from
 * `dispatch_stream`'s `matches!(operation_id, …)` plus the dedicated
 * offline commands routed in `Kernel::dispatch` itself
 * (`if operation_id == "backups.restore"`, М5 slice 39 — restore closes and
 * re-opens the database, so it cannot go through the unary `with_db_opt`
 * path).
 */
function kernelDispatchOps(source) {
  const unary = [...source.matchAll(/^ {8}"([a-z0-9.]+)"\s*=>/gm)].map((match) => match[1]);
  const stream = [
    ...source.matchAll(
      /matches!\(\s*operation_id\s*,\s*"([a-z0-9.]+)"(?:\s*\|\s*"([a-z0-9.]+)")?/g,
    ),
  ].flatMap((match) => [match[1], match[2]].filter((id) => typeof id === 'string'));
  const dedicated = [
    ...source.matchAll(/if operation_id == "([a-z0-9.]+)"/g),
  ].map((match) => match[1]);
  return [...new Set([...unary, ...stream, ...dedicated])].sort();
}

const registry = registryOps(readFileSync(REGISTRY, 'utf8'));
const dispatch = kernelDispatchOps(readFileSync(KERNEL, 'utf8'));

const missing = registry.filter((op) => !dispatch.includes(op));
const unexpected = dispatch.filter((op) => !registry.includes(op));

if (missing.length > 0 || unexpected.length > 0) {
  console.error('[kernel-dispatch] FAIL: registry and kernel dispatch disagree.');
  if (missing.length > 0) {
    console.error(`  registered without a kernel dispatch arm: ${missing.join(', ')}`);
  }
  if (unexpected.length > 0) {
    console.error(`  dispatch arm without a registered operation: ${unexpected.join(', ')}`);
  }
  process.exit(1);
}
console.log(
  `[kernel-dispatch] OK — all ${registry.length} wire operations have a kernel dispatch arm.`,
);
