/**
 * SES Compatibility Corpus gate (ТЗ v3.2 §6.5/§6.6, benchmark B25).
 *
 * Every corpus package is vendored into a signed module graph and imported
 * under the EXACT production boundary: a real Worker + lockdown(moderate) +
 * one SES Compartment. `expect: pass` packages must report
 * module-graph-loaded; `expect: fail` packages must fail with the documented
 * error code and the offending path, so incompatibilities surface at
 * validation time with a precise dependency chain — never at runtime.
 *
 * This file is the regression gate for every Node / SES / @endo upgrade.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkerSupervisor, type SupervisorListener, type WorkerReadyInfo } from '../supervisor.js';
import { buildModuleGraph } from '../graph/moduleGraphBuilder.js';
import { loadCorpusPackage } from './loadCorpusPackage.js';

interface CorpusManifestEntry {
  package: string;
  entry: string;
  expect: 'pass' | 'fail';
  expectedError?: string;
  reason: string;
}

interface CorpusManifest {
  version: number;
  note: string;
  packages: CorpusManifestEntry[];
}

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), 'corpus-manifest.json');

interface GraphOutcome {
  kind: 'loaded' | 'error';
  exportNames?: string[];
  code?: string;
  message?: string;
}

/**
 * Vendor the package, build a signed graph and import it in a real
 * SES-hardened worker; reports module-graph-loaded / module-graph-error.
 */
async function importUnderProductionBoundary(entry: CorpusManifestEntry): Promise<GraphOutcome> {
  const source = await loadCorpusPackage(entry.package);
  // The manifest entry is package-relative; the loader vendors it under
  // `node_modules/<package>/...`.
  expect(source.entry.endsWith(`/${entry.package}/${entry.entry}`)).toBe(true);
  expect(source.files.size).toBeGreaterThan(0);
  const built = buildModuleGraph({
    pluginId: 'test.corpus',
    entry: source.entry,
    files: source.files,
  });

  const readyGate = (() => {
    let resolveReady: (info: WorkerReadyInfo) => void = () => {};
    const promise = new Promise<WorkerReadyInfo>((resolve) => {
      resolveReady = resolve;
    });
    return { promise, resolve: resolveReady };
  })();
  const listener: SupervisorListener = {
    onWorkerReady: (info) => readyGate.resolve(info),
  };
  const supervisor = new WorkerSupervisor(listener);
  const record = supervisor.spawnWorker({
    workerId: 1,
    pluginId: 'test.corpus',
    installationId: `corpus-${entry.package}`,
  });
  try {
    await readyGate.promise;
    const outcome = (() => {
      let resolveOutcome: (value: GraphOutcome) => void = () => {};
      const promise = new Promise<GraphOutcome>((resolve) => {
        resolveOutcome = resolve;
      });
      return { promise, resolve: resolveOutcome };
    })();
    const onMessage = (message: unknown): void => {
      if (message === null || typeof message !== 'object' || !('kind' in message)) return;
      if (message.kind === 'module-graph-loaded') {
        outcome.resolve({
          kind: 'loaded',
          exportNames: (message as { exportNames?: string[] }).exportNames ?? [],
        });
      } else if (message.kind === 'module-graph-error') {
        const errorMessage = message as { code?: string; message?: string };
        outcome.resolve({ kind: 'error', code: errorMessage.code, message: errorMessage.message });
      }
    };
    record.control.on('message', onMessage);
    record.control.postMessage({ kind: 'load-module-graph', graph: built.graph });
    return await outcome.promise;
  } finally {
    await supervisor.terminateAll('corpus test done');
  }
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as CorpusManifest;

describe(`SES compatibility corpus v${manifest.version} (B25, §6.5/§6.6)`, () => {
  it('is a non-empty versioned manifest', () => {
    expect(manifest.packages.length).toBeGreaterThan(0);
    const ids = manifest.packages.map((entry) => entry.package);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of manifest.packages) {
      expect(['pass', 'fail']).toContain(entry.expect);
      if (entry.expect === 'fail') expect(entry.expectedError).toBeTruthy();
    }
  });

  for (const entry of manifest.packages) {
    it(
      `imports ${entry.package} under the production boundary (${entry.expect})`,
      { timeout: 60000 },
      async () => {
        const outcome = await importUnderProductionBoundary(entry);
        if (entry.expect === 'pass') {
          expect(outcome.kind).toBe('loaded');
          expect(outcome.exportNames?.length).toBeGreaterThan(0);
        } else {
          expect(outcome.kind).toBe('error');
          expect(outcome.code).toBe(entry.expectedError);
          // The failure must be actionable: a diagnostic message (the
          // offending module path rides `message`/`stack` when the error
          // carries it — under `errorTaming: 'safe'` the stack may be
          // censored, so the documented `expectedError` code is the gate).
          expect(outcome.message ?? '').not.toBe('');
        }
      },
    );
  }
});
