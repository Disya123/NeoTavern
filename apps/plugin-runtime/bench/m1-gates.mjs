/**
 * M1 prototype go/no-go measurements (ТЗ v3.2 §54, docs/plugin-sdk/vnext-m1.md).
 *
 * Runs the REAL subprocess runtime and measures the gates that are measurable
 * on a dev machine today:
 *
 *   1. idle Plugin Runtime RSS            (telemetry)
 *   2. incremental RSS per blank Worker   (telemetry deltas)
 *   4. max practical Workers on 3 GiB     (extrapolated from #2)
 *   5. cold Worker startup p50/p95        (WORKER_READY wall time + bootstrapMs)
 *   6. warm broker call latency           (host-ward hop: first->last rpcRequest
 *                                         of 100 sequential calls; full RTT is
 *                                         measurable once the host timers
 *                                         registry lands, §5.4 Stage A)
 *   7. SES module load overhead           (module-graph-loaded minus WORKER_READY)
 *  11. infinite-loop termination latency  (force-terminate path, §25.1)
 *  12. allocation runaway                 (bounded: allocation loop inside the
 *                                         infinite-loop gate; growth observation
 *                                         needs the host timers registry)
 *
 * Gates 8 (JIT), 9 (transferable), 10 (1 GiB stream), 13 (recovery), 14 (24h
 * drift), 15 (cross-platform parity) need the data-pipe/live-delivery
 * infrastructure or long-running/platform suites — tracked in vnext-plan.md.
 *
 * Usage: node bench/m1-gates.mjs   (requires a built dist: pnpm --filter @neotavern/plugin-runtime build)
 * Results print as a table and are appended to docs/plugin-sdk/vnext-m1.md
 * when run with `--record`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { PluginRuntimeClient, buildModuleGraph } from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECORD_PATH = resolve(__dirname, '../../../docs/plugin-sdk/vnext-m1.md');
const RECORD = process.argv.includes('--record');

const COLD_RUNS = 7;
const TERMINATE_RUNS = 3;
const CALLS_PER_WARM = 100;
const RSS_SETTLING_MS = 900;
const WAIT_TIMEOUT_MS = 10000;

const results = new Map();

function record(name, values, unit = 'ms') {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.ceil((q / 100) * sorted.length) - 1)];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const row = {
    n: sorted.length,
    min: sorted[0],
    mean,
    p50: p(50),
    p95: p(95),
    max: sorted[sorted.length - 1],
    unit,
  };
  results.set(name, row);
  return row;
}

function fmt(row) {
  if (typeof row.min === 'string') return row.min;
  const f = (v) => (row.unit === 'ms' ? v.toFixed(1) : v.toFixed(2));
  return `n=${String(row.n).padStart(2)}  min=${f(row.min).padStart(7)}  mean=${f(row.mean).padStart(7)}  p50=${f(row.p50).padStart(7)}  p95=${f(row.p95).padStart(7)}  max=${f(row.max).padStart(7)}  ${row.unit}`;
}

function graphFor(pluginId, entryLines) {
  const { graph } = buildModuleGraph({
    pluginId,
    entry: 'src/index.js',
    files: new Map([['src/index.js', entryLines.join('\n')]]),
  });
  return graph;
}

// No ambient timers in the worker (§5.4): graphs must not use Date.now /
// setInterval. Cold gate uses a pure export graph.
const COLD_GRAPH = graphFor('bench.cold', ['export const ready = { ok: true };']);

// Warm gate: 100 sequential bridge calls; latency is measured host-side from
// the first to the last RPC_REQUEST frame of the batch.
const CALLER_GRAPH = graphFor('bench.caller', [
  'export let result;',
  'let chain = Promise.resolve();',
  `for (let i = 0; i < ${CALLS_PER_WARM}; i++) {`,
  "  chain = chain.then(() => bridge.invoke('bench.echo', { i }, { capability: 'bench.echo' }));",
  '}',
  'chain.then(() => { result = { calls: ' + CALLS_PER_WARM + ' }; });',
]);

// Infinite allocation loop: blocks the worker message loop AND churns memory;
// terminate must fall back to force-termination (§25.1).
const LOOP_GRAPH = graphFor('bench.loop', [
  'const chunks = [];',
  'while (true) { chunks.push(new Array(1 << 20).fill(0)); }',
]);

async function waitFor(client, eventName, predicate) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      client.off(eventName, listener);
      rejectPromise(new Error(`timeout waiting for ${eventName}`));
    }, WAIT_TIMEOUT_MS);
    const listener = (payload) => {
      if (predicate && !predicate(payload)) return;
      clearTimeout(timer);
      client.off(eventName, listener);
      resolvePromise(payload);
    };
    client.on(eventName, listener);
  });
}

async function waitTelemetryRss(client, minimumSamples = 3) {
  let best = Infinity;
  let samples = 0;
  await new Promise((resolvePromise) => {
    const onTelemetry = (t) => {
      best = Math.min(best, t.rssMiB);
      samples += 1;
      if (samples >= minimumSamples) {
        client.off('telemetry', onTelemetry);
        resolvePromise();
      }
    };
    client.on('telemetry', onTelemetry);
  });
  return best;
}

async function spawnBlank(client, workerId, pluginId) {
  const readyPromise = waitFor(client, 'workerReady', (r) => r.workerId === workerId);
  client.spawnWorker({ workerId, pluginId, installationId: `${pluginId}@1.0.0` });
  return readyPromise;
}

async function spawnWithGraph(client, workerId, pluginId, graph, awaitLoaded = true) {
  const ready = await spawnBlank(client, workerId, pluginId);
  if (graph === undefined) return { ready, loaded: undefined, tReady: 0, tLoaded: 0 };
  const tReady = performance.now();
  const loadedPromise = waitFor(client, 'bridgeMessage', (b) => b.workerId === workerId).catch(
    (error) => ({ error }),
  );
  client.sendModuleGraph({ workerId, workerEpoch: ready.workerEpoch }, graph);
  if (!awaitLoaded) return { ready, loaded: undefined, tReady, tLoaded: 0 };
  const loaded = await loadedPromise;
  const tLoaded = performance.now();
  if ('error' in loaded) throw loaded.error;
  return { ready, loaded, tReady, tLoaded };
}

async function phase(label) {
  process.stdout.write(`\n── ${label}\n`);
}

async function main() {
  process.stdout.write('M1 prototype go/no-go measurements (§54)\n');
  process.stdout.write(`platform: ${process.platform} ${process.arch}; node ${process.version}\n`);

  const client = await PluginRuntimeClient.start({
    timeoutMs: 15000,
    telemetryMs: 250,
    stderrSink: (line) => process.stderr.write(`[runtime] ${line}\n`),
  });

  // -- 1/2/4: RSS ------------------------------------------------
  await phase('1/2/4 RSS');
  const idleRss = await waitTelemetryRss(client, 5);
  record('1. idle Plugin Runtime RSS', [idleRss], 'MiB');
  process.stdout.write(`1. idle runtime RSS: ${fmt(results.get('1. idle Plugin Runtime RSS'))}\n`);

  const deltas = [];
  let previous = idleRss;
  for (const count of [1, 2, 4, 8]) {
    const spawned = [];
    for (let i = 0; i < count; i++) {
      const workerId = 100 + i;
      spawned.push({ workerId, promise: spawnBlank(client, workerId, `bench.blank${count}.${i}`) });
    }
    await Promise.all(spawned.map((s) => s.promise));
    await new Promise((r) => setTimeout(r, RSS_SETTLING_MS));
    const rss = await waitTelemetryRss(client, 3);
    deltas.push((rss - previous) / count);
    previous = rss;
    process.stdout.write(`   blank workers=${count}  runtime RSS=${rss.toFixed(2)} MiB\n`);
    for (const s of spawned) client.terminateWorker(s.workerId, 'bench done');
    await new Promise((r) => setTimeout(r, RSS_SETTLING_MS));
    previous = await waitTelemetryRss(client, 3);
  }
  const deltaRow = record('2. RSS per blank Worker (delta)', deltas, 'MiB');
  process.stdout.write(`2. RSS per blank Worker (delta): ${fmt(deltaRow)}\n`);
  const capacity = Math.floor(3072 / deltaRow.mean);
  record('4. max Workers on 3 GiB (extrapolated)', [capacity], 'workers');
  process.stdout.write(`4. max Workers on 3 GiB (extrapolated): ${capacity}\n`);

  // -- 5/7: cold startup + module load ---------------------------
  await phase('5/7 cold startup + module load');
  const coldWall = [];
  const coldBootstrap = [];
  const moduleLoad = [];
  for (let i = 0; i < COLD_RUNS; i++) {
    const t0 = performance.now();
    const { ready, tReady, tLoaded } = await spawnWithGraph(
      client,
      200 + i,
      'bench.cold',
      COLD_GRAPH,
    );
    coldWall.push(performance.now() - t0);
    coldBootstrap.push(ready.bootstrapMs);
    moduleLoad.push(tLoaded - tReady);
    client.terminateWorker(ready.workerId, 'bench done');
    await new Promise((r) => setTimeout(r, 150));
  }
  const wallRow = record('5. cold Worker startup (wall)', coldWall);
  const bootRow = record('5b. cold Worker bootstrap (worker-side)', coldBootstrap);
  const loadRow = record('7. SES module load overhead (wall)', moduleLoad);
  process.stdout.write(`5. cold Worker startup wall: ${fmt(wallRow)}\n`);
  process.stdout.write(`5b. cold Worker bootstrap (worker-side): ${fmt(bootRow)}\n`);
  process.stdout.write(`7. SES module load overhead: ${fmt(loadRow)}\n`);

  // -- 6: warm call latency (host-ward hop) -----------------------
  await phase('6 warm call latency');
  const hopLatencies = [];
  for (let round = 0; round < 3; round++) {
    const workerId = 300 + round;
    const rpcSink = (body) => {
      client.sendRpcResponse({
        requestId: body.call.requestId,
        workerId: body.workerId,
        workerEpoch: body.workerEpoch,
        ok: true,
        result: { pong: true },
      });
    };
    client.on('rpcRequest', rpcSink);
    const batch = new Promise((resolveBatch) => {
      let count = 0;
      let tFirst = 0;
      const tally = (_body) => {
        if (tFirst === 0) tFirst = performance.now();
        count += 1;
        if (count >= CALLS_PER_WARM) {
          client.off('rpcRequest', tally);
          resolveBatch({ tFirst, tLast: performance.now() });
        }
      };
      client.on('rpcRequest', tally);
    });
    const { ready, loaded } = await spawnWithGraph(client, workerId, 'bench.warm', CALLER_GRAPH);
    const { tFirst, tLast } = await batch;
    hopLatencies.push((tLast - tFirst) / CALLS_PER_WARM);
    void loaded;
    client.off('rpcRequest', rpcSink);
    client.terminateWorker(ready.workerId, 'bench done');
    await new Promise((r) => setTimeout(r, 150));
  }
  const hopRow = record('6. warm broker call latency (host-ward hop)', hopLatencies);
  process.stdout.write(`6. warm broker call latency (host-ward hop): ${fmt(hopRow)}\n`);

  // -- 11/12: infinite-loop termination + allocation --------------
  await phase('11/12 infinite-loop + allocation termination');
  const termLatencies = [];
  for (let i = 0; i < TERMINATE_RUNS; i++) {
    const workerId = 400 + i;
    const { ready } = await spawnWithGraph(client, workerId, 'bench.loop', LOOP_GRAPH, false);
    // Let the module evaluation start churning, then terminate: the loop
    // blocks the worker message loop, so the two-phase terminate must fall
    // back to force-termination (§25.1).
    await new Promise((r) => setTimeout(r, 400));
    const terminatedPromise = waitFor(client, 'workerTerminated', (t) => t.workerId === workerId);
    const t0 = performance.now();
    client.terminateWorker(workerId, 'bench infinite loop');
    await terminatedPromise;
    termLatencies.push(performance.now() - t0);
    void ready;
  }
  const termRow = record('11. infinite-loop termination latency', termLatencies);
  process.stdout.write(`11. infinite-loop termination latency: ${fmt(termRow)}\n`);
  record('12. allocation runaway (in-loop, bounded)', ['deferred: needs host timers registry']);
  process.stdout.write(`12. allocation runaway: deferred until the host timers registry (§5.4)\n`);

  await client.terminate(10000);

  // -- summary + optional record -----------------------------------
  process.stdout.write('\n── summary ──────────────────────────────────────────────\n');
  for (const [name, row] of results) {
    process.stdout.write(`${name}: ${fmt(row)}\n`);
  }
  if (RECORD) {
    const stamp = new Date().toISOString();
    let doc = '';
    try {
      doc = readFileSync(RECORD_PATH, 'utf8');
    } catch {
      doc = `# M1 prototype go/no-go measurements (§54)\n\nРезультаты замеров на dev-машине; регулярные прогоны — задача следующей итерации.\n\n`;
    }
    const block =
      `\n## Прогон ${stamp}\n\nplatform: ${process.platform} ${process.arch}; node ${process.version}\n\n` +
      [...results.entries()].map(([name, row]) => `- ${name}: ${fmt(row)}`).join('\n') +
      '\n';
    writeFileSync(RECORD_PATH, doc + block);
    process.stdout.write(`\n[--record] appended to ${RECORD_PATH}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`bench failed: ${String(error)}\n`);
  process.exitCode = 1;
});
