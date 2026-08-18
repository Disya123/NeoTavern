#!/usr/bin/env node
/**
 * Independent host adjudicators for remaining Milestone B PERF items
 * (PERF-01…05, 11–14, 16, 17, 21). Failure of one criterion never blocks
 * writing the others. Host corpora are not PASS. Does not stamp Milestone B.
 *
 *   node scripts/remaining-b-physical-adjudicate.mjs
 *   node scripts/remaining-b-physical-adjudicate.mjs --write
 *   node scripts/remaining-b-physical-adjudicate.mjs --write --id=PERF-01
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { parseKvLine } from './perf-18-20-adjudicate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const REMAINING_IDS = [
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

export const RECORD_PATHS = Object.fromEntries(
  REMAINING_IDS.map((id) => [
    id,
    join(ROOT, 'docs', 'rfc', `${id.toLowerCase()}-adjudication.json`),
  ]),
);

function flag(line, key, expected) {
  const parsed = parseKvLine(line || '', '');
  const body = String(line || '');
  const hit = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`, 'u').exec(body);
  const value = hit ? hit[1] : parsed.values[key];
  return {
    id: key,
    ok: expected === undefined ? Boolean(value) : String(value) === String(expected),
    value: value ?? null,
  };
}

function num(line, key) {
  const row = flag(line, key);
  const value = row.value == null ? null : Number(row.value);
  return { id: key, ok: Number.isFinite(value), value };
}

function allOk(checks) {
  return checks.every((row) => row.ok);
}

function physical(provenance, log) {
  return (
    provenance?.apk_linkage === 'BOUND' &&
    provenance?.evidence_dirty === false &&
    /ran_on_android=true/u.test(String(log || ''))
  );
}

function productPath(log) {
  return [
    flag(log, 'product_path', 'true'),
    flag(log, 'dioxus_shell', 'true'),
    flag(log, 'blitz_producer', 'true'),
    flag(log, 'wire_messages', '10000'),
    flag(log, 'direct_display_list_injection', 'false'),
  ];
}

function verdict(prefix, checks, isPhysical, reasonPass, reasonFail) {
  const ok = allOk(checks);
  let status = 'IMPLEMENTED';
  if (ok && isPhysical) status = 'PASS';
  else if (isPhysical) status = 'BLOCKED';
  return {
    schema: `${prefix}-adjudication/v1`,
    [prefix]: status,
    physical: Boolean(isPhysical && status === 'PASS'),
    admissible: status === 'PASS',
    independent: true,
    milestone_b: 'STARTED',
    almost_pass: false,
    production_cutover: 'NOT_STARTED',
    reason: status === 'PASS' ? reasonPass : reasonFail,
    checks,
  };
}

export function evaluatePerf01({ warmLog = '', coldLog = '', provenance = {} } = {}) {
  const warmTravel = num(warmLog, 'travel');
  const coldTravel = num(coldLog, 'travel');
  const checks = [
    ...productPath(warmLog),
    flag(warmLog, 'cache', 'warm'),
    flag(warmLog, 'compositor_only_frames', '7200'),
    { ...warmTravel, ok: warmTravel.ok && warmTravel.value > 1000 },
    flag(coldLog, 'cache', 'cold_near_range'),
    flag(coldLog, 'compositor_only_frames', '7200'),
    { ...coldTravel, id: 'cold_travel', ok: coldTravel.ok && coldTravel.value > 1000 },
    flag(coldLog, 'product_path', 'true'),
  ];
  return verdict(
    'perf01',
    checks,
    physical(provenance, `${warmLog}\n${coldLog}`),
    'physical product-path 60s warm and cold-near-range 120 Hz scroll',
    'PERF-01 stays IMPLEMENTED until warm+cold product-path physical logs are captured',
  );
}

export function evaluatePerf02({ log = '', provenance = {} } = {}) {
  const coalesced = num(log, 'coalesced');
  const stale = num(log, 'dropped_stale');
  const checks = [
    ...productPath(log),
    { ...coalesced, ok: coalesced.ok && coalesced.value >= 1 },
    flag(log, 'rebuilds_during_scroll', '0'),
    { id: 'dropped_stale', ok: stale.ok && stale.value >= 1, value: stale.value },
  ];
  return verdict(
    'perf02',
    checks,
    physical(provenance, log),
    'physical product-path streaming coalesce',
    'PERF-02 stays IMPLEMENTED until a physical streaming fixture is captured',
  );
}

function glassEval(prefix, minGlass, { log = '', xml = '', provenance = {} } = {}) {
  const surfaces = num(log, 'glass_surfaces');
  const checks = [
    ...productPath(log),
    { ...surfaces, ok: surfaces.ok && surfaces.value >= minGlass },
    {
      id: 'renderdoc_or_labels',
      ok: String(xml).includes(prefix) || String(log).includes(`labels=${prefix}`),
    },
  ];
  return verdict(
    prefix,
    checks,
    physical(provenance, log),
    `physical ${prefix} glass fixture`,
    `${prefix.toUpperCase()} stays IMPLEMENTED until a physical glass fixture is captured`,
  );
}

export function evaluatePerf03(input = {}) {
  return glassEval('perf03', 3, input);
}

export function evaluatePerf04(input = {}) {
  const result = glassEval('perf04', 3, input);
  const nested = flag(input.log, 'nested', 'true');
  result.checks = [...result.checks, nested];
  if (!allOk(result.checks) && result.perf04 === 'PASS') {
    result.perf04 = 'BLOCKED';
    result.admissible = false;
    result.physical = false;
    result.reason = 'PERF-04 nested glass check failed';
  }
  return result;
}

export function evaluatePerf05({ log = '', provenance = {} } = {}) {
  const checks = [
    ...productPath(log),
    flag(log, 'image_decode', 'true'),
    flag(log, 'image_upload', 'true'),
  ];
  return verdict(
    'perf05',
    checks,
    physical(provenance, log),
    'physical product-path image pressure',
    'PERF-05 stays IMPLEMENTED until a physical image-pressure fixture is captured',
  );
}

export function evaluatePerf11({ log = '', xml = '', provenance = {} } = {}) {
  const checks = [
    ...productPath(log),
    flag(log, 'wallpaper', 'true'),
    flag(log, 'nested_glass', 'true'),
    flag(log, 'overlay', 'true'),
    flag(log, 'acyclic', 'true'),
    {
      id: 'renderdoc_or_labels',
      ok: String(xml).includes('perf11') || String(log).includes('labels=perf11'),
    },
  ];
  return verdict(
    'perf11',
    checks,
    physical(provenance, log),
    'physical product-path paint-boundary order',
    'PERF-11 stays IMPLEMENTED until a physical paint-order fixture is captured',
  );
}

export function evaluatePerf12({ log = '', provenance = {} } = {}) {
  const travel = num(log, 'travel');
  const checks = [
    ...productPath(log),
    flag(log, 'cache', 'cold'),
    flag(log, 'compositor_only_frames', '7200'),
    { ...travel, ok: travel.ok && travel.value > 1000 },
    flag(log, 'blank_px', '0'),
    flag(log, 'waited_on_producer', 'false'),
    flag(log, 'predictive_trigger', 'true'),
  ];
  return verdict(
    'perf12',
    checks,
    physical(provenance, log),
    'physical adversarial 10k fling',
    'PERF-12 stays IMPLEMENTED until a physical adversarial fling is captured',
  );
}

export function evaluatePerf13({ log = '', provenance = {} } = {}) {
  const checks = [
    ...productPath(log),
    flag(log, 'reverse_blank', '0'),
    flag(log, 'teleport_blank', '0'),
    flag(log, 'prepend_blank', '0'),
    flag(log, 'stale_hit', 'false'),
  ];
  return verdict(
    'perf13',
    checks,
    physical(provenance, log),
    'physical reversal/teleport/prepend',
    'PERF-13 stays IMPLEMENTED until a physical remap fixture is captured',
  );
}

export function evaluatePerf14({ log = '', provenance = {} } = {}) {
  const checks = [
    ...productPath(log),
    flag(log, 'same_logical_target', 'true'),
    flag(log, 'wrong_message', 'false'),
    flag(log, 'unacked_delta_px', '500'),
  ];
  return verdict(
    'perf14',
    checks,
    physical(provenance, log),
    'physical async hit-test during unacked scroll',
    'PERF-14 stays IMPLEMENTED until a physical async hit-test fixture is captured',
  );
}

export function evaluatePerf16({ log = '', provenance = {} } = {}) {
  const samples = num(log, 'samples');
  const checks = [
    ...productPath(log),
    { ...samples, ok: samples.ok && samples.value >= 100 },
    flag(log, 'host_p99', 'none'),
    flag(log, 'contentful_p99'),
    flag(log, 'interaction_p99'),
  ];
  const contentful = flag(log, 'contentful_p99');
  const interaction = flag(log, 'interaction_p99');
  checks[checks.length - 2].ok = Boolean(contentful.value) && contentful.value !== 'none';
  checks[checks.length - 1].ok = Boolean(interaction.value) && interaction.value !== 'none';
  return verdict(
    'perf16',
    checks,
    physical(provenance, log),
    'physical cold pipeline with 100 split contentful/interaction samples',
    'PERF-16 stays IMPLEMENTED until >=100 physical samples exist (host p99 stays none)',
  );
}

export function evaluatePerf17({ log = '', provenance = {} } = {}) {
  const checks = [
    ...productPath(log),
    flag(log, 'sticky_frontmost', 'true'),
    flag(log, 'fixed_ignores_scroll', 'true'),
    flag(log, 'click_through', 'false'),
    flag(log, 'unacked_delta_px', '500'),
  ];
  return verdict(
    'perf17',
    checks,
    physical(provenance, log),
    'physical sticky/fixed async hit-test',
    'PERF-17 stays IMPLEMENTED until a physical sticky/fixed fixture is captured',
  );
}

export function evaluatePerf21({ log = '', provenance = {} } = {}) {
  const checks = [
    ...productPath(log),
    flag(log, 'distinct_scroll_ids', 'true'),
    flag(log, 'latch_inner', 'true'),
    flag(log, 'kept_inner', 'true'),
    flag(log, 'handoff_outer', 'true'),
    flag(log, 'no_double_apply', 'true'),
  ];
  return verdict(
    'perf21',
    checks,
    physical(provenance, log),
    'physical nested scroll latch/handoff',
    'PERF-21 stays IMPLEMENTED until a physical nested-scroll fixture is captured',
  );
}

const EVALUATORS = {
  'PERF-01': evaluatePerf01,
  'PERF-02': evaluatePerf02,
  'PERF-03': evaluatePerf03,
  'PERF-04': evaluatePerf04,
  'PERF-05': evaluatePerf05,
  'PERF-11': evaluatePerf11,
  'PERF-12': evaluatePerf12,
  'PERF-13': evaluatePerf13,
  'PERF-14': evaluatePerf14,
  'PERF-16': evaluatePerf16,
  'PERF-17': evaluatePerf17,
  'PERF-21': evaluatePerf21,
};

export function adjudicateRemaining(input = {}) {
  const results = {};
  for (const id of REMAINING_IDS) {
    const key = id.toLowerCase().replace('-', '');
    results[key] = EVALUATORS[id](input[key] ?? input[id] ?? {});
  }
  return {
    milestone_b: 'STARTED',
    almost_pass: false,
    production_cutover: 'NOT_STARTED',
    ...results,
  };
}

export function writeRemaining(result, { write = false, only = null } = {}) {
  const written = [];
  for (const id of REMAINING_IDS) {
    if (only && only !== id) continue;
    const key = id.toLowerCase().replace('-', '');
    const path = RECORD_PATHS[id];
    const body = result[key];
    try {
      if (write) {
        writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
      }
      written.push({ path, id, status: body[key], ok: true });
    } catch (err) {
      written.push({ path, id, ok: false, error: String(err) });
    }
  }
  return written;
}

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((part) => part.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function readIf(path) {
  return path && existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function main() {
  const write = process.argv.includes('--write');
  const only = argValue('id');
  const provenance = {
    apk_linkage: argValue('apk-linkage') ?? 'UNBOUND',
    evidence_dirty: argValue('evidence-dirty') === 'true',
  };
  if (argValue('evidence-dirty') === 'false') provenance.evidence_dirty = false;
  const input = {
    perf01: {
      warmLog: readIf(argValue('perf01-warm-log')),
      coldLog: readIf(argValue('perf01-cold-log')),
      provenance,
    },
    perf02: { log: readIf(argValue('perf02-log')), provenance },
    perf03: {
      log: readIf(argValue('perf03-log')),
      xml: readIf(argValue('perf03-xml')),
      provenance,
    },
    perf04: {
      log: readIf(argValue('perf04-log')),
      xml: readIf(argValue('perf04-xml')),
      provenance,
    },
    perf05: { log: readIf(argValue('perf05-log')), provenance },
    perf11: {
      log: readIf(argValue('perf11-log')),
      xml: readIf(argValue('perf11-xml')),
      provenance,
    },
    perf12: { log: readIf(argValue('perf12-log')), provenance },
    perf13: { log: readIf(argValue('perf13-log')), provenance },
    perf14: { log: readIf(argValue('perf14-log')), provenance },
    perf16: { log: readIf(argValue('perf16-log')), provenance },
    perf17: { log: readIf(argValue('perf17-log')), provenance },
    perf21: { log: readIf(argValue('perf21-log')), provenance },
  };
  const result = adjudicateRemaining(input);
  const written = writeRemaining(result, { write, only });
  process.stdout.write(`${JSON.stringify({ result, written }, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
