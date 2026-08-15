/**
 * Shared memory-safety budget for heavy wire-contract tests (ТЗ §16/§18.2,
 * plan rev 2.2 Layer B).
 *
 * CONTRACT (hard, enforced here):
 * - The guard runs on a SPEC (declared byte counts), NEVER on a materialized
 *   payload — it must not allocate proportional to the thing it guards
 *   (no `JSON.stringify(payload)` sizing, ever).
 * - `assertPayloadSpecCap` throws BEFORE any `.repeat()` / `Array.from()`
 *   inside `build()`, so a future edit that grows a payload fails fast
 *   instead of exhausting the heap.
 * - Hard limits fail CI; diagnostic metrics (heap/RSS deltas, ms/op) are
 *   reported but are NOT safety contracts.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';

/** Never validate a payload larger than this (transport/wire ceiling). */
export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
/** Total payload bytes processed by one batch. */
export const MAX_BATCH_BYTES = 64 * 1024 * 1024;
/** Per-suite wall-clock budget for a heavy child (seconds). */
export const MAX_CHILD_WALL_SECONDS = 120;
/** Maximum nesting depth a test builder may declare. */
export const MAX_DEPTH = 1024;
/** Maximum array cardinality a test builder may declare. */
export const MAX_ARRAY_ITEMS = 200_000;
/** Maximum object cardinality a test builder may declare. */
export const MAX_OBJECT_KEYS = 100_000;

/** Hard budget that every heavy suite must satisfy (CI gate inputs). */
export interface BudgetSpec {
  readonly bytes: number;
  readonly depth?: number;
  readonly arrayItems?: number;
  readonly objectKeys?: number;
  readonly iterations: number;
}

/** Throws BEFORE any allocation when the spec violates a hard cap. */
export function assertPayloadSpecCap(spec: BudgetSpec): void {
  if (spec.bytes > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `payload spec is ${spec.bytes} B, exceeding the ${MAX_PAYLOAD_BYTES} B cap; refusing to build`,
    );
  }
  if ((spec.depth ?? 0) > MAX_DEPTH) {
    throw new Error(`payload depth ${spec.depth} exceeds the ${MAX_DEPTH} cap`);
  }
  if ((spec.arrayItems ?? 0) > MAX_ARRAY_ITEMS) {
    throw new Error(`array cardinality ${spec.arrayItems} exceeds the ${MAX_ARRAY_ITEMS} cap`);
  }
  if ((spec.objectKeys ?? 0) > MAX_OBJECT_KEYS) {
    throw new Error(`object cardinality ${spec.objectKeys} exceeds the ${MAX_OBJECT_KEYS} cap`);
  }
  const batchBytes = spec.bytes * spec.iterations;
  if (batchBytes > MAX_BATCH_BYTES) {
    throw new Error(
      `batch ${spec.bytes} B × ${spec.iterations} = ${batchBytes} B exceeds the ` +
        `${MAX_BATCH_BYTES} B budget; reduce iterations`,
    );
  }
}

/** Iterations capped by the batch budget (derive, never hard-code blindly). */
export function boundedIterations(specBytes: number, requested: number): number {
  const byBudget = Math.max(1, Math.floor(MAX_BATCH_BYTES / Math.max(specBytes, 1)));
  return Math.max(1, Math.min(requested, byBudget));
}

// ---------------------------------------------------------------------------
// Heavy-suite child-process runner (plan rev 2.2 §2.2): each heavy suite runs
// in its OWN node --expose-gc child. The parent sends ONLY a small spec over
// argv; the child builds the payload inside itself and exits. After exit the
// OS returns ALL memory (including native allocations JS GC cannot control).
// ---------------------------------------------------------------------------

export interface ChildMetrics {
  msPerOp: number;
  heapDeltaPerOp: number;
  rssDeltaPerOp: number;
  verdict: boolean;
}

/** Result of a heavy child run: metrics on success, or a hard failure. */
export type ChildResult = { ok: true; metrics: ChildMetrics } | { ok: false; error: string };

function parseChildMetrics(stdout: string): ChildMetrics {
  const lines = stdout.trim().split('\n');
  const last = lines[lines.length - 1] ?? '';
  const parsed = JSON.parse(last) as ChildMetrics;
  if (typeof parsed.msPerOp !== 'number' || typeof parsed.verdict !== 'boolean') {
    throw new Error(`child did not emit metrics JSON: ${stdout.slice(0, 200)}`);
  }
  return parsed;
}

/**
 * Spawns `childScript` as `node --expose-gc <childScript> <specJson>` with a
 * hard wall-clock deadline and a bounded stderr/stdout ring (last ~2 MiB).
 * Never buffers the child's output without a bound. The child payload is
 * built INSIDE the child — nothing heavy crosses the IPC boundary.
 */
export function runHeavyChild(
  childScript: string,
  specJson: string,
  deadlineMs = MAX_CHILD_WALL_SECONDS * 1000,
): Promise<ChildResult> {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ['--max-old-space-size=2048', '--expose-gc', childScript, specJson],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  let stdout = '';
  let stderr = '';
  const RING = 2 * 1024 * 1024; // bounded diagnostic ring buffer
  const appendBounded = (buf: string, chunk: Buffer): string => {
    buf += chunk.toString('utf8');
    return buf.length > RING ? buf.slice(buf.length - RING) : buf;
  };
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk);
  });

  const deadline = setTimeout(() => {
    // Wall-clock deadline is the runner's own timer (plan §1.1); the OS
    // reaps the child's memory when it dies.
    child.kill('SIGKILL');
  }, deadlineMs);

  return new Promise((resolve) => {
    child.on('error', (err) => {
      clearTimeout(deadline);
      resolve({ ok: false, error: `cannot spawn child: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(deadline);
      if (code !== 0) {
        resolve({
          ok: false,
          error: `child exited ${code}; stderr tail: ${stderr.slice(-400)}`,
        });
        return;
      }
      try {
        resolve({ ok: true, metrics: parseChildMetrics(stdout) });
      } catch (err) {
        resolve({ ok: false, error: (err as Error).message });
      }
    });
  });
}
