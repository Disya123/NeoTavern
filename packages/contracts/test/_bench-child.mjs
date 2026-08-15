#!/usr/bin/env node
/**
 * Heavy-bench child (plan rev 2.2 §2.2): run `node --expose-gc
 * _bench-child.mjs '<specJson>'`. The payload is built INSIDE this child
 * from the small spec; nothing heavy crosses IPC. Prints one metrics-JSON
 * line on stdout. Exits non-zero on any hard-budget violation.
 *
 * Requires the built package: `pnpm --filter @neotavern/contracts build`
 * (imports resolve to dist). The parent bench test spawns this file.
 */
import { WIRE_SCHEMAS } from '@neotavern/contracts';
import { Value } from '@sinclair/typebox/value';

const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const CHAT_ID = '00000000-0000-4000-8000-000000000001';
const RUN_ID = '00000000-0000-4000-8000-000000000021';

function fail(message) {
  process.stderr.write(`budget violation: ${message}\n`);
  process.exit(2);
}

function buildPayload(spec) {
  switch (spec.case) {
    case 'request':
      return { chatId: CHAT_ID, message: 'x'.repeat(spec.bytes) };
    case 'reject':
      // Over-limit message: must be REJECTED (verdict false) in linear time.
      return { chatId: CHAT_ID, message: 'x'.repeat(spec.bytes) };
    case 'page':
      return {
        items: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            chatId: CHAT_ID,
            role: 'user',
            content: 'x'.repeat(spec.bytes),
            sequence: 1,
            generationRunId: RUN_ID,
            createdAt: '2026-08-13T00:00:00Z',
            meta: {},
          },
        ],
      };
    case 'deep': {
      let v = 'x';
      for (let i = 0; i < spec.depth; i += 1) v = { a: v };
      return v;
    }
    case 'nulls':
      return new Array(spec.arrayItems).fill(null);
    case 'wide': {
      const o = {};
      for (let i = 0; i < spec.objectKeys; i += 1) o[`k${i}`] = i;
      return o;
    }
    default:
      fail(`unknown case ${spec.case}`);
      return null;
  }
}

const spec = JSON.parse(process.argv[2]);
if (typeof spec.bytes !== 'number' || typeof spec.iterations !== 'number') {
  fail('spec must carry numeric bytes and iterations');
}
if (spec.bytes > MAX_PAYLOAD_BYTES) {
  fail(`payload ${spec.bytes} B exceeds ${MAX_PAYLOAD_BYTES} B cap`);
}
if (spec.bytes * spec.iterations > MAX_BATCH_BYTES) {
  fail(`batch ${spec.bytes} B x ${spec.iterations} exceeds ${MAX_BATCH_BYTES} B budget`);
}
if ((spec.depth ?? 0) > 1024) fail(`depth ${spec.depth} exceeds 1024`);
if ((spec.arrayItems ?? 0) > 200_000) fail(`arrayItems ${spec.arrayItems} exceeds 200000`);
if ((spec.objectKeys ?? 0) > 100_000) fail(`objectKeys ${spec.objectKeys} exceeds 100000`);

const schema = WIRE_SCHEMAS[spec.schemaId];
if (!schema) fail(`unknown schemaId ${spec.schemaId}`);

const payload = buildPayload(spec);

// Tiny warmup (JIT + lazy format registration).
for (let i = 0; i < 3; i += 1) Value.Check(schema, payload);
const heapBefore = process.memoryUsage().heapUsed;
const rssBefore = process.memoryUsage().rss;
const start = performance.now();
let verdict = true;
for (let i = 0; i < spec.iterations; i += 1) {
  verdict = Value.Check(schema, payload) && verdict;
}
const elapsed = performance.now() - start;
const heapAfter = process.memoryUsage().heapUsed;
const rssAfter = process.memoryUsage().rss;

process.stdout.write(
  JSON.stringify({
    msPerOp: elapsed / spec.iterations,
    heapDeltaPerOp: Math.max(0, (heapAfter - heapBefore) / spec.iterations),
    rssDeltaPerOp: Math.max(0, (rssAfter - rssBefore) / spec.iterations),
    verdict,
  }) + '\n',
);
