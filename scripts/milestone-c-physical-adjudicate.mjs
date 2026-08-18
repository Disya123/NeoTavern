#!/usr/bin/env node
/**
 * Independent host adjudicator for the Milestone C physical journey batch.
 * Never stamps RFC §51 Milestone C PASS or production cutover.
 *
 *   node scripts/milestone-c-physical-adjudicate.mjs --evidence=apps/android/milestone-c-captures/STAMP-evidence.json
 *   node scripts/milestone-c-physical-adjudicate.mjs --write --evidence=...
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { REQUIRED_SERIAL } from './milestone-c-physical-capture.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RECORD_PATH = join(ROOT, 'docs', 'rfc', 'milestone-c-adjudication.json');

const REQUIRED = ['flag_off', 'live_open', 'jni_mapped', 'launcher_untouched', 'safe_mode'];

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((part) => part.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function row(evidence, name) {
  return (evidence.results || []).find((item) => item.journey === name) || null;
}

function jniOk(evidence) {
  const mapped = row(evidence, 'jni_mapped');
  const live = row(evidence, 'live_open');
  return Boolean(mapped?.ok || live?.ok);
}

export function adjudicateMilestoneC(evidence, log = '', previous = null) {
  const serialOk = evidence?.serial === REQUIRED_SERIAL;
  const emulator = Boolean(evidence?.emulator);
  const checks = REQUIRED.map((name) => {
    const item = row(evidence, name);
    if (name === 'jni_mapped') {
      return { id: name, ok: jniOk(evidence), value: item };
    }
    return { id: name, ok: Boolean(item?.ok), value: item };
  });
  const live = row(evidence, 'live_open');
  const send = row(evidence, 'send');
  const sendPersisted =
    typeof send?.after?.count === 'number' &&
    send.after.count > (live?.messageCount ?? 0);
  const reopen = row(evidence, 'reopen');
  const reopenOk =
    typeof reopen?.after?.count === 'number'
      ? reopen.after.count > (live?.messageCount ?? 0)
      : Boolean(reopen?.ok);
  const optional = ['a11y_semantics', 'send', 'reopen', 'rotate', 'background', 'ime'].map(
    (name) => {
      const item = row(evidence, name);
      if (name === 'send') {
        return { id: name, ok: sendPersisted, value: item };
      }
      if (name === 'reopen') {
        return { id: name, ok: reopenOk, value: item };
      }
      return { id: name, ok: Boolean(item?.ok), value: item };
    },
  );
  const liveLine = String(log || '');
  const cutoverOff =
    /production_cutover=false/u.test(liveLine) ||
    evidence?.production_cutover === 'NOT_STARTED';
  const canaryOff = evidence?.canary === false;
  const physical = serialOk && !emulator;
  const requiredOk = checks.every((item) => item.ok);
  const journeyBatch =
    physical && requiredOk && sendPersisted && cutoverOff && canaryOff ? 'PASS' : 'FAIL';
  const record = {
    schema: 'milestone-c-adjudication/v1',
    milestone_c: 'STARTED',
    journey_batch: journeyBatch,
    almost_pass: false,
    production_cutover: 'NOT_STARTED',
    canary: false,
    physical,
    admissible: physical && requiredOk,
    serial: evidence?.serial ?? null,
    capture_stamp: evidence?.stamp ?? null,
    apk_sha256: evidence?.apk_sha256 ?? null,
    source_commit: evidence?.source_commit ?? null,
    production_jni_untouched: evidence?.production_jni_untouched === true,
    reason:
      journeyBatch === 'PASS'
        ? 'Critical harness journeys passed on Xiaomi; RFC §51 C DoD and owner-signed PARITY remain open'
        : sendPersisted
          ? 'Physical C journey batch incomplete or not on required Xiaomi serial'
          : 'send round-trip did not persist a Kernel messageCount',
    checks: [
      ...checks,
      ...optional,
      { id: 'production_cutover_false', ok: cutoverOff, value: evidence?.production_cutover },
      { id: 'canary_off', ok: canaryOff, value: evidence?.canary },
      { id: 'serial', ok: serialOk, value: evidence?.serial },
    ],
    ten_k_messages: 'HOST_PROVEN',
    compositor_surfaceview_chat: false,
    compatibility_matrix: 'DEFERRED',
    failed_attempts: mergeFailedAttempts(previous, {
      stamp: evidence?.stamp ?? null,
      outcome: 'FAILED_ATTEMPT',
      send_round_trip: sendPersisted ? 'PASS' : 'FAIL',
      live_open: live?.ok ? 'PASS' : 'FAIL',
      ten_k_physical: 'NOT_RUN',
      gboard_environment: /google\.android\.inputmethod\.latin/u.test(
        String(row(evidence, 'ime')?.default_input_method || ''),
      )
        ? 'READY'
        : 'UNKNOWN',
      gboard_journey: 'NOT_PROVEN',
      talkback_semantics: row(evidence, 'a11y_semantics')?.ok ? 'PASS' : 'FAIL',
      talkback_journey: 'NOT_PROVEN',
      production_cutover: 'NOT_STARTED',
      apk_sha256: evidence?.apk_sha256 ?? null,
      source_commit: evidence?.source_commit ?? null,
    }, journeyBatch === 'PASS'),
  };
  return record;
}

function mergeFailedAttempts(previous, attempt, passed) {
  const existing = Array.isArray(previous?.failed_attempts) ? previous.failed_attempts : [];
  const byStamp = new Map(
    existing
      .filter((row) => row && row.stamp)
      .map((row) => [row.stamp, row]),
  );
  if (!passed && attempt?.stamp && !byStamp.has(attempt.stamp)) {
    byStamp.set(attempt.stamp, attempt);
  }
  return [...byStamp.values()];
}

export function writeRecord(record, { write = false, path = RECORD_PATH } = {}) {
  if (!write) return path;
  let previous = null;
  if (existsSync(path)) {
    try {
      previous = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      previous = null;
    }
  }
  const merged = {
    ...record,
    failed_attempts: mergeFailedAttempts(
      previous,
      (record.failed_attempts || [])[0] || null,
      record.journey_batch === 'PASS',
    ),
  };
  if (Array.isArray(record.failed_attempts) && record.failed_attempts.length > 0) {
    const byStamp = new Map();
    for (const row of [...(previous?.failed_attempts || []), ...record.failed_attempts]) {
      if (row?.stamp && !byStamp.has(row.stamp)) {
        byStamp.set(row.stamp, row);
      }
    }
    merged.failed_attempts = [...byStamp.values()];
  }
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  return path;
}

function main() {
  const evidencePath = argValue('evidence');
  if (!evidencePath || !existsSync(evidencePath)) {
    process.stderr.write('need --evidence=path to capture evidence JSON\n');
    process.exitCode = 1;
    return;
  }
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  const logPath = evidencePath.replace(/-evidence\.json$/u, '-logcat.txt');
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  let previous = null;
  if (existsSync(RECORD_PATH)) {
    try {
      previous = JSON.parse(readFileSync(RECORD_PATH, 'utf8'));
    } catch {
      previous = null;
    }
  }
  const record = adjudicateMilestoneC(evidence, log, previous);
  const write = process.argv.includes('--write');
  const out = writeRecord(record, { write });
  process.stdout.write(`${JSON.stringify({ record, written: write ? out : null }, null, 2)}\n`);
  if (record.journey_batch !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
