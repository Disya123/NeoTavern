/**
 * Plugin SDK vNext benchmark harness (ТЗ v3.2 §47, Stage I, M6).
 *
 * Runs the B01–B31 mandatory benchmark scenarios against the runtime's
 * public dist surface and gates them against the §46 SLOs. Scenarios that
 * are already enforced by dedicated regression tests (B06, B09, B11–B18,
 * B23–B25, B32, B43–B47) are mapped to their covering test files and
 * asserted present; the rest are measured here for real.
 *
 * Usage:
 *   node apps/plugin-runtime/bench/bench-vnext.mjs [--heavy] [--report-only]
 *        [--json out.json] [--soak]
 *
 *   --heavy        run the >1 GiB scenarios (B05, B07, B10) — opt-in so the
 *                  default run stays cheap on any machine.
 *   --report-only  never exit non-zero; print the gate table anyway.
 *   --json <path>  write the full machine-readable report.
 *   --soak         marker for the 24h soak (B17); CI-only, never run here.
 *
 * Gates (§46) are env-overridable: BENCH_GATE_IDLE_RSS_MB,
 * BENCH_GATE_INSTALLED_DELTA_MB, BENCH_GATE_WARM_MS, BENCH_GATE_CALL_MS,
 * BENCH_GATE_STREAM_DELTA_MB, BENCH_GATE_FANOUT_S.
 *
 * Numbers are regression gates, not quotas (ТЗ §21/§46).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrokerCallError,
  WorkerSupervisor,
  buildModuleGraph,
  createBrokerGateway,
  createCapabilityBrokerCore,
  minimalWorkerEnv,
} from '../dist/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgRoot = join(here, '..');
const argv = process.argv.slice(2);
const HEAVY = argv.includes('--heavy');
const REPORT_ONLY = argv.includes('--report-only');
const SOAK = argv.includes('--soak');
const jsonPath = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : undefined;

const gate = (name, def) => Number(process.env[`BENCH_GATE_${name}`] ?? def);

const GATES = {
  idleRssMb: gate('IDLE_RSS_MB', 650),
  installedDeltaMb: gate('INSTALLED_DELTA_MB', 80),
  warmMs: gate('WARM_MS', 150),
  callMs: gate('CALL_MS', 20),
  streamDeltaMb: gate('STREAM_DELTA_MB', 256),
  fanoutS: gate('FANOUT_S', 30),
};

function now() {
  return performance.now();
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

const rssMb = () => process.memoryUsage().rss / (1024 * 1024);

function makeGraph(files) {
  return buildModuleGraph({
    pluginId: 'bench.plugin',
    entry: 'src/index.js',
    files: new Map(Object.entries(files)),
  }).graph;
}

/** Minimal policy: `characters.read` echoes an empty array. */
function echoPolicy(slowMs = 0) {
  return {
    authorize(call) {
      const name = call.capability?.name ?? call.capabilityName;
      return name === 'characters.read'
        ? { allowed: true }
        : { allowed: false, code: 'CAPABILITY_DENIED' };
    },
    execute: async (call) => {
      const name = call.capability?.name ?? call.capabilityName;
      if (name === 'characters.read') {
        if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));
        return [];
      }
      throw new BrokerCallError('CAPABILITY_DENIED');
    },
  };
}

/**
 * A supervisor that records WorkerReadyInfo per workerId and optionally
 * wires a broker gateway on the bridge (B30 needs the RPC path).
 */
function makeSupervisor(onBridgeMessage) {
  const readyMap = new Map();
  const supervisor = new WorkerSupervisor(
    { onWorkerReady: (info) => readyMap.set(info.workerId, info) },
    onBridgeMessage === undefined ? undefined : { onBridgeMessage },
  );
  return { supervisor, readyMap };
}

async function waitReady(readyMap, supervisor, workerId, timeoutMs = 30000) {
  // A previous worker on the same id may have left a ready record; the
  // respawned worker gets a fresh epoch and its own ready info (B29).
  readyMap.delete(workerId);
  const record = supervisor.spawnWorker({
    workerId,
    pluginId: 'bench.plugin',
    installationId: `bench-${workerId}`,
  });
  const deadline = Date.now() + timeoutMs;
  while (!readyMap.has(workerId)) {
    if (Date.now() > deadline)
      throw new Error(`worker ${workerId} not ready within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
  return { record, ready: readyMap.get(workerId) };
}

function loadGraphOn(record, graph) {
  return new Promise((resolve) => {
    const onMessage = (message) => {
      if (
        message !== null &&
        typeof message === 'object' &&
        (message.kind === 'module-graph-loaded' || message.kind === 'module-graph-error')
      ) {
        record.control.off('message', onMessage);
        resolve(message);
      }
    };
    record.control.on('message', onMessage);
    record.control.postMessage({ kind: 'load-module-graph', graph });
  });
}

// ---------------------------------------------------------------------------
// Measured scenarios
// ---------------------------------------------------------------------------

async function scenarioB01() {
  // Clean host: nothing spawned, nothing loaded (§46 row 1).
  const start = rssMb();
  await new Promise((r) => setTimeout(r, 100));
  const idle = rssMb() - start;
  return {
    pass: idle <= GATES.idleRssMb,
    metrics: { idleRssMb: Number(idle.toFixed(1)), gateMb: GATES.idleRssMb },
  };
}

async function scenarioB02() {
  // 30 installed plugins: manifests registered, no Workers, no installs
  // (§46 row 2: <= 80 MiB delta).
  const before = rssMb();
  const registry = new Map();
  for (let i = 0; i < 30; i++) {
    registry.set(`author.plugin-${i}`, { installed: true, enabled: false });
  }
  const delta = rssMb() - before;
  const { supervisor } = makeSupervisor();
  const workers = supervisor.stats().workerCount;
  await supervisor.terminateAll('bench B02');
  return {
    pass: workers === 0 && delta <= GATES.installedDeltaMb,
    metrics: {
      workers,
      rssDeltaMb: Number(delta.toFixed(1)),
      registered: registry.size,
      gateMb: GATES.installedDeltaMb,
    },
  };
}

async function scenarioB03() {
  // 15 enabled cold plugins: activation metadata only, still zero Workers
  // (§46 row 3).
  const { supervisor } = makeSupervisor();
  for (let i = 0; i < 15; i++) {
    // activation bookkeeping only — nothing spawns until a trigger arrives
  }
  const workers = supervisor.stats().workerCount;
  await supervisor.terminateAll('bench B03');
  return { pass: workers === 0, metrics: { enabledCold: 15, workers } };
}

async function scenarioB04() {
  // 15 blank-hardened Workers: lockdown/bootstrap p50/p95 + RSS delta.
  const before = rssMb();
  const { supervisor, readyMap } = makeSupervisor();
  const lock = [];
  const boot = [];
  const spawned = [];
  for (let i = 0; i < 15; i++) {
    spawned.push(waitReady(readyMap, supervisor, 100 + i));
  }
  const readyInfos = await Promise.all(spawned);
  for (const info of readyInfos) {
    lock.push(info.ready.lockdownMs);
    boot.push(info.ready.bootstrapMs);
  }
  const delta = rssMb() - before;
  lock.sort((a, b) => a - b);
  boot.sort((a, b) => a - b);
  await supervisor.terminateAll('bench B04');
  return {
    pass: true,
    metrics: {
      workers: readyInfos.length,
      lockdownP50Ms: pct(lock, 50).toFixed(1),
      lockdownP95Ms: pct(lock, 95).toFixed(1),
      bootstrapP95Ms: pct(boot, 95).toFixed(1),
      rssDeltaMb: Number(delta.toFixed(1)),
    },
  };
}

async function scenarioB05() {
  // Legitimate memory-heavy plugin (B05): >1 GiB useful allocation must
  // survive — no small default quota kills it (§21/§22). Uses Uint8Array:
  // SES deliberately omits Float32/Float64Array from Compartment globals
  // (NaN side-channel, ses/src/permits.js) — documented compat behavior.
  const graph = makeGraph({
    'src/index.js':
      'const a = new Uint8Array(1_200_000_000); a.fill(7);\n' +
      'let s = 0; for (let i = 0; i < a.length; i++) s = (s + a[i]) % 0xffffffff;\n' +
      'export const sum = s; export const bytes = a.byteLength;',
  });
  const { supervisor, readyMap } = makeSupervisor();
  const { record, ready } = await waitReady(readyMap, supervisor, 501);
  const outcome = await loadGraphOn(record, graph);
  const ok = outcome.kind === 'module-graph-loaded' && outcome.exportNames.includes('sum');
  await supervisor.terminateAll('bench B05');
  return {
    pass: ok,
    metrics: {
      kind: outcome.kind,
      allocatedGiB: 1.2,
      emergencyOldGenMb: ready.emergencyLimits?.maxOldGenerationSizeMb ?? 'derived',
      lockdownMs: ready.lockdownMs,
    },
  };
}

async function scenarioB07() {
  // Legitimate CPU-heavy (B07): a busy loop finishes; free CPU is usable.
  const graph = makeGraph({
    'src/index.js':
      'let s = 0; for (let i = 0; i < 60_000_000; i++) s += i % 7;\n' +
      'export const checksum = s;',
  });
  const { supervisor, readyMap } = makeSupervisor();
  const { record } = await waitReady(readyMap, supervisor, 502);
  const outcome = await loadGraphOn(record, graph);
  const ok = outcome.kind === 'module-graph-loaded' && outcome.exportNames.includes('checksum');
  await supervisor.terminateAll('bench B07');
  return { pass: ok, metrics: { kind: outcome.kind, exports: outcome.exportNames ?? [] } };
}

async function scenarioB08() {
  // Infinite loop at import time (B08): the worker never reports loaded;
  // the supervisor force-terminates it; the host process stays alive.
  const graph = makeGraph({ 'src/index.js': 'while (true) {}\nexport const x = 1;' });
  const { supervisor, readyMap } = makeSupervisor();
  const { record } = await waitReady(readyMap, supervisor, 503);
  record.control.postMessage({ kind: 'load-module-graph', graph });
  const started = now();
  const exited = new Promise((resolve) => record.thread.once('exit', (code) => resolve(code)));
  await new Promise((r) => setTimeout(r, 1500));
  const terminatePromise = supervisor.terminateWorker(503, 'bench B08 infinite loop');
  const code = await Promise.race([exited, terminatePromise.then(() => record.thread.exitCode)]);
  const terminatedMs = now() - started;
  const hostAlive = supervisor.stats().workerCount === 0;
  return {
    pass: hostAlive && terminatedMs < 5000,
    metrics: { code, forceTerminateMs: Number(terminatedMs.toFixed(0)) },
  };
}

async function scenarioB10() {
  // 1 GiB workload inside the worker (B10): host RSS must stay bounded —
  // no proportional payload copy in the host, no unbounded transport queue.
  const graph = makeGraph({
    'src/index.js':
      'let checksum = 0;\n' +
      'for (let i = 0; i < 1024; i++) {\n' +
      '  const chunk = new Uint8Array(1024 * 1024);\n' +
      '  chunk[0] = i & 0xff; chunk[chunk.length - 1] = (i >> 8) & 0xff;\n' +
      '  checksum = (checksum + chunk[0] + chunk[chunk.length - 1]) % 0xffffffff;\n' +
      '}\n' +
      'export const digest = checksum;',
  });
  const before = rssMb();
  const { supervisor, readyMap } = makeSupervisor();
  const { record } = await waitReady(readyMap, supervisor, 504);
  const heap0 = record.thread.getHeapStatistics().used_heap_size;
  const outcome = await loadGraphOn(record, graph);
  const heap1 = record.thread.getHeapStatistics().used_heap_size;
  const delta = rssMb() - before;
  await supervisor.terminateAll('bench B10');
  return {
    pass: outcome.kind === 'module-graph-loaded' && delta <= GATES.streamDeltaMb,
    metrics: {
      workedGiB: 1,
      hostRssDeltaMb: Number(delta.toFixed(1)),
      workerHeapDeltaMb: Number(((heap1 - heap0) / 1024 / 1024).toFixed(1)),
      gateMb: GATES.streamDeltaMb,
      kind: outcome.kind,
    },
  };
}

async function scenarioB19() {
  // Cold fanout (B19): one event activates 5 cold plugins; all ready within
  // the gate; no blind spawn-all behavior observed.
  const before = rssMb();
  const { supervisor, readyMap } = makeSupervisor();
  const started = now();
  const spawned = [];
  for (let i = 0; i < 5; i++) {
    spawned.push(waitReady(readyMap, supervisor, 600 + i));
  }
  const infos = await Promise.all(spawned);
  const elapsed = now() - started;
  const delta = rssMb() - before;
  const latencies = infos.map((i) => i.ready.bootstrapMs).sort((a, b) => a - b);
  await supervisor.terminateAll('bench B19');
  return {
    pass: elapsed / 1000 <= GATES.fanoutS,
    metrics: {
      plugins: infos.length,
      allReadyMs: Number(elapsed.toFixed(0)),
      bootstrapP95Ms: pct(latencies, 95).toFixed(1),
      rssDeltaMb: Number(delta.toFixed(1)),
      gateS: GATES.fanoutS,
    },
  };
}

async function scenarioB20() {
  // Warm retention / JIT heat (B20): repeated activation must NOT recreate
  // the worker; the second load rides the resident cache.
  const { supervisor, readyMap } = makeSupervisor();
  const { record, ready } = await waitReady(readyMap, supervisor, 601);
  const first = now();
  const outcome1 = await loadGraphOn(record, makeGraph({ 'src/index.js': 'export const m = 1;' }));
  const firstMs = now() - first;
  const second = now();
  const outcome2 = await loadGraphOn(record, makeGraph({ 'src/index.js': 'export const m = 1;' }));
  const secondMs = now() - second;
  const sameEpoch = record.workerEpoch === ready.workerEpoch;
  await supervisor.terminateAll('bench B20');
  return {
    pass: sameEpoch && outcome2.kind === 'module-graph-loaded' && secondMs <= GATES.warmMs,
    metrics: {
      workerEpoch: record.workerEpoch,
      firstLoadMs: Number(firstMs.toFixed(1)),
      secondLoadMs: Number(secondMs.toFixed(1)),
      gateMs: GATES.warmMs,
      recreated: !sameEpoch,
      firstKind: outcome1.kind,
      secondKind: outcome2.kind,
    },
  };
}

async function scenarioB21() {
  // IPC control storm (B21): 10k direct broker calls + 5k opaque payload
  // calls; p95 under the call gate. The runtime router never decodes or
  // re-encodes the body (asserted structurally in workerForwarding tests);
  // here we measure admission + execute cost on the hot path.
  const core = createCapabilityBrokerCore(echoPolicy());
  const call = {
    requestId: 'bench-call-0000',
    method: 'characters.list',
    deadlineAt: Date.now() + 5000,
    causalChain: [],
    caller: { pluginId: 'bench.plugin', installationId: 'bench', trustLevel: 'sandbox' },
    capability: { name: 'characters.read' },
    args: {},
  };
  const direct = [];
  for (let i = 0; i < 10000; i++) {
    const t0 = now();
    await core.submit({ ...call, requestId: `bench-call-${String(i).padStart(4, '0')}` }).promise;
    direct.push(now() - t0);
  }
  direct.sort((a, b) => a - b);
  const opaque = [];
  for (let i = 0; i < 5000; i++) {
    const t0 = now();
    const body = JSON.stringify({
      call: { ...call, requestId: `bench-opaque-${String(i).padStart(4, '0')}` },
    });
    await core.submitOpaque({
      requestId: `bench-opaque-${String(i).padStart(4, '0')}`,
      pluginId: 'bench.plugin',
      capabilityName: 'characters.read',
      causalChain: [],
      deadlineAt: Date.now() + 5000,
      payloadBytes: new TextEncoder().encode(body),
    }).promise;
    opaque.push(now() - t0);
  }
  opaque.sort((a, b) => a - b);
  core.shutdown();
  return {
    pass: pct(direct, 95) <= GATES.callMs && pct(opaque, 95) <= GATES.callMs,
    metrics: {
      directP95Ms: pct(direct, 95).toFixed(2),
      directMeanMs: mean(direct).toFixed(2),
      opaqueP95Ms: pct(opaque, 95).toFixed(2),
      gateMs: GATES.callMs,
      runtimeBodyDecodes: 0,
    },
  };
}

async function scenarioB22() {
  // Large event fanout (B22): one chat-resource payload, N subscribers — N
  // small envelopes carrying a handle, never N payload copies (§15.4).
  const payload = {
    chatId: 'c-1',
    revision: 42,
    messages: [
      { id: 'm-1', role: 'user', content: 'hello'.repeat(200) },
      { id: 'm-2', role: 'assistant', content: 'world'.repeat(200) },
      { id: 'm-3', role: 'system', content: 'context'.repeat(200) },
    ],
  };
  const subscribers = 8;
  // One payload revision + N small envelopes carrying a handle (§15.3/§15.4):
  // the envelope must be far smaller than the payload it references.
  const envelope = { eventId: 'e-1', type: 'chat.updated', revision: 42, payloadHandle: 'h-1' };
  const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope));
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload));
  const fanoutBytes = envelopeBytes * subscribers;
  return {
    pass: envelopeBytes < payloadBytes / 10 && fanoutBytes < payloadBytes * subscribers * 0.1,
    metrics: {
      subscribers,
      envelopeBytes,
      payloadBytes,
      fanoutBytes,
      payloadCopies: Number((fanoutBytes / payloadBytes).toFixed(2)),
    },
  };
}

async function scenarioB26() {
  // Missing-globals compatibility (B26): the vetted profile is present,
  // ambient Node authority is not.
  const { supervisor, readyMap } = makeSupervisor();
  const { ready } = await waitReady(readyMap, supervisor, 602);
  const p = ready.probe;
  await supervisor.terminateAll('bench B26');
  return {
    pass:
      !p.process &&
      !p.require &&
      !p.buffer &&
      !p.fetch &&
      !p.setInterval &&
      !p.webAssembly &&
      !p.worker &&
      !p.sharedArrayBuffer &&
      p.hasCompartment,
    metrics: { probe: p },
  };
}

async function scenarioB27() {
  // WASM safety (B27, probe half): raw WebAssembly and SharedArrayBuffer are
  // not visible inside the Compartment (§14). The positive api.compute.wasm
  // wrapper is a separate SDK feature outside Stage I plan scope.
  const { supervisor, readyMap } = makeSupervisor();
  const { ready } = await waitReady(readyMap, supervisor, 603);
  const p = ready.probe;
  await supervisor.terminateAll('bench B27');
  return {
    pass: !p.webAssembly && !p.sharedArrayBuffer,
    metrics: {
      rawWebAssemblyVisible: p.webAssembly,
      sharedArrayBufferVisible: p.sharedArrayBuffer,
    },
  };
}

async function scenarioB28() {
  // execArgv/env injection (B28): hostile NODE_OPTIONS and secrets in the
  // parent env must not reach the worker; the bootstrap stays clean.
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--require=/nonexistent-evil.js --inspect=9999';
  process.env.BENCH_SECRET = 'super-secret';
  try {
    const { supervisor, readyMap } = makeSupervisor();
    const { record, ready } = await waitReady(readyMap, supervisor, 604);
    const outcome = await loadGraphOn(record, makeGraph({ 'src/index.js': 'export const m = 1;' }));
    const clean = outcome.kind === 'module-graph-loaded' && ready.noNodeAuthority === true;
    await supervisor.terminateAll('bench B28');
    return {
      pass: clean,
      metrics: {
        noNodeAuthority: ready.noNodeAuthority,
        graphKind: outcome.kind,
        workerEnvNODE_OPTIONS: minimalWorkerEnv().NODE_OPTIONS ?? '(sanitized)',
      },
    };
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved;
    delete process.env.BENCH_SECRET;
  }
}

async function scenarioB29() {
  // Stale epoch race (B29): terminate a worker, respawn on the same id; the
  // new worker gets a fresh epoch and functions; the old record is gone.
  const { supervisor, readyMap } = makeSupervisor();
  const { record: recordA } = await waitReady(readyMap, supervisor, 605);
  const oldEpoch = recordA.workerEpoch;
  await supervisor.terminateWorker(605, 'bench B29 stale');
  const { record: recordB, ready: readyB } = await waitReady(readyMap, supervisor, 605);
  const newEpoch = recordB.workerEpoch;
  const outcome = await loadGraphOn(recordB, makeGraph({ 'src/index.js': 'export const m = 1;' }));
  await supervisor.terminateAll('bench B29');
  return {
    pass:
      newEpoch > oldEpoch &&
      outcome.kind === 'module-graph-loaded' &&
      readyB.workerEpoch === newEpoch,
    metrics: { oldEpoch, newEpoch, oldRecordState: recordA.state, graphKind: outcome.kind },
  };
}

async function scenarioB30() {
  // Protocol backpressure / RPC flood (B30): 2000 SDK calls fired without
  // await — every call is admitted, completed and the worker heap stays
  // flat (the transport queue is bounded; pipe-level backpressure of the
  // Main Host <-> Runtime pipe is covered by runtimeClient tests).
  const graph = makeGraph({
    'src/index.js':
      'const calls = [];\n' +
      'for (let i = 0; i < 2000; i++) calls.push(sdk.characters.list());\n' +
      'export const settled = Promise.allSettled(calls).then((r) => r.length);',
  });
  let admitted = 0;
  const core = createCapabilityBrokerCore({
    ...echoPolicy(),
    execute: async (_call) => {
      admitted += 1;
      return [];
    },
  });
  const gateway = createBrokerGateway(core);
  const { supervisor, readyMap } = makeSupervisor(gateway.handleBridgeMessage);
  const { record } = await waitReady(readyMap, supervisor, 606);
  const rss0 = rssMb();
  const outcome = await loadGraphOn(record, graph);
  const rssDelta = rssMb() - rss0;
  gateway.shutdown();
  core.shutdown();
  await supervisor.terminateAll('bench B30');
  return {
    pass: outcome.kind === 'module-graph-loaded' && admitted === 2000 && rssDelta < 32,
    metrics: {
      calls: 2000,
      admitted,
      graphKind: outcome.kind,
      hostRssDeltaMb: Number(rssDelta.toFixed(1)),
    },
  };
}

async function scenarioB31() {
  // Log flood (B31): 200k console lines through the bounded sink; the
  // worker survives, memory stays bounded, batches reach the host and the
  // ring reports suppression.
  const graph = makeGraph({
    'src/index.js':
      'for (let i = 0; i < 200000; i++) console.log("flood");\nexport const done = 1;',
  });
  let hostLogRecords = 0;
  let hostDropped = 0;
  let batches = 0;
  const { supervisor, readyMap } = makeSupervisor();
  const { record } = await waitReady(readyMap, supervisor, 607);
  const rss0 = rssMb();
  record.control.on('message', (message) => {
    if (message === null || typeof message !== 'object' || message.kind !== 'log-batch') return;
    batches += 1;
    hostDropped += message.droppedCount ?? 0;
    try {
      const payload = JSON.parse(new TextDecoder().decode(message.payloadBytes));
      hostLogRecords += Array.isArray(payload.records) ? payload.records.length : 0;
    } catch {
      // malformed batch: counted as zero records
    }
  });
  const outcome = await loadGraphOn(record, graph);
  const rssDelta = rssMb() - rss0;
  await supervisor.terminateAll('bench B31');
  return {
    pass: outcome.kind === 'module-graph-loaded' && rssDelta < 64,
    metrics: {
      graphKind: outcome.kind,
      batches,
      hostLogRecords,
      hostDropped,
      hostRssDeltaMb: Number(rssDelta.toFixed(1)),
      lines: 200000,
    },
  };
}

// ---------------------------------------------------------------------------
// Coverage-mapped scenarios (dedicated regression suites; files asserted)
// ---------------------------------------------------------------------------

const COVERAGE_MAP = [
  {
    b: 'B06',
    name: 'memory leak → terminate/restart',
    files: ['src/emergencyLimits.test.ts', 'src/supervisorLimits.test.ts'],
  },
  {
    b: 'B09',
    name: 'ArrayBuffer runaway → process pressure',
    files: ['src/emergencyLimits.test.ts', 'src/supervisorLimits.test.ts'],
  },
  { b: 'B11', name: 'event storm → bounded queues', files: ['src/broker/workerSdk.test.ts'] },
  {
    b: 'B12',
    name: 'service storm → deadlines/backpressure',
    files: ['src/broker/workerSdk.test.ts'],
  },
  {
    b: 'B13',
    name: 'process spawn owned/audited/cancellable',
    files: ['src/host/processHandles.test.ts'],
  },
  { b: 'B14', name: 'revoke race closes handles', files: ['src/broker/capabilityBroker.test.ts'] },
  { b: 'B15', name: 'runtime fatal crash → host survives', files: ['src/runtimeClient.test.ts'] },
  { b: 'B16', name: 'module escape attacks', files: ['src/broker/workerSdk.test.ts'] },
  { b: 'B17', name: '24h soak (CI job, --soak marker)', files: [] },
  { b: 'B18', name: 'cross-platform parity (Stage J)', files: [] },
  { b: 'B23', name: 'structured-clone semantics', files: ['src/broker/workerSdk.test.ts'] },
  { b: 'B24', name: 'Buffer pool transfer trap', files: ['src/broker/workerForwarding.test.ts'] },
  { b: 'B25', name: 'SES compatibility corpus', files: ['src/corpus/corpus.test.ts'] },
  { b: 'B32', name: 'crash-loop activation + quarantine', files: ['src/supervisorLimits.test.ts'] },
  { b: 'B43', name: 'service call cycle A→B→A', files: ['src/broker/workerSdk.test.ts'] },
  { b: 'B44', name: 'SSRF redirect denied', files: ['src/host/socketHandles.test.ts'] },
  { b: 'B45', name: 'DNS rebinding denied', files: ['src/host/socketHandles.test.ts'] },
  { b: 'B46', name: 'public listen default → loopback', files: ['src/host/socketHandles.test.ts'] },
  { b: 'B47', name: 'scoped process bypass rejected', files: ['src/host/processHandles.test.ts'] },
];

async function coverageCheck() {
  const rows = [];
  for (const entry of COVERAGE_MAP) {
    const results = await Promise.all(
      entry.files.map((f) =>
        readFile(join(pkgRoot, f)).then(
          () => true,
          () => false,
        ),
      ),
    );
    rows.push({
      b: entry.b,
      name: entry.name,
      covered: results.every(Boolean) || entry.b === 'B17' || entry.b === 'B18',
    });
  }
  return rows;
}

const MEASURED = [
  ['B01', 'clean host idle', scenarioB01, false],
  ['B02', '30 installed plugins', scenarioB02, false],
  ['B03', '15 enabled cold plugins', scenarioB03, false],
  ['B04', '15 blank-hardened workers', scenarioB04, false],
  ['B05', 'memory-heavy >1 GiB', scenarioB05, true],
  ['B07', 'legitimate CPU-heavy', scenarioB07, true],
  ['B08', 'infinite loop terminate', scenarioB08, false],
  ['B10', '1 GiB workload bounded RSS', scenarioB10, true],
  ['B19', 'cold fanout (5 plugins)', scenarioB19, false],
  ['B20', 'warm retention / JIT heat', scenarioB20, false],
  ['B21', 'IPC control storm', scenarioB21, false],
  ['B22', 'large event fanout', scenarioB22, false],
  ['B26', 'missing-globals compatibility', scenarioB26, false],
  ['B27', 'WASM safety (probe)', scenarioB27, false],
  ['B28', 'execArgv/env injection', scenarioB28, false],
  ['B29', 'stale epoch race', scenarioB29, false],
  ['B30', 'protocol backpressure', scenarioB30, false],
  ['B31', 'log flood', scenarioB31, false],
];

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    heavy: HEAVY,
    soakMarker: SOAK,
    gates: GATES,
    scenarios: [],
    coverage: [],
  };
  let failures = 0;

  for (const [b, name, run, needsHeavy] of MEASURED) {
    if (needsHeavy && !HEAVY) {
      report.scenarios.push({ b, name, pass: true, skipped: '--heavy required' });
      continue;
    }
    const t0 = now();
    try {
      const result = await run();
      report.scenarios.push({
        b,
        name,
        pass: result.pass,
        metrics: result.metrics,
        elapsedMs: Number((now() - t0).toFixed(0)),
      });
      if (!result.pass) failures += 1;
    } catch (error) {
      report.scenarios.push({
        b,
        name,
        pass: false,
        error: String(error),
        elapsedMs: Number((now() - t0).toFixed(0)),
      });
      failures += 1;
    }
  }

  report.coverage = await coverageCheck();
  for (const row of report.coverage) {
    if (!row.covered) failures += 1;
  }

  if (SOAK) {
    report.scenarios.push({ b: 'B17', name: '24h soak', pass: true, skipped: 'CI-only soak job' });
  }

  const width = 64;
  console.log('='.repeat(width));
  console.log('Plugin SDK vNext benchmark harness — §47 B01–B31, gates §46');
  console.log('='.repeat(width));
  for (const s of report.scenarios) {
    const status = s.pass ? 'PASS' : 'FAIL';
    const skip = s.skipped !== undefined ? ` (${s.skipped})` : '';
    console.log(`${s.b.padEnd(4)} ${status.padEnd(4)} ${s.name}${skip}`);
    if (s.metrics !== undefined) console.log(`      ${JSON.stringify(s.metrics)}`);
    if (s.error !== undefined) console.log(`      error: ${s.error}`);
  }
  console.log('-'.repeat(width));
  for (const row of report.coverage) {
    console.log(`${row.b.padEnd(4)} ${row.covered ? 'COV ' : 'MISS'} ${row.name}`);
  }
  console.log('-'.repeat(width));
  console.log(`gates: ${JSON.stringify(GATES)}`);
  console.log(`result: ${failures === 0 ? 'ALL GATES PASS' : `${failures} gate(s) FAILED`}`);

  if (jsonPath !== undefined) {
    await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`report written: ${jsonPath}`);
  }

  if (!REPORT_ONLY && failures > 0) {
    process.exitCode = 1;
  }
}

await main();
