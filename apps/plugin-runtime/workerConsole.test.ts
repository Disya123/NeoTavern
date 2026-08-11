/**
 * Worker e2e tests for the BoundedConsoleSink (ТЗ v3.2 §9.1.1–§9.1.4).
 *
 * Runs a real Worker + SES lockdown + Compartment and drives plugin console
 * output through the full sink: batched LOG_BATCH payloads (worker-encoded,
 * bounded), drop accounting under flood, the reserved fatal-diagnostic path,
 * and the terminate flush. Real wall-clock polling is inherent here: the
 * sink flushes on its own 100 ms interval inside the worker thread, which
 * fake timers in the test process cannot drive.
 */
import { describe, expect, it } from 'vitest';
import type { PluginRuntimeLogBatchPayload } from '@neotavern/contracts';
import { WorkerSupervisor, type WorkerReadyInfo } from './src/supervisor.js';
import { buildModuleGraph } from './src/graph/moduleGraphBuilder.js';

interface CapturedBatch {
  seq: number;
  droppedCount: number;
  payload: PluginRuntimeLogBatchPayload;
}

interface ConsoleWorkerContext {
  record: ReturnType<WorkerSupervisor['spawnWorker']>;
  ready: WorkerReadyInfo;
  batches: CapturedBatch[];
  fatalDiagnostics: Array<{
    workerId: number;
    workerEpoch: number;
    kind: string;
    name: string;
    message: string;
  }>;
}

/** Poll a condition; real-time waits are inherent (cross-thread delivery). */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}

/**
 * Spawn a real worker, load a plugin source file, and capture every
 * `log-batch` / `fatal-diagnostic` bridge message the sink emits. Resolves
 * once the module graph reports loaded OR a fatal diagnostic arrives (a
 * dying worker may never report its load).
 */
async function withConsoleWorker(
  source: string,
  options: { workerId?: number } = {},
  run: (context: ConsoleWorkerContext) => Promise<unknown>,
): Promise<unknown> {
  const built = buildModuleGraph({
    pluginId: 'test.console',
    entry: 'src/index.js',
    files: new Map([['src/index.js', source]]),
  });
  const batches: CapturedBatch[] = [];
  const fatalDiagnostics: ConsoleWorkerContext['fatalDiagnostics'] = [];

  const readyGate = Promise.withResolvers<WorkerReadyInfo>();
  const supervisor = new WorkerSupervisor(
    { onWorkerReady: (info: WorkerReadyInfo) => readyGate.resolve(info) },
    {
      onBridgeMessage: (_record, message: unknown) => {
        if (message === null || typeof message !== 'object' || !('kind' in message)) return;
        if (message.kind === 'log-batch') {
          const batch = message as {
            seq: number;
            droppedCount: number;
            payloadBytes: Uint8Array;
          };
          const payload = JSON.parse(
            new TextDecoder().decode(batch.payloadBytes),
          ) as PluginRuntimeLogBatchPayload;
          batches.push({ seq: batch.seq, droppedCount: batch.droppedCount, payload });
          return;
        }
        if (message.kind === 'fatal-diagnostic') {
          const fatal = message as {
            workerId: number;
            workerEpoch: number;
            envelope: { kind: string; name: string; message: string };
          };
          fatalDiagnostics.push({
            workerId: fatal.workerId,
            workerEpoch: fatal.workerEpoch,
            kind: fatal.envelope.kind,
            name: fatal.envelope.name,
            message: fatal.envelope.message,
          });
        }
      },
    },
  );

  const record = supervisor.spawnWorker({
    workerId: options.workerId ?? 31,
    pluginId: 'test.console',
    installationId: 'inst-console',
  });
  const ready = await readyGate.promise;

  const settled = Promise.withResolvers<void>();
  record.control.on('message', (message: unknown) => {
    if (message === null || typeof message !== 'object' || !('kind' in message)) return;
    if (
      message.kind === 'module-graph-loaded' ||
      message.kind === 'module-graph-error' ||
      message.kind === 'fatal-diagnostic'
    ) {
      settled.resolve();
    }
  });
  record.control.postMessage({ kind: 'load-module-graph', graph: built.graph });

  try {
    await settled.promise;
    // Let trailing flush/fatal messages settle before the assertions.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    return await run({ record, ready, batches, fatalDiagnostics });
  } finally {
    await supervisor.terminateAll();
  }
}

describe('worker console sink (§9.1.1)', () => {
  it(
    'batches plugin console records into bounded LOG_BATCH payloads',
    { timeout: 30000 },
    async () => {
      await withConsoleWorker(
        [
          "console.log('hello', { a: 1 });",
          "console.error('boom', new TypeError('explode'));",
          'export const marker = 1;',
        ].join('\n'),
        {},
        async (context) => {
          await waitFor(() => context.batches.length > 0, 5000);
          expect(context.batches.length).toBeGreaterThan(0);
          const first = context.batches[0];
          expect(first.seq).toBe(0);
          expect(first.droppedCount).toBe(0);
          const messages = first.payload.records.map((r) => `${r.level}:${r.message}`);
          expect(messages.some((m) => m.startsWith('log:hello Object {a: 1}'))).toBe(true);
          expect(messages.some((m) => m.includes('TypeError: explode'))).toBe(true);
          return undefined;
        },
      );
    },
  );

  it(
    'flushes pending records on terminate (best-effort final batch)',
    { timeout: 30000 },
    async () => {
      // Small records: below the 4 KiB immediate-flush threshold, so they
      // sit in the ring until the interval flush or the terminate flush.
      await withConsoleWorker(
        ["console.log('final-a');", "console.log('final-b');", 'export const marker = 1;'].join(
          '\n',
        ),
        {},
        async (context) => {
          // Terminate while the ring still holds the records (force flush
          // must not wait for interval or credit).
          context.record.control.postMessage({ kind: 'terminate' });
          await waitFor(() => context.batches.length > 0, 5000);
          const messages = context.batches.flatMap((b) => b.payload.records.map((r) => r.message));
          expect(messages).toContain('final-a');
          expect(messages).toContain('final-b');
          return undefined;
        },
      );
    },
  );

  it(
    'drops records past the ring budget with droppedCount accounting (flood)',
    { timeout: 30000 },
    async () => {
      // ~600 bytes per record → 64 KiB ring holds ~100; 4000 records flood
      // the rest into the drop counter.
      await withConsoleWorker(
        [
          `for (let i = 0; i < 4000; i++) console.log('record-' + i + ' ' + 'x'.repeat(900));`,
          'export const marker = 1;',
        ].join('\n'),
        {},
        async (context) => {
          let delivered = 0;
          let sawDrops = false;
          let lastBatchAt = Date.now();
          const deadline = Date.now() + 8000;
          while (Date.now() < deadline) {
            while (context.batches.length > 0) {
              const batch = context.batches.shift()!;
              expect(batch.payload.records.length).toBeLessThanOrEqual(256);
              for (const record of batch.payload.records) {
                expect(record.message.length).toBeLessThanOrEqual(4000);
              }
              delivered += batch.payload.records.length;
              if (batch.droppedCount > 0) sawDrops = true;
              lastBatchAt = Date.now();
              // §9.1.1 rules 7/8: consume the batch and replenish credit.
              context.record.control.postMessage({ kind: 'log-batch-ack', seq: batch.seq });
            }
            if (sawDrops && Date.now() - lastBatchAt > 500) break;
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
          }
          expect(sawDrops).toBe(true);
          // The ring is the only buffer: everything beyond it was dropped
          // and accounted, and every delivered record stays within bounds.
          expect(delivered).toBeGreaterThan(0);
          expect(delivered).toBeLessThan(4000);
          return undefined;
        },
      );
    },
  );

  it(
    'reports thrown errors from async handlers through the reserved fatal path (§9.1.4)',
    { timeout: 30000 },
    async () => {
      // A throw inside a promise chain surfaces as an unhandled rejection
      // (Node semantics); the deterministic policy reports it through the
      // bounded fatal envelope with the original error's name/message.
      await withConsoleWorker(
        [
          "Promise.resolve().then(() => { throw new TypeError('worker-crash'); });",
          'export const marker = 1;',
        ].join('\n'),
        {},
        async (context) => {
          await waitFor(() => context.fatalDiagnostics.length > 0, 5000);
          expect(context.fatalDiagnostics.length).toBeGreaterThan(0);
          const fatal = context.fatalDiagnostics[0];
          expect(fatal.kind).toBe('unhandled-rejection');
          expect(fatal.name).toBe('TypeError');
          expect(fatal.message).toBe('worker-crash');
          expect(fatal.workerId).toBe(context.ready.workerId);
          return undefined;
        },
      );
    },
  );

  it(
    'reports unhandled rejections through the reserved fatal path (§26.1.3)',
    { timeout: 30000 },
    async () => {
      await withConsoleWorker(
        ["Promise.reject(new Error('unhandled-promise'));", 'export const marker = 1;'].join('\n'),
        {},
        async (context) => {
          await waitFor(() => context.fatalDiagnostics.length > 0, 5000);
          expect(context.fatalDiagnostics.length).toBeGreaterThan(0);
          const fatal = context.fatalDiagnostics[0];
          expect(fatal.kind).toBe('unhandled-rejection');
          expect(fatal.message).toBe('unhandled-promise');
          return undefined;
        },
      );
    },
  );
});
