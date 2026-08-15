/**
 * Validation benchmarks (plan rev 2.2 Layer B): measure how many ms and
 * how much memory TypeBox eats on boundary payloads.
 *
 * MEMORY-SAFETY MODEL (hard, enforced):
 * - Every heavy suite runs in its OWN `node --expose-gc` child
 *   (`_bench-child.mjs`); the payload is built INSIDE the child from a
 *   small spec — nothing heavy crosses IPC, and after `exit` the OS
 *   returns ALL memory (including native allocations).
 * - The parent checks the SPEC with `assertPayloadSpecCap` BEFORE spawning
 *   (guard never allocates proportional to what it guards) and the child
 *   re-checks it as defense in depth.
 * - Hard limits (bytes, batch, wall clock) fail the test; timings/heap
 *   deltas are diagnostic metrics with deliberately loose regression
 *   bounds (orders of magnitude above observed medians).
 *
 * Requires `pnpm --filter @neotavern/contracts build` (the child imports
 * the built package).
 */
import { describe, expect, it } from 'vitest';
import {
  assertPayloadSpecCap,
  boundedIterations,
  runHeavyChild,
  type ChildResult,
} from './_budget.js';

const CHILD = new URL('./_bench-child.mjs', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const requestLimit = 1024 * 1024; // registry requestLimitBytes
const networkLimit = 8 * 1024 * 1024; // NETWORK_MAX_BODY_BYTES

interface BenchRow {
  label: string;
  schemaId: string;
  bytes: number;
  iterations: number;
  msPerOp: number;
  heapDeltaPerOp: number;
  rssDeltaPerOp: number;
  checked: boolean;
}

const rows: BenchRow[] = [];

function specJson(spec: Record<string, unknown>): string {
  return JSON.stringify(spec);
}

async function runCase(
  label: string,
  spec: {
    case: string;
    schemaId: string;
    bytes: number;
    iterations: number;
    depth?: number;
    arrayItems?: number;
    objectKeys?: number;
  },
): Promise<ChildResult> {
  // Hard check on the SPEC before any spawn (guard never allocates the payload).
  assertPayloadSpecCap({
    bytes: spec.bytes,
    depth: spec.depth,
    arrayItems: spec.arrayItems,
    objectKeys: spec.objectKeys,
    iterations: spec.iterations,
  });
  const result = await runHeavyChild(CHILD, specJson(spec));
  if (result.ok) {
    rows.push({
      label,
      schemaId: spec.schemaId,
      bytes: spec.bytes,
      iterations: spec.iterations,
      ...result.metrics,
    });
  }
  return result;
}

describe('wire validation benchmarks (boundary payloads)', () => {
  it('1 MiB request body passes in linear time (loose bound)', async () => {
    const result = await runCase('request@1MiB', {
      case: 'request',
      schemaId: 'wire.request.start-generation',
      bytes: requestLimit - 4096,
      iterations: boundedIterations(requestLimit, 30),
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.metrics.verdict).toBe(true);
    expect(
      result.metrics.msPerOp,
      `1 MiB request check took ${result.metrics.msPerOp.toFixed(1)} ms/op`,
    ).toBeLessThan(3000);
  });

  it('8 MiB over-limit message is rejected in linear time (loose bound)', async () => {
    const result = await runCase('over-limit@8MiB (reject)', {
      case: 'reject',
      schemaId: 'wire.request.start-generation',
      bytes: networkLimit,
      iterations: boundedIterations(networkLimit, 4),
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.metrics.verdict).toBe(false);
    expect(
      result.metrics.msPerOp,
      `8 MiB rejection took ${result.metrics.msPerOp.toFixed(1)} ms/op`,
    ).toBeLessThan(15_000);
    expect(
      result.metrics.heapDeltaPerOp,
      `8 MiB rejection allocated ${result.metrics.heapDeltaPerOp.toFixed(0)} B/op`,
    ).toBeLessThan(64 * 1024 * 1024);
  });

  it('1 MiB field at the response ceiling validates in linear time', async () => {
    const result = await runCase('paged-field@1MiB', {
      case: 'page',
      schemaId: 'wire.paged.messages',
      bytes: requestLimit - 1024,
      iterations: boundedIterations(requestLimit, 30),
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.metrics.verdict).toBe(true);
    expect(
      result.metrics.msPerOp,
      `1 MiB field check took ${result.metrics.msPerOp.toFixed(1)} ms/op`,
    ).toBeLessThan(3000);
  });

  it('parser killers check without runaway time or allocation', async () => {
    const cases = [
      {
        label: 'deep-1000-object',
        spec: { case: 'deep', schemaId: 'wire.meta.dto', bytes: 4096, depth: 1000, iterations: 30 },
      },
      {
        label: 'nulls-100k',
        spec: {
          case: 'nulls',
          schemaId: 'wire.paged.messages',
          bytes: 300_000,
          arrayItems: 100_000,
          iterations: 10,
        },
      },
      {
        label: 'wide-50k-keys',
        spec: {
          case: 'wide',
          schemaId: 'wire.meta.dto',
          bytes: 500_000,
          objectKeys: 50_000,
          iterations: 10,
        },
      },
    ] as const;
    for (const c of cases) {
      const result = await runCase(c.label, c.spec);
      if (!result.ok) throw new Error(`${c.label}: ${result.error}`);
      expect(
        result.metrics.msPerOp,
        `${c.label} took ${result.metrics.msPerOp.toFixed(1)} ms/op`,
      ).toBeLessThan(5000);
    }
  });

  it('prints the diagnostic metrics table (no assertion)', () => {
    console.table(
      rows.map((r) => ({
        payload: r.label,
        schema: r.schemaId,
        bytes: r.bytes,
        'ms/op': r.msPerOp.toFixed(3),
        'heap B/op': r.heapDeltaPerOp.toFixed(0),
        'rss B/op': r.rssDeltaPerOp.toFixed(0),
        checked: r.checked,
      })),
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
