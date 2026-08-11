/**
 * Worker module-graph integration tests (Stage B, ТЗ §6, §8.6).
 *
 * Spawns a REAL Worker through the supervisor, awaits hardened-ready and then
 * drives the `load-module-graph` bridge message end-to-end: graph serialization
 * over the MessagePort bridge, digest verification and evaluation inside the
 * worker's SES Compartment. The test pins the bootstrap's inline error-code
 * constants against the `@neotavern/contracts` values so pre-lockdown capture and the
 * contracts single source of truth cannot drift silently.
 */
import { describe, expect, it } from 'vitest';
import { PluginModuleErrorCode, toModuleMapManifest } from '@neotavern/contracts';
import { WorkerSupervisor, type WorkerReadyInfo } from '../supervisor.js';
import { buildModuleGraph } from './moduleGraphBuilder.js';
import { sha256Hex } from './digest.js';

interface ModuleGraphLoaded {
  kind: 'module-graph-loaded';
  workerId: number;
  workerEpoch: number;
  exportNames: string[];
  snapshot: Record<string, unknown>;
}

interface ModuleGraphError {
  kind: 'module-graph-error';
  workerId: number;
  workerEpoch: number;
  code: string;
  message: string;
  stack: string | null;
}

function isModuleGraphLoaded(value: unknown): value is ModuleGraphLoaded {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as Record<string, unknown>)['kind'] === 'module-graph-loaded'
  );
}

function isModuleGraphError(value: unknown): value is ModuleGraphError {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as Record<string, unknown>)['kind'] === 'module-graph-error'
  );
}

async function withWorker(
  files: Record<string, string>,
  run: (context: {
    record: ReturnType<WorkerSupervisor['spawnWorker']>;
    ready: WorkerReadyInfo;
    load: () => Promise<ModuleGraphLoaded | ModuleGraphError>;
  }) => Promise<unknown>,
): Promise<unknown> {
  const built = buildModuleGraph({
    pluginId: 'test.echo',
    entry: 'src/index.js',
    files: new Map(Object.entries(files)),
  });
  const manifest = toModuleMapManifest(built.graph);
  const digest = sha256Hex(JSON.stringify(manifest));

  const supervisor = new WorkerSupervisor({
    onWorkerReady: (info: WorkerReadyInfo) => resolveReady(info),
  });
  let resolveReady: (info: WorkerReadyInfo) => void = () => undefined;
  const readyPromise = new Promise<WorkerReadyInfo>((resolveReadyNow) => {
    resolveReady = resolveReadyNow;
  });

  const record = supervisor.spawnWorker({
    workerId: 7,
    pluginId: 'test.echo',
    installationId: 'inst-echo',
    moduleGraphDigest: digest,
  });

  const ready = await readyPromise;

  const resultPromise = new Promise<ModuleGraphLoaded | ModuleGraphError>((resolveResult) => {
    record.control.on('message', (message: unknown) => {
      if (isModuleGraphLoaded(message) || isModuleGraphError(message)) {
        resolveResult(message);
      }
    });
  });

  try {
    return await run({
      record,
      ready,
      load: () => {
        record.control.postMessage({ kind: 'load-module-graph', graph: built.graph });
        return resultPromise;
      },
    });
  } finally {
    await supervisor.terminateAll();
  }
}

describe('worker module-graph loading', () => {
  it('loads a signed graph and reports export names + snapshot', async () => {
    await withWorker(
      {
        'src/index.js':
          "import { helper } from './helper.js';\nexport const name = 'test.echo';\nexport const greeting = helper('hi');\nexport function greet(who) { return helper(who); }\n",
        'src/helper.js': 'export function helper(x) { return `helper(${x})`; }\n',
      },
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.kind).toBe('module-graph-loaded');
        // Namespace export order is implementation-defined; compare as a set.
        expect(message.exportNames.slice().sort()).toEqual(['greet', 'greeting', 'name']);
        expect(message.snapshot).toEqual({
          name: 'test.echo',
          greeting: 'helper(hi)',
        });
      },
    );
  });

  it('loads JSON modules inside the worker', async () => {
    await withWorker(
      {
        'src/index.js': "import data from './data.json';\nexport const answer = data.answer;\n",
        'src/data.json': '{"answer":42}\n',
      },
      async ({ load }) => {
        const message = (await load()) as ModuleGraphLoaded;
        expect(message.snapshot).toEqual({ answer: 42 });
      },
    );
  });

  it('reports MODULE_DIGEST_MISMATCH when the graph is tampered with', async () => {
    const built = buildModuleGraph({
      pluginId: 'test.echo',
      entry: 'src/index.js',
      files: new Map(Object.entries({ 'src/index.js': 'export const x = 1;\n' })),
    });
    const supervisor = new WorkerSupervisor({});
    const record = supervisor.spawnWorker({
      workerId: 3,
      pluginId: 'test.echo',
      installationId: 'inst-echo',
    });
    const tampered = structuredClone(built.graph);
    tampered.records[0]!.digest = 'b'.repeat(64);
    try {
      const errorPromise = new Promise<ModuleGraphError>((resolveError) => {
        record.control.on('message', (message: unknown) => {
          if (isModuleGraphError(message)) resolveError(message);
        });
      });
      record.control.postMessage({ kind: 'load-module-graph', graph: tampered });
      const message = await errorPromise;
      // Pins the bootstrap inline code to the contracts value.
      expect(message.code).toBe(PluginModuleErrorCode.MODULE_DIGEST_MISMATCH);
    } finally {
      await supervisor.terminateAll();
    }
  });

  it('reports MODULE_EVALUATION_FAILED when plugin code throws at import', async () => {
    await withWorker(
      {
        'src/index.js': "import { boom } from './boom.js';\nexport const value = boom();\n",
        'src/boom.js': "export function boom() { throw new Error('kaboom'); }\n",
      },
      async ({ load }) => {
        const message = (await load()) as ModuleGraphError;
        expect(message.code).toBe(PluginModuleErrorCode.MODULE_EVALUATION_FAILED);
        expect(message.message).toContain('kaboom');
      },
    );
  });
});
