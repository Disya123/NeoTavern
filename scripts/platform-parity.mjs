/**
 * Cross-platform parity recorder (Stage J, B18).
 *
 * Runs the IDENTICAL conformance smoke on every supported OS/arch and
 * records the platform report (conformance booleans + cold-start p50/p95):
 *
 *   node scripts/platform-parity.mjs [--out platform-parity-<os>-<arch>.json]
 *
 * The runtime's own conformance suite (vitest) is platform-agnostic — this
 * script exists so the SAME smoke + cold-start measurements are recorded on
 * Linux x64/arm64, Windows x64/arm64 and macOS x64/arm64 (§46 "NeoTavern records
 * them on every supported platform"). CI runs it on each target and keeps
 * the reports; a platform whose report diverges (e.g. noNodeAuthority
 * flips, graph fails, call fails) fails Stage J/B18.
 *
 * OS differences are allowed only at the host-adapter level (§44: path
 * normalization, process executable paths, signals, filesystem semantics) —
 * the smoke below contains none of those, so it must behave identically.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrokerCallError,
  WorkerSupervisor,
  buildModuleGraph,
  createBrokerGateway,
  createCapabilityBrokerCore,
} from '../apps/plugin-runtime/dist/index.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function versionOf(name) {
  try {
    return JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'))
      .version;
  } catch {
    return 'unknown';
  }
}

async function spawnBlank(supervisor, readyMap, workerId) {
  const record = supervisor.spawnWorker({
    workerId,
    pluginId: 'parity.plugin',
    installationId: `parity-${workerId}`,
  });
  const deadline = Date.now() + 30000;
  while (!readyMap.has(workerId)) {
    if (Date.now() > deadline) throw new Error(`worker ${workerId} not ready`);
    await new Promise((r) => setTimeout(r, 10));
  }
  return { record, ready: readyMap.get(workerId) };
}

async function main() {
  const { platform, arch } = process;
  const gate = (name, def) => Number(process.env[`PARITY_GATE_${name}`] ?? def);
  const gates = {
    warmP95Ms: gate('WARM_P95_MS', 150),
    coldP95Ms: gate('COLD_P95_MS', 5000),
  };

  // --- conformance smoke (identical on all platforms) ---------------------
  const readyMap = new Map();
  const supervisor = new WorkerSupervisor({
    onWorkerReady: (info) => readyMap.set(info.workerId, info),
  });

  // Cold-start p50/p95: 5 blank-hardened spawns, one at a time.
  const boot = [];
  for (let i = 0; i < 5; i++) {
    const { ready } = await spawnBlank(supervisor, readyMap, 700 + i);
    boot.push(ready.bootstrapMs);
  }
  boot.sort((a, b) => a - b);
  const pct = (p) => boot[Math.min(boot.length - 1, Math.floor((p / 100) * boot.length))];

  // Graph load: the same minimal graph as the bench harness.
  const graph = buildModuleGraph({
    pluginId: 'parity.plugin',
    entry: 'src/index.js',
    files: new Map([['src/index.js', 'export const marker = "parity";']]),
  }).graph;
  const { record, ready } = await spawnBlank(supervisor, readyMap, 705);
  const graphOutcome = await new Promise((resolve) => {
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

  // Broker round-trip: one echo call through the gateway.
  const policy = {
    authorize: (call) =>
      call.capability?.name === 'characters.read'
        ? { allowed: true }
        : { allowed: false, code: 'CAPABILITY_DENIED' },
    execute: async (call) => {
      if (call.capability?.name === 'characters.read') return ['ok'];
      throw new BrokerCallError('CAPABILITY_DENIED');
    },
  };
  const core = createCapabilityBrokerCore(policy);
  const gateway = createBrokerGateway(core);
  const callStart = performance.now();
  const callResult = await core.submit({
    requestId: 'parity-call-0001',
    method: 'characters.list',
    deadlineAt: Date.now() + 5000,
    causalChain: [],
    caller: { pluginId: 'parity.plugin', installationId: 'parity', trustLevel: 'sandbox' },
    capability: { name: 'characters.read' },
    args: {},
  }).promise;
  const callMs = performance.now() - callStart;
  gateway.shutdown();
  core.shutdown();

  // Warm activation: reload the same graph on the resident worker.
  const warmStart = performance.now();
  const warmOutcome = await new Promise((resolve) => {
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
  const warmMs = performance.now() - warmStart;
  await supervisor.terminateAll('parity done');

  // --- report --------------------------------------------------------------
  const report = {
    generatedAt: new Date().toISOString(),
    platform,
    arch,
    node: process.version,
    ses: versionOf('ses'),
    '@endo/module-source': versionOf('@endo/module-source'),
    conformance: {
      lockdownBeforePluginCode: ready.lockdownMs > 0 && ready.compartmentMs > 0,
      noNodeAuthority: ready.noNodeAuthority === true,
      graphLoaded: graphOutcome.kind === 'module-graph-loaded',
      brokerCallOk: JSON.stringify(callResult) === JSON.stringify(['ok']),
      warmActivationOk: warmOutcome.kind === 'module-graph-loaded',
    },
    measurements: {
      coldBootstrapP50Ms: pct(50).toFixed(1),
      coldBootstrapP95Ms: pct(95).toFixed(1),
      brokerCallMs: callMs.toFixed(2),
      warmLoadMs: warmMs.toFixed(1),
    },
    gates,
  };
  report.allPass =
    Object.values(report.conformance).every(Boolean) &&
    Number(report.measurements.coldBootstrapP95Ms) <= gates.coldP95Ms &&
    Number(report.measurements.warmLoadMs) <= gates.warmP95Ms;

  const outPath = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : `platform-parity-${platform}-${arch}.json`;
  await writeFile(join(root, outPath), JSON.stringify(report, null, 2), 'utf8');

  console.log(`platform parity report: ${outPath}`);
  console.log(`  platform: ${platform}/${arch}, node ${process.version}`);
  console.log(`  conformance: ${JSON.stringify(report.conformance)}`);
  console.log(
    `  measurements: cold p50 ${report.measurements.coldBootstrapP50Ms} ms, ` +
      `cold p95 ${report.measurements.coldBootstrapP95Ms} ms, ` +
      `broker call ${report.measurements.brokerCallMs} ms, warm load ${report.measurements.warmLoadMs} ms`,
  );
  console.log(`  result: ${report.allPass ? 'PARITY OK' : 'PARITY FAIL'}`);
  if (!report.allPass && !process.argv.includes('--report-only')) {
    process.exitCode = 1;
  }
}

import { readFileSync } from 'node:fs';

await main();
