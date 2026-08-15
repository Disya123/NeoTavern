/**
 * Plan rev 2.2 Layer D — structural budget guards. NOT grep-on-docs: these
 * tests parse the actual artifacts (package.json, vitest configs, the shared
 * `_budget.ts` module) and assert the containment invariants:
 * - heavy suites must use the spec-first budget helper;
 * - the helper itself must reject over-budget SPECS before any allocation;
 * - vitest must run with bounded workers and a bounded Node heap.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_ARRAY_ITEMS,
  MAX_BATCH_BYTES,
  MAX_DEPTH,
  MAX_OBJECT_KEYS,
  MAX_PAYLOAD_BYTES,
  assertPayloadSpecCap,
  boundedIterations,
} from './_budget.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');

describe('budget helper: spec-first guard never allocates the payload', () => {
  it('accepts a spec at the cap boundary', () => {
    expect(() => assertPayloadSpecCap({ bytes: MAX_PAYLOAD_BYTES, iterations: 1 })).not.toThrow();
  });

  it('rejects an over-limit payload spec BEFORE any build', () => {
    expect(() => assertPayloadSpecCap({ bytes: MAX_PAYLOAD_BYTES + 1, iterations: 1 })).toThrow(
      /exceeding the .* cap/,
    );
  });

  it('rejects over-budget batches by total bytes', () => {
    expect(() => assertPayloadSpecCap({ bytes: 1024 * 1024, iterations: 1000 })).toThrow(/batch/);
    expect(MAX_BATCH_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it('rejects insane cardinality specs before allocation', () => {
    expect(() =>
      assertPayloadSpecCap({ bytes: 1024, arrayItems: MAX_ARRAY_ITEMS + 1, iterations: 1 }),
    ).toThrow(/array cardinality/);
    expect(() =>
      assertPayloadSpecCap({ bytes: 1024, objectKeys: MAX_OBJECT_KEYS + 1, iterations: 1 }),
    ).toThrow(/object cardinality/);
    expect(() =>
      assertPayloadSpecCap({ bytes: 1024, depth: MAX_DEPTH + 1, iterations: 1 }),
    ).toThrow(/depth/);
  });

  it('boundedIterations never exceeds the batch budget', () => {
    for (const bytes of [1, 1024, 1024 * 1024, MAX_PAYLOAD_BYTES]) {
      const iters = boundedIterations(bytes, 10_000);
      expect(iters * bytes).toBeLessThanOrEqual(MAX_BATCH_BYTES);
      expect(iters).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('heavy suites use the shared budget helper', () => {
  const bench = readFileSync(resolve(ROOT, 'packages/contracts/test/bench.test.ts'), 'utf8');
  const fuzz = readFileSync(resolve(ROOT, 'packages/contracts/test/fuzz.test.ts'), 'utf8');

  it('bench.test.ts drives payloads through a spec (no inline unbounded builders)', () => {
    expect(bench).toMatch(/assertPayloadSpecCap/);
    expect(bench).toMatch(/runHeavyChild/);
    // The dangerous pattern is gone: no bare repeat() sized without a spec.
    expect(bench).not.toMatch(/\.repeat\(\s*16 \* 1024 \* 1024/);
    expect(bench).not.toMatch(/warmup: 50/);
  });

  it('fuzz.test.ts pathological payloads carry spec caps', () => {
    expect(fuzz).toMatch(/assertPayloadSpecCap/);
    expect(fuzz).not.toMatch(/new Array\(100_000\)\.fill\(null\)\]\)/); // unguarded builder form
  });
});

describe('vitest containment configuration', () => {
  const rootVitest = readFileSync(resolve(ROOT, 'vitest.config.ts'), 'utf8');
  const webVitest = readFileSync(resolve(ROOT, 'apps/web/vitest.config.ts'), 'utf8');

  it('root vitest bounds workers and the Node heap', () => {
    expect(rootVitest).toMatch(/maxWorkers: 2/);
    expect(rootVitest).toMatch(/execArgv: \['--max-old-space-size=2048'\]/);
  });

  it('apps/web vitest bounds workers and the Node heap', () => {
    expect(webVitest).toMatch(/maxWorkers: 2/);
    expect(webVitest).toMatch(/execArgv: \['--max-old-space-size=2048'\]/);
  });

  it('playwright keeps a single worker (no parallel heap multiplication)', () => {
    const playwright = readFileSync(resolve(ROOT, 'playwright.config.ts'), 'utf8');
    expect(playwright).toMatch(/workers: 1/);
    expect(playwright).toMatch(/fullyParallel: false/);
  });
});

describe('package.json structural invariants', () => {
  const rootPkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const contractsPkg = JSON.parse(
    readFileSync(resolve(ROOT, 'packages/contracts/package.json'), 'utf8'),
  ) as { devDependencies?: Record<string, string>; scripts?: Record<string, string> };

  it('fast-check is a pinned devDependency of contracts', () => {
    expect(contractsPkg.devDependencies?.['fast-check']).toMatch(/^4\.9\.0$/);
  });

  it('heavy suites are wired through the contained runner', () => {
    const scripts = rootPkg.scripts as Record<string, string>;
    expect(scripts['contained:run']).toMatch(/contained-run\.mjs/);
    expect(scripts['test:contracts:heavy']).toMatch(/contained-run\.mjs/);
    expect(scripts['test:rust-fuzz:contained']).toMatch(/contained-run\.mjs/);
  });
});
