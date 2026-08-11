/**
 * Supervisor-level emergency resource boundary tests (ADR-0026 §22): the
 * Worker is spawned with the resolved ceiling, the trusted bootstrap reports
 * it back on hardened-ready, and the admin override (spawn option) wins over
 * everything else.
 */
import { describe, expect, it } from 'vitest';
import { WorkerSupervisor, type SupervisorListener, type WorkerReadyInfo } from './supervisor.js';
import { EMERGENCY_MAX_OLD_GEN_MB, EMERGENCY_MIN_OLD_GEN_MB } from './emergencyLimits.js';

interface ReadyContext {
  ready: WorkerReadyInfo;
  threadLimits: { maxOldGenerationSizeMb: number; maxYoungGenerationSizeMb: number };
}

/**
 * Spawn one worker through a supervisor whose listener captures the
 * hardened-ready report; always terminates the worker afterwards.
 */
async function withSupervisorWorker(
  options: ConstructorParameters<typeof WorkerSupervisor>[1],
  spawnOptions: Parameters<WorkerSupervisor['spawnWorker']>[0],
  run: (context: ReadyContext) => unknown,
): Promise<unknown> {
  let resolveReady: (info: WorkerReadyInfo) => void = () => {};
  const readyPromise = new Promise<WorkerReadyInfo>((resolve) => {
    resolveReady = resolve;
  });
  const listener: SupervisorListener = {
    onWorkerReady: (info) => resolveReady(info),
  };
  const supervisor = new WorkerSupervisor(listener, options);
  const record = supervisor.spawnWorker(spawnOptions);
  try {
    const ready = await readyPromise;
    // The Worker object exposes the effective limits back to the supervisor.
    const threadLimits = {
      maxOldGenerationSizeMb: record.thread.resourceLimits?.maxOldGenerationSizeMb ?? -1,
      maxYoungGenerationSizeMb: record.thread.resourceLimits?.maxYoungGenerationSizeMb ?? -1,
    };
    return await run({ ready, threadLimits });
  } finally {
    await supervisor.terminateAll('test done');
  }
}

describe('supervisor emergency resource boundary (§22)', () => {
  it(
    'applies the admin override and reports it back on hardened-ready',
    { timeout: 60000 },
    async () => {
      await withSupervisorWorker(
        {},
        { workerId: 1, pluginId: 'test.limits', installationId: 'inst-1', maxHeapOverrideMiB: 768 },
        ({ ready, threadLimits }) => {
          expect(threadLimits.maxOldGenerationSizeMb).toBe(768);
          expect(threadLimits.maxYoungGenerationSizeMb).toBe(192);
          expect(ready.emergencyLimits).toEqual({
            maxOldGenerationSizeMb: 768,
            maxYoungGenerationSizeMb: 192,
          });
        },
      );
    },
  );

  it(
    'derives the ceiling from headroom when nothing is configured',
    { timeout: 60000 },
    async () => {
      await withSupervisorWorker(
        {},
        { workerId: 2, pluginId: 'test.limits', installationId: 'inst-2' },
        ({ ready, threadLimits }) => {
          expect(threadLimits.maxOldGenerationSizeMb).toBeGreaterThanOrEqual(
            EMERGENCY_MIN_OLD_GEN_MB,
          );
          expect(threadLimits.maxOldGenerationSizeMb).toBeLessThanOrEqual(EMERGENCY_MAX_OLD_GEN_MB);
          expect(threadLimits.maxYoungGenerationSizeMb).toBeGreaterThanOrEqual(64);
          expect(ready.emergencyLimits?.maxOldGenerationSizeMb).toBe(
            threadLimits.maxOldGenerationSizeMb,
          );
          expect(ready.emergencyLimits?.maxYoungGenerationSizeMb).toBe(
            threadLimits.maxYoungGenerationSizeMb,
          );
        },
      );
    },
  );

  it('static supervisor configuration beats dynamic headroom', { timeout: 60000 }, async () => {
    await withSupervisorWorker(
      { maxOldGenerationSizeMb: 512 },
      { workerId: 3, pluginId: 'test.limits', installationId: 'inst-3' },
      ({ ready }) => {
        expect(ready.emergencyLimits?.maxOldGenerationSizeMb).toBe(512);
        expect(ready.emergencyLimits?.maxYoungGenerationSizeMb).toBe(128);
      },
    );
  });
});
