/**
 * Build-time SES compatibility gate (ТЗ Plugin SDK vNext v3.2 §6.5/§8.10,
 * benchmark B25). Imports the plugin's source-first module graph under the
 * EXACT production boundary — a real Worker + lockdown(moderate) + one SES
 * Compartment — and reports module-graph-loaded / module-graph-error with
 * the precise error code. The plugin must not learn about SES
 * incompatibility on a production server: the gate runs in `neotavern-plugin
 * build --ses-gate` and in marketplace validation.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import {
  buildModuleGraph,
  WorkerSupervisor,
  type SupervisorListener,
  type WorkerReadyInfo,
} from '@neotavern/plugin-runtime';
import { validateManifest } from '@neotavern/plugin-sdk';
import { analyzePackage } from './analyze.js';

export interface SesGateOutcome {
  ok: boolean;
  kind: 'loaded' | 'error';
  exportNames: string[];
  code?: string;
  message?: string;
}

/**
 * Run the plugin's module graph in a real hardened worker. `entry` is the
 * manifest backend entry (package-relative posix path, e.g. `src/index.js`).
 */
export async function sesGate(root: string, entry: string): Promise<SesGateOutcome> {
  const absRoot = isAbsolute(root) ? root : join(process.cwd(), root);
  const files = new Map<string, string>();
  const stack = [absRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const item of entries) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        if (item.name === '.git' || item.name === 'node_modules' || item.name === 'dist') {
          continue;
        }
        stack.push(full);
        continue;
      }
      if (!item.isFile()) continue;
      const info = await stat(full);
      if (info.size > 512 * 1024) continue; // corpus-style archive bound
      const rel = full
        .slice(absRoot.length + 1)
        .split(sep)
        .join('/');
      files.set(rel, await readFile(full, 'utf8'));
    }
  }

  const built = buildModuleGraph({
    pluginId: 'neotavern-plugin-build.gate',
    entry,
    files,
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
    pluginId: 'neotavern-plugin-build.gate',
    installationId: 'ses-gate',
  });
  try {
    await readyGate.promise;
    const outcome = (() => {
      let resolveOutcome: (value: SesGateOutcome) => void = () => {};
      const promise = new Promise<SesGateOutcome>((resolve) => {
        resolveOutcome = resolve;
      });
      return { promise, resolve: resolveOutcome };
    })();
    const onMessage = (message: unknown): void => {
      if (message === null || typeof message !== 'object' || !('kind' in message)) return;
      if (message.kind === 'module-graph-loaded') {
        outcome.resolve({
          ok: true,
          kind: 'loaded',
          exportNames: (message as { exportNames?: string[] }).exportNames ?? [],
        });
      } else if (message.kind === 'module-graph-error') {
        const error = message as { code?: string; message?: string };
        outcome.resolve({
          ok: false,
          kind: 'error',
          exportNames: [],
          code: error.code,
          message: error.message,
        });
      }
    };
    record.control.on('message', onMessage);
    record.control.postMessage({ kind: 'load-module-graph', graph: built.graph });
    return await outcome.promise;
  } finally {
    await supervisor.terminateAll('ses gate done');
  }
}

/**
 * Full build-time gate: validates the manifest, runs the static analyzer,
 * then imports the graph under the production boundary. Returns the gate
 * outcome plus the analyzer report (the CLI prints both).
 */
export async function runBuildGate(root: string): Promise<{
  outcome: SesGateOutcome;
  report: Awaited<ReturnType<typeof analyzePackage>>;
}> {
  const report = await analyzePackage(root);
  if (report.manifest === null) {
    throw new Error('ses-gate requires a valid manifest.json');
  }
  const backend = report.manifest.backend;
  if (backend === undefined) {
    throw new Error('ses-gate requires manifest.backend (apiVersion 3)');
  }
  // Defense in depth: validate via the shared manifest validator too.
  const raw = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as unknown;
  const validated = validateManifest(raw);
  if (!validated.ok) {
    throw new Error(`ses-gate manifest validation failed: ${validated.error.message}`);
  }
  const outcome = await sesGate(root, backend);
  return { outcome, report };
}
