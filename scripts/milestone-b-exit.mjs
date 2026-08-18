#!/usr/bin/env node
/**
 * Machine-checkable Milestone B exit registry.
 *
 * `Milestone B = PASS` is forbidden until:
 *   - PERF-01…05 and PERF-11…22 each have an independent admissible PASS record
 *   - device-loss injection has physical evidence
 *   - known baseline failures are FIXED or explicitly WAIVED
 *
 * IMPLEMENTED host corpora are not PASS. PERF-15 is an independent physical
 * PASS of VisualSurfaceFrameIngress, not PluginVisualSurface.
 * Raw input-to-present p99 is a reference-device baseline, not a release budget.
 *
 *   node scripts/milestone-b-exit.mjs
 *   node scripts/milestone-b-exit.mjs --check
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RECORD_PATH = join(ROOT, 'docs', 'rfc', 'milestone-b-exit.json');
export const SCHEMA = 'milestone-b-exit/v1';
export const REQUIRED_PERF = [
  'PERF-01',
  'PERF-02',
  'PERF-03',
  'PERF-04',
  'PERF-05',
  'PERF-11',
  'PERF-12',
  'PERF-13',
  'PERF-14',
  'PERF-15',
  'PERF-16',
  'PERF-17',
  'PERF-18',
  'PERF-19',
  'PERF-20',
  'PERF-21',
  'PERF-22',
];
export const REQUIRED_BASELINE_IDS = [
  'prettier-mass-drift',
  'runtime-kernel.diagnostics_export_counts_generation_runs',
];
export const P99_ROLE = 'reference-device-baseline';
export const P99_NS = 20_646_128;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadRegistry(path = RECORD_PATH) {
  return readJson(path);
}

function fileExists(rel) {
  return typeof rel === 'string' && existsSync(join(ROOT, rel));
}

function evidenceStatus(criterion) {
  if (!criterion || typeof criterion !== 'object') {
    return { ok: false, reason: 'missing criterion object' };
  }
  if (criterion.status === 'PASS') {
    if (criterion.pass_requires) {
      return {
        ok: false,
        reason: `PASS is forbidden while pass_requires=${criterion.pass_requires}`,
      };
    }
    if (criterion.independent !== true || criterion.admissible !== true) {
      return { ok: false, reason: 'PASS requires independent admissible evidence' };
    }
    if (!fileExists(criterion.record)) {
      return { ok: false, reason: `missing evidence record ${criterion.record}` };
    }
    if (criterion.field) {
      const record = readJson(join(ROOT, criterion.record));
      if (record[criterion.field] !== 'PASS') {
        return {
          ok: false,
          reason: `${criterion.record} ${criterion.field}=${record[criterion.field]}`,
        };
      }
      if (record.milestone_b === 'PASS') {
        return { ok: false, reason: `${criterion.record} must not stamp Milestone B PASS` };
      }
    }
    return { ok: true };
  }
  return {
    ok: false,
    reason: `status=${criterion.status ?? 'undefined'} (not independent admissible PASS)`,
  };
}

export function evaluate(registry) {
  const failures = [];
  if (!registry || registry.schema !== SCHEMA) {
    failures.push(`schema must be ${SCHEMA}`);
  }
  if (registry?.almost_pass) {
    failures.push('almost_pass must be false');
  }
  if (registry?.production_cutover && registry.production_cutover !== 'NOT_STARTED') {
    failures.push('production_cutover must stay NOT_STARTED until B DoD');
  }
  const required = registry?.required_perf ?? [];
  for (const id of REQUIRED_PERF) {
    if (!required.includes(id)) {
      failures.push(`required_perf is missing ${id}`);
    }
    const check = evidenceStatus(registry?.criteria?.[id]);
    if (!check.ok) {
      failures.push(`${id}: ${check.reason}`);
    }
  }
  const deviceLoss = registry?.device_loss_injection;
  if (!deviceLoss?.physical) {
    failures.push(
      `device-loss injection is ${deviceLoss?.status ?? 'missing'}, physical evidence required`,
    );
  }
  const baselines = registry?.known_baseline_failures ?? [];
  for (const id of REQUIRED_BASELINE_IDS) {
    const row = baselines.find((item) => item.id === id);
    if (!row) {
      failures.push(`known baseline failure ${id} is not listed`);
      continue;
    }
    if (row.status === 'WAIVED') {
      if (!row.waiver || typeof row.waiver !== 'object') {
        failures.push(`${id} is WAIVED without an explicit waiver object`);
      }
    } else if (row.status !== 'FIXED') {
      failures.push(`${id} is ${row.status}, must be FIXED or explicitly WAIVED`);
    }
  }
  const p99Role = registry?.input_to_present_p99_role;
  if (p99Role !== P99_ROLE && !registry?.release_budget_calibration_adr) {
    failures.push('raw input-to-present p99 is not a release budget without a calibration ADR');
  }
  if (registry?.input_to_present_p99_ns !== P99_NS) {
    failures.push(`reference-device p99 must remain ${P99_NS} ns until a calibration ADR`);
  }

  const canPass = failures.length === 0;
  const declared = registry?.milestone_b;
  const ok = declared !== 'PASS' || canPass;
  if (declared === 'PASS' && !canPass) {
    failures.unshift('Milestone B = PASS is forbidden until every B-exit gate is green');
  }
  return {
    schema: SCHEMA,
    milestone_b: canPass && declared === 'PASS' ? 'PASS' : 'STARTED',
    declared: declared ?? null,
    almost_pass: false,
    production_cutover: 'NOT_STARTED',
    can_pass: canPass,
    ok,
    failures,
    perf15: registry?.perf15 ?? registry?.criteria?.['PERF-15']?.status ?? null,
    perf22: registry?.perf22 ?? registry?.criteria?.['PERF-22']?.status ?? null,
    platform_gesture_adapter: registry?.platform_gesture_adapter ?? null,
    reason: canPass
      ? 'Milestone B exit criteria are complete'
      : 'Milestone B remains STARTED; independent PERF evidence, physical device-loss, and baseline waivers are incomplete',
  };
}

export function evaluateFile(path = RECORD_PATH) {
  return evaluate(loadRegistry(path));
}

function main() {
  const result = evaluateFile();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (process.argv.includes('--check') && !result.ok) {
    process.exitCode = 1;
  }
  if (result.declared === 'PASS' && !result.can_pass) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
