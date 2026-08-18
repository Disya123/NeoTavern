import { afterEach, describe, expect, it } from 'vitest';
import type {
  PluginRuntimeBridgeMessageBody,
  PluginRuntimeWorkerReady,
} from '@neotavern/contracts';
import { sha256Hex } from './graph/digest.js';
import { buildModuleGraph } from './graph/moduleGraphBuilder.js';
import { PluginRuntimeClient } from './host/runtimeClient.js';

describe('PluginRuntimeClient spawn integration', () => {
  let client: PluginRuntimeClient | undefined;
  const stderr: string[] = [];

  afterEach(async () => {
    if (client) {
      await client.terminate(5000).catch(() => client?.close());
      client = undefined;
    }
    stderr.length = 0;
  });

  it(
    'handshakes, bootstraps a SES-hardened worker, pings and terminates',
    { timeout: 30000 },
    async () => {
      client = await PluginRuntimeClient.start({
        timeoutMs: 15000,
        telemetryMs: 250,
        stderrSink: (line) => stderr.push(line),
      });
      expect(client.connectedState).toBe(true);

      const ready = new Promise<PluginRuntimeWorkerReady>((resolveReady) => {
        client?.once('workerReady', resolveReady);
      });
      client.spawnWorker({ workerId: 1, pluginId: 'test.echo', installationId: 'inst-1' });
      const info = await ready;
      expect(info.workerId).toBe(1);
      expect(info.workerEpoch).toBe(1);
      expect(info.pluginId).toBe('test.echo');
      expect(info.noNodeAuthority).toBe(true);
      expect(info.probe.process).toBe(false);
      expect(info.probe.require).toBe(false);
      expect(info.probe.buffer).toBe(false);
      expect(info.probe.fetch).toBe(false);
      expect(info.probe.marker).toBe(2);

      const pong = await client.ping();
      expect(pong.runtimeEpoch).toBe(1);
      expect(pong.pid).toBeGreaterThan(0);
      expect(pong.workerCount).toBeGreaterThanOrEqual(1);

      const exit = new Promise<void>((resolveExit) => client?.once('exit', () => resolveExit()));
      await client.terminate(10000);
      await exit;
    },
  );

  it('terminates a worker and reports workerTerminated', { timeout: 30000 }, async () => {
    client = await PluginRuntimeClient.start({
      timeoutMs: 15000,
      stderrSink: (line) => stderr.push(line),
    });
    const ready = new Promise<PluginRuntimeWorkerReady>((resolveReady) => {
      client?.once('workerReady', resolveReady);
    });
    client.spawnWorker({ workerId: 7, pluginId: 'test.kill', installationId: 'inst-7' });
    await ready;

    const terminated = new Promise<void>((resolveTerminated) => {
      client?.once('workerTerminated', (info) => {
        expect(info.workerId).toBe(7);
        resolveTerminated();
      });
    });
    client.terminateWorker(7, 'test');
    await terminated;

    const exit = new Promise<void>((resolveExit) => client?.once('exit', () => resolveExit()));
    await client.terminate(10000);
    await exit;
  });

  it(
    'ships a signed module graph after WORKER_READY and reports module-graph-loaded',
    { timeout: 30000 },
    async () => {
      client = await PluginRuntimeClient.start({
        timeoutMs: 15000,
        stderrSink: (line) => stderr.push(line),
      });
      const { graph, graphDigest } = buildGraph('test.graph', [
        "export const hello = { text: 'hi' };\n",
      ]);

      const ready = new Promise<PluginRuntimeWorkerReady>((resolveReady) => {
        client?.once('workerReady', resolveReady);
      });
      client.spawnWorker({
        workerId: 3,
        pluginId: 'test.graph',
        installationId: 'inst-3',
        moduleGraphDigest: graphDigest,
      });
      const info = await ready;

      const loaded = new Promise<PluginRuntimeBridgeMessageBody>((resolveLoaded) => {
        const listener = (body: PluginRuntimeBridgeMessageBody): void => {
          if (body.workerId !== 3) return;
          client?.off('bridgeMessage', listener);
          resolveLoaded(body);
        };
        client?.on('bridgeMessage', listener);
      });
      // §15.8: the graph travels AFTER hardened-ready, with the epoch the
      // runtime stamped in WORKER_READY.
      client.sendModuleGraph({ workerId: info.workerId, workerEpoch: info.workerEpoch }, graph);
      const body = await loaded;
      const message = body.message as {
        kind?: string;
        exportNames?: string[];
        snapshot?: Record<string, unknown>;
      };
      expect(message.kind).toBe('module-graph-loaded');
      expect(message.exportNames).toEqual(['hello']);
      expect(message.snapshot).toEqual({ hello: { text: 'hi' } });

      const exit = new Promise<void>((resolveExit) => client?.once('exit', () => resolveExit()));
      await client.terminate(10000);
      await exit;
    },
  );

  it(
    'ships a module graph over the data pipe when it exceeds the control path (Stage F)',
    { timeout: 30000 },
    async () => {
      client = await PluginRuntimeClient.start({
        timeoutMs: 15000,
        stderrSink: (line) => stderr.push(line),
      });
      // ~60 KiB source: over the control frame's per-string bound (32 KiB)
      // and the encoded-total margin, so sendModuleGraph must route it to
      // the data pipe (fd 3). A control attempt would fail the runtime's
      // §15.11 decode — a successful load proves the data path.
      const bigSource =
        `const pad = ${JSON.stringify('x'.repeat(60 * 1024))};\n` +
        `export const big = { padLength: pad.length, marker: 'data-pipe' };\n`;
      const { graph, graphDigest } = buildGraph('test.biggraph', [bigSource]);

      const ready = new Promise<PluginRuntimeWorkerReady>((resolveReady) => {
        client?.once('workerReady', resolveReady);
      });
      client.spawnWorker({
        workerId: 6,
        pluginId: 'test.biggraph',
        installationId: 'inst-6',
        moduleGraphDigest: graphDigest,
      });
      const info = await ready;

      const loaded = new Promise<PluginRuntimeBridgeMessageBody>((resolveLoaded) => {
        const listener = (body: PluginRuntimeBridgeMessageBody): void => {
          if (body.workerId !== 6) return;
          client?.off('bridgeMessage', listener);
          resolveLoaded(body);
        };
        client?.on('bridgeMessage', listener);
      });
      client.sendModuleGraph({ workerId: info.workerId, workerEpoch: info.workerEpoch }, graph);
      const body = await loaded;
      const message = body.message as {
        kind?: string;
        exportNames?: string[];
        snapshot?: Record<string, unknown>;
      };
      expect(message.kind).toBe('module-graph-loaded');
      expect(message.exportNames).toEqual(['big']);
      expect(message.snapshot).toEqual({ big: { padLength: 60 * 1024, marker: 'data-pipe' } });

      const exit = new Promise<void>((resolveExit) => client?.once('exit', () => resolveExit()));
      await client.terminate(10000);
      await exit;
    },
  );

  it(
    'settles a broker call with a large result over the data pipe (Stage F)',
    { timeout: 30000 },
    async () => {
      client = await PluginRuntimeClient.start({
        timeoutMs: 15000,
        stderrSink: (line) => stderr.push(line),
      });
      const bigResult = 'x'.repeat(200 * 1024);
      const { graph } = buildGraph('test.bigresult', [
        'export let result;',
        "bridge.invoke('storage.kv.get', { key: 'big' }, { capability: 'storage.kv' })",
        '  .then((value) => {',
        '    result = { textLength: value.value.text.length, head: value.value.text.slice(0, 3) };',
        '  });',
      ]);

      const ready = new Promise<PluginRuntimeWorkerReady>((resolveReady) => {
        client?.once('workerReady', resolveReady);
      });
      client.spawnWorker({
        workerId: 7,
        pluginId: 'test.bigresult',
        installationId: 'inst-7',
      });
      const info = await ready;

      // The test acts as the broker: answer the import-time call with a
      // result whose body exceeds the control path, so the client must ship
      // it over the data pipe (RPC_RESPONSE_DATA, fd 3).
      client.on('rpcRequest', (body) => {
        if (body.workerId !== 7) return;
        const call = body.call as { requestId?: string };
        if (typeof call.requestId !== 'string') return;
        client?.sendRpcResponse({
          workerId: body.workerId,
          workerEpoch: body.workerEpoch,
          requestId: call.requestId,
          ok: true,
          result: { value: { text: bigResult } },
        });
      });

      const loaded = new Promise<PluginRuntimeBridgeMessageBody>((resolveLoaded) => {
        const listener = (body: PluginRuntimeBridgeMessageBody): void => {
          if (body.workerId !== 7) return;
          client?.off('bridgeMessage', listener);
          resolveLoaded(body);
        };
        client?.on('bridgeMessage', listener);
      });
      client.sendModuleGraph({ workerId: info.workerId, workerEpoch: info.workerEpoch }, graph);
      const body = await loaded;
      const message = body.message as { kind?: string; snapshot?: Record<string, unknown> };
      expect(message.kind).toBe('module-graph-loaded');
      const value = message.snapshot?.['result'] as {
        textLength?: number;
        head?: string;
      };
      expect(value).toEqual({ textLength: 200 * 1024, head: 'xxx' });

      const exit = new Promise<void>((resolveExit) => client?.once('exit', () => resolveExit()));
      await client.terminate(10000);
      await exit;
    },
  );

  it(
    'streams a large result over §17 credit chunks (Stage F part 14)',
    { timeout: 30000 },
    async () => {
      client = await PluginRuntimeClient.start({
        timeoutMs: 15000,
        stderrSink: (line) => stderr.push(line),
      });
      const bigResult = 'y'.repeat(600 * 1024);
      const { graph } = buildGraph('test.bigstream', [
        'export let result;',
        "bridge.invoke('storage.kv.get', { key: 'big' }, { capability: 'storage.kv' })",
        '  .then((value) => {',
        '    result = { textLength: value.value.text.length, head: value.value.text.slice(0, 3) };',
        '  });',
      ]);

      const ready = new Promise<PluginRuntimeWorkerReady>((resolveReady) => {
        client?.once('workerReady', resolveReady);
      });
      client.spawnWorker({
        workerId: 8,
        pluginId: 'test.bigstream',
        installationId: 'inst-8',
      });
      const info = await ready;

      // The test acts as the broker: answer with a 600 KiB body, which the
      // client must chunk (3 × 256 KiB) and pace with credit grants the
      // worker sends as it consumes each chunk.
      client.on('rpcRequest', (body) => {
        if (body.workerId !== 8) return;
        const call = body.call as { requestId?: string };
        if (typeof call.requestId !== 'string') return;
        client?.sendRpcResponse({
          workerId: body.workerId,
          workerEpoch: body.workerEpoch,
          requestId: call.requestId,
          ok: true,
          result: { value: { text: bigResult } },
        });
      });

      const loaded = new Promise<PluginRuntimeBridgeMessageBody>((resolveLoaded) => {
        const listener = (body: PluginRuntimeBridgeMessageBody): void => {
          if (body.workerId !== 8) return;
          client?.off('bridgeMessage', listener);
          resolveLoaded(body);
        };
        client?.on('bridgeMessage', listener);
      });
      client.sendModuleGraph({ workerId: info.workerId, workerEpoch: info.workerEpoch }, graph);
      const body = await loaded;
      const message = body.message as { kind?: string; snapshot?: Record<string, unknown> };
      expect(message.kind).toBe('module-graph-loaded');
      const value = message.snapshot?.['result'] as {
        textLength?: number;
        head?: string;
      };
      expect(value).toEqual({ textLength: 600 * 1024, head: 'yyy' });
      // Proves the §17 credit path was exercised: a single-frame transport
      // would have produced zero RPC_RESPONSE_STREAM chunks. The byte count
      // is the encoded body (600 KiB of text plus the response envelope).
      expect(client.responseStreamFrameCount).toBeGreaterThanOrEqual(3);
      expect(client.responseStreamByteCount).toBeGreaterThanOrEqual(600 * 1024);

      const exit = new Promise<void>((resolveExit) => client?.once('exit', () => resolveExit()));
      await client.terminate(10000);
      await exit;
    },
  );

  it(
    'forwards large broker-call args over the data pipe (Stage F part 13)',
    { timeout: 30000 },
    async () => {
      client = await PluginRuntimeClient.start({
        timeoutMs: 15000,
        stderrSink: (line) => stderr.push(line),
      });
      const { graph } = buildGraph('test.bigargs', [
        'export let result;',
        "const big = 'w'.repeat(200 * 1024);",
        "bridge.invoke('storage.kv.set', { key: 'big', value: big }, { capability: 'storage.kv' })",
        '  .then(() => { result = { ok: true }; });',
      ]);

      const ready = new Promise<PluginRuntimeWorkerReady>((resolveReady) => {
        client?.once('workerReady', resolveReady);
      });
      client.spawnWorker({
        workerId: 9,
        pluginId: 'test.bigargs',
        installationId: 'inst-9',
      });
      const info = await ready;

      // The test acts as the broker. The args (200 KiB value) exceed the
      // control path, so the client must receive them decoded from the fd 4
      // data pipe (RPC_REQUEST_DATA) with the full payload intact; settling
      // via the ordinary control RPC_RESPONSE proves the runtime's pending
      // registry tracks opaque calls too.
      let receivedLength = 0;
      client.on('rpcRequest', (body) => {
        if (body.workerId !== 9) return;
        const call = body.call as { requestId?: string; args?: { key?: string; value?: string } };
        if (typeof call.requestId !== 'string') return;
        receivedLength = call.args?.value?.length ?? 0;
        client?.sendRpcResponse({
          workerId: body.workerId,
          workerEpoch: body.workerEpoch,
          requestId: call.requestId,
          ok: true,
          result: { ok: true },
        });
      });

      const loaded = new Promise<PluginRuntimeBridgeMessageBody>((resolveLoaded) => {
        const listener = (body: PluginRuntimeBridgeMessageBody): void => {
          if (body.workerId !== 9) return;
          client?.off('bridgeMessage', listener);
          resolveLoaded(body);
        };
        client?.on('bridgeMessage', listener);
      });
      client.sendModuleGraph({ workerId: info.workerId, workerEpoch: info.workerEpoch }, graph);
      const body = await loaded;
      const message = body.message as { kind?: string; snapshot?: Record<string, unknown> };
      expect(message.kind).toBe('module-graph-loaded');
      expect(receivedLength).toBe(200 * 1024);
      expect(message.snapshot?.['result']).toEqual({ ok: true });

      const exit = new Promise<void>((resolveExit) => client?.once('exit', () => resolveExit()));
      await client.terminate(10000);
      await exit;
    },
  );

  it(
    'omits an oversized export snapshot instead of crashing the runtime (Stage F)',
    { timeout: 30000 },
    async () => {
      client = await PluginRuntimeClient.start({
        timeoutMs: 15000,
        stderrSink: (line) => stderr.push(line),
      });
      // A plugin exporting a huge value: the module-graph-loaded snapshot
      // would exceed the BRIDGE_MESSAGE control frame, so the worker must
      // omit it (snapshotOmitted) and the runtime must stay alive.
      const big = 'y'.repeat(300 * 1024);
      const { graph } = buildGraph('test.bigsnapshot', [
        `export const huge = ${JSON.stringify(big)};`,
      ]);

      const ready = new Promise<PluginRuntimeWorkerReady>((resolveReady) => {
        client?.once('workerReady', resolveReady);
      });
      client.spawnWorker({
        workerId: 8,
        pluginId: 'test.bigsnapshot',
        installationId: 'inst-8',
      });
      const info = await ready;

      const loaded = new Promise<PluginRuntimeBridgeMessageBody>((resolveLoaded) => {
        const listener = (body: PluginRuntimeBridgeMessageBody): void => {
          if (body.workerId !== 8) return;
          client?.off('bridgeMessage', listener);
          resolveLoaded(body);
        };
        client?.on('bridgeMessage', listener);
      });
      client.sendModuleGraph({ workerId: info.workerId, workerEpoch: info.workerEpoch }, graph);
      const body = await loaded;
      const message = body.message as { kind?: string; snapshotOmitted?: boolean };
      expect(message.kind).toBe('module-graph-loaded');
      expect(message.snapshotOmitted).toBe(true);

      const exit = new Promise<void>((resolveExit) => client?.once('exit', () => resolveExit()));
      await client.terminate(10000);
      await exit;
    },
  );

  it(
    'reports module-graph-error when the entry module evaluation throws',
    { timeout: 30000 },
    async () => {
      client = await PluginRuntimeClient.start({
        timeoutMs: 15000,
        stderrSink: (line) => stderr.push(line),
      });
      const { graph } = buildGraph('test.boom', ["throw new Error('boom');\n"]);

      const ready = new Promise<PluginRuntimeWorkerReady>((resolveReady) => {
        client?.once('workerReady', resolveReady);
      });
      client.spawnWorker({ workerId: 4, pluginId: 'test.boom', installationId: 'inst-4' });
      const info = await ready;

      const errored = new Promise<PluginRuntimeBridgeMessageBody>((resolveError) => {
        const listener = (body: PluginRuntimeBridgeMessageBody): void => {
          if (body.workerId !== 4) return;
          client?.off('bridgeMessage', listener);
          resolveError(body);
        };
        client?.on('bridgeMessage', listener);
      });
      client.sendModuleGraph({ workerId: info.workerId, workerEpoch: info.workerEpoch }, graph);
      const body = await errored;
      const message = body.message as { kind?: string; code?: string };
      expect(message.kind).toBe('module-graph-error');
      expect(message.code).toBe('MODULE_EVALUATION_FAILED');

      const exit = new Promise<void>((resolveExit) => client?.once('exit', () => resolveExit()));
      await client.terminate(10000);
      await exit;
    },
  );

  it(
    'delivers plugin console records as LOG_BATCH frames and acks them (§9.1.1)',
    { timeout: 30000 },
    async () => {
      client = await PluginRuntimeClient.start({
        timeoutMs: 15000,
        stderrSink: (line) => stderr.push(line),
      });
      const { graph } = buildGraph('test.logs', [
        "console.log('first', 1);",
        "console.warn('second');",
        'export const ok = 1;',
      ]);

      const ready = new Promise<PluginRuntimeWorkerReady>((resolveReady) => {
        client?.once('workerReady', resolveReady);
      });
      client.spawnWorker({ workerId: 9, pluginId: 'test.logs', installationId: 'inst-9' });
      const info = await ready;

      const loaded = new Promise<PluginRuntimeBridgeMessageBody>((resolveLoaded) => {
        const listener = (body: PluginRuntimeBridgeMessageBody): void => {
          if (body.workerId !== 9) return;
          client?.off('bridgeMessage', listener);
          resolveLoaded(body);
        };
        client?.on('bridgeMessage', listener);
      });
      client.sendModuleGraph({ workerId: info.workerId, workerEpoch: info.workerEpoch }, graph);
      await loaded;

      const firstBatch = new Promise<{
        workerId: number;
        workerEpoch: number;
        seq: number;
        droppedCount: number;
        records: Array<{ level: string; message: string; at: number }>;
      }>((resolveBatch) => {
        client?.once('logBatch', resolveBatch);
      });
      const batch = await firstBatch;
      expect(batch.workerId).toBe(9);
      expect(batch.workerEpoch).toBe(info.workerEpoch);
      expect(batch.seq).toBe(0);
      expect(batch.droppedCount).toBe(0);
      const messages = batch.records.map((r) => `${r.level}:${r.message}`);
      expect(messages).toContain('log:first 1');
      expect(messages).toContain('warn:second');

      // §9.1.1 credit ack: consumed batch → replenish → the worker keeps
      // flushing; the runtime must relay the ack without breaking the
      // worker (probe with a ping).
      client.sendLogBatchAck({ workerId: 9, workerEpoch: info.workerEpoch, seq: batch.seq });
      const pong = await client.ping();
      expect(pong.workerCount).toBeGreaterThanOrEqual(1);

      const exit = new Promise<void>((resolveExit) => client?.once('exit', () => resolveExit()));
      await client.terminate(10000);
      await exit;
    },
  );

  it(
    'forwards worker fatal diagnostics on the reserved path (§9.1.4)',
    { timeout: 30000 },
    async () => {
      client = await PluginRuntimeClient.start({
        timeoutMs: 15000,
        stderrSink: (line) => stderr.push(line),
      });
      const { graph } = buildGraph('test.fatal', [
        "Promise.resolve().then(() => { throw new TypeError('subprocess-crash'); });",
        'export const ok = 1;',
      ]);

      const ready = new Promise<PluginRuntimeWorkerReady>((resolveReady) => {
        client?.once('workerReady', resolveReady);
      });
      client.spawnWorker({ workerId: 10, pluginId: 'test.fatal', installationId: 'inst-10' });
      const info = await ready;

      const fatal = new Promise<{
        workerId: number;
        workerEpoch: number;
        envelope: { kind: string; name: string; message: string };
      }>((resolveFatal) => {
        client?.once('fatalDiagnostic', resolveFatal);
      });
      const terminated = new Promise<{
        workerId: number;
        workerEpoch: number;
        code: number;
        fatal?: unknown;
      }>((resolveTerminated) => {
        const listener = (body: { workerId: number; code: number; fatal?: unknown }): void => {
          if (body.workerId !== 10) return;
          client?.off('workerTerminated', listener);
          resolveTerminated(
            body as { workerId: number; workerEpoch: number; code: number; fatal?: unknown },
          );
        };
        client?.on('workerTerminated', listener);
      });
      client.sendModuleGraph({ workerId: info.workerId, workerEpoch: info.workerEpoch }, graph);

      const fatalBody = await fatal;
      expect(fatalBody.workerId).toBe(10);
      expect(fatalBody.envelope.kind).toBe('unhandled-rejection');
      expect(fatalBody.envelope.name).toBe('TypeError');
      expect(fatalBody.envelope.message).toBe('subprocess-crash');

      // The runtime retains the last fatal envelope and attaches it to
      // WORKER_TERMINATED so crash attribution survives frame races.
      const terminatedBody = await terminated;
      expect(terminatedBody.code).toBe(1);
      expect(terminatedBody.fatal).toMatchObject({
        kind: 'unhandled-rejection',
        name: 'TypeError',
        message: 'subprocess-crash',
      });

      const exit = new Promise<void>((resolveExit) => client?.once('exit', () => resolveExit()));
      await client.terminate(10000);
      await exit;
    },
  );

  it('rejects a module graph addressed to a stale worker epoch', { timeout: 30000 }, async () => {
    client = await PluginRuntimeClient.start({
      timeoutMs: 15000,
      stderrSink: (line) => stderr.push(line),
    });
    const { graph } = buildGraph('test.stale', ['export const ok = 1;\n']);
    const ready = new Promise<PluginRuntimeWorkerReady>((resolveReady) => {
      client?.once('workerReady', resolveReady);
    });
    client.spawnWorker({ workerId: 5, pluginId: 'test.stale', installationId: 'inst-5' });
    await ready;

    const errorFrame = new Promise<void>((resolveError) => {
      client?.once('error', () => resolveError());
    });
    client.sendModuleGraph({ workerId: 5, workerEpoch: 999 }, graph);
    await errorFrame;
  });

  it(
    'ships the emergency ceiling override over the wire and reports it back (§22/§39)',
    { timeout: 30000 },
    async () => {
      client = await PluginRuntimeClient.start({
        timeoutMs: 15000,
        stderrSink: (line) => stderr.push(line),
      });
      const ready = new Promise<PluginRuntimeWorkerReady>((resolveReady) => {
        client?.once('workerReady', resolveReady);
      });
      client.spawnWorker({
        workerId: 13,
        pluginId: 'test.limits',
        installationId: 'inst-13',
        maxHeapOverrideMiB: 768,
        memoryHintMiB: 512,
      });
      const info = await ready;
      expect(info.emergencyLimits).toEqual({
        maxOldGenerationSizeMb: 768,
        maxYoungGenerationSizeMb: 192,
      });

      const exit = new Promise<void>((resolveExit) => client?.once('exit', () => resolveExit()));
      await client.terminate(10000);
      await exit;
    },
  );

  it(
    'survives a runtime process crash and starts a fresh generation (§20.13)',
    { timeout: 30000 },
    async () => {
      client = await PluginRuntimeClient.start({
        runtimeEpoch: 1,
        timeoutMs: 15000,
        stderrSink: (line) => stderr.push(line),
      });
      const ready = new Promise<PluginRuntimeWorkerReady>((resolveReady) => {
        client?.once('workerReady', resolveReady);
      });
      client.spawnWorker({ workerId: 11, pluginId: 'test.crash', installationId: 'inst-11' });
      await ready;

      // Kill the runtime process out from under the client (simulated
      // PLUGIN_RUNTIME_CRASHED). The client must surface the exit and reject
      // all pending waiters; the host then starts a new generation.
      const exited = new Promise<{ code: number | null }>((resolveExit) => {
        client?.once('exit', (info) => resolveExit(info));
      });
      const child = (client as unknown as { child: { kill(signal: string): void } }).child;
      child.kill('SIGKILL');
      const exitInfo = await exited;
      expect(exitInfo.code).not.toBe(0);

      // Generation 2: a fresh runtime handshakes under a new epoch; stale
      // frames from generation 1 cannot be confused with it (§25.2).
      client = await PluginRuntimeClient.start({
        runtimeEpoch: 2,
        timeoutMs: 15000,
        stderrSink: (line) => stderr.push(line),
      });
      expect(client.runtimeEpoch).toBe(2);
      const pong = await client.ping();
      expect(pong.runtimeEpoch).toBe(2);

      const ready2 = new Promise<PluginRuntimeWorkerReady>((resolveReady) => {
        client?.once('workerReady', resolveReady);
      });
      client.spawnWorker({ workerId: 12, pluginId: 'test.crash', installationId: 'inst-12' });
      const info2 = await ready2;
      expect(info2.workerEpoch).toBe(1);

      const exit = new Promise<void>((resolveExit) => client?.once('exit', () => resolveExit()));
      await client.terminate(10000);
      await exit;
    },
  );
});

function buildGraph(
  pluginId: string,
  entryLines: string[],
): { graph: unknown; graphDigest: string } {
  const { graph } = buildModuleGraph({
    pluginId,
    entry: 'src/index.js',
    files: new Map([['src/index.js', entryLines.join('\n')]]),
  });
  return { graph, graphDigest: sha256Hex(JSON.stringify(graph)) };
}
