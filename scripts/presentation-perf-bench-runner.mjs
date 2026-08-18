#!/usr/bin/env node
/**
 * Unified host runner for remaining Milestone B PERF items (PERF-01…05
 * and PERF-11…17/21). Does not require a phone to assemble. Does not stamp
 * Milestone B PASS. PERF-15 / PERF-18…20 / PERF-22 / device-loss stay on
 * their independent adjudicators.
 *
 *   node scripts/presentation-perf-bench-runner.mjs
 *   node scripts/presentation-perf-bench-runner.mjs --execute
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const REMAINING = [
  'PERF-01',
  'PERF-02',
  'PERF-03',
  'PERF-04',
  'PERF-05',
  'PERF-11',
  'PERF-12',
  'PERF-13',
  'PERF-14',
  'PERF-16',
  'PERF-17',
  'PERF-21',
];

const INDEPENDENT = {
  'PERF-15': 'docs/rfc/perf-15-adjudication.json',
  'PERF-18': 'docs/rfc/perf-18-20-adjudication.json',
  'PERF-19': 'docs/rfc/perf-18-20-adjudication.json',
  'PERF-20': 'docs/rfc/perf-18-20-adjudication.json',
  'PERF-22': 'docs/rfc/perf-22-adjudication.json',
  'device-loss': 'docs/rfc/device-loss-adjudication.json',
};

export const HOST_GROUPS = [
  {
    ids: ['PERF-03', 'PERF-04', 'PERF-05', 'PERF-11'],
    cargo: [
      'test',
      '--manifest-path',
      'crates/Cargo.toml',
      '-p',
      'neotavern-neocompositor',
      '--test',
      'effect_scope',
      '--test',
      'pressure',
      '--test',
      'm0_d1a_corpus',
    ],
    note: 'host glass/pressure/paint-order corpus; not a physical PASS',
  },
  {
    ids: ['PERF-12', 'PERF-13'],
    cargo: ['test', '--manifest-path', 'crates/Cargo.toml', '-p', 'neotavern-chat-viewport'],
    note: 'host virtualization / remap corpus; not a physical PASS',
  },
  {
    ids: ['PERF-14', 'PERF-17', 'PERF-21'],
    cargo: [
      'test',
      '--manifest-path',
      'crates/Cargo.toml',
      '-p',
      'neotavern-neocompositor',
      '--test',
      'hit_dispatch',
    ],
    note: 'host async hit-test corpus; not a physical PASS',
  },
];

const PHYSICAL_ONLY = {
  'PERF-01': '120 Hz 10k mixed-height chat scroll with Markdown/images/glass',
  'PERF-02': 'streaming Markdown coalesce on the 10k scroll fixture',
  'PERF-16': 'cold process start / first interactive chat frame',
};

export function plan() {
  return {
    schema: 'presentation-perf-bench-runner/v1',
    milestone_b: 'STARTED',
    almost_pass: false,
    production_cutover: 'NOT_STARTED',
    phone_required: false,
    remaining: REMAINING.map((id) => describeItem(id, { status: 'MISSING' })),
    independent: INDEPENDENT,
    note: 'Unified production-like runner for PERF-01…05 and PERF-11…17/21. Physical Xiaomi is not required to assemble this host plan. Host corpora are not independent PASS.',
  };
}

function describeItem(id, extra = {}) {
  const group = HOST_GROUPS.find((row) => row.ids.includes(id));
  return {
    id,
    status: extra.status ?? 'MISSING',
    runner: group ? 'host-production-like-bench' : 'physical-or-missing',
    note: extra.note ?? PHYSICAL_ONLY[id] ?? group?.note ?? null,
    exit_code: extra.exit_code ?? null,
  };
}

export function execute({ spawn = spawnSync } = {}) {
  const byId = Object.fromEntries(REMAINING.map((id) => [id, describeItem(id)]));
  const groups = [];
  for (const group of HOST_GROUPS) {
    const result = spawn('cargo', group.cargo, {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const status = result.status === 0 ? 'HOST_CORPUS' : 'HOST_FAIL';
    groups.push({
      ids: group.ids,
      note: group.note,
      exit_code: result.status,
      status,
    });
    for (const id of group.ids) {
      byId[id] = describeItem(id, {
        status,
        note: group.note,
        exit_code: result.status,
      });
    }
  }
  return {
    schema: 'presentation-perf-bench-runner/v1',
    milestone_b: 'STARTED',
    almost_pass: false,
    production_cutover: 'NOT_STARTED',
    phone_required: false,
    remaining: REMAINING.map((id) => byId[id]),
    independent: INDEPENDENT,
    groups,
    note: 'Host corpora ran. They are not independent PERF PASS and do not stamp Milestone B.',
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = process.argv.includes('--execute') ? execute() : plan();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (
    process.argv.includes('--execute') &&
    result.groups?.some((group) => group.status === 'HOST_FAIL')
  ) {
    process.exitCode = 1;
  }
}
