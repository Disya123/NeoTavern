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
const GBOARD_FORBIDDEN_DRIVERS = new Set([
  'adb_input_text',
  'adb_input_keyevent',
  'espresso_typeText',
  'direct_input_connection',
]);

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

function markerBlob(evidence, log, ...names) {
  const parts = [String(log || '')];
  for (const name of names) {
    const item = row(evidence, name);
    if (item?.markers) parts.push(String(item.markers));
  }
  return parts.join('\n');
}

export function gboardJourneyProven(item, text) {
  if (!item || item.ok !== true) return false;
  if (GBOARD_FORBIDDEN_DRIVERS.has(item.driver)) return false;
  if (item.driver !== 'gboard_keys') return false;
  if (!/google\.android\.inputmethod\.latin/u.test(String(item.default_input_method || ''))) {
    return false;
  }
  if (item.sendOnce !== true) return false;
  if (item.composingStuckAfterLifecycle === true) return false;
  const blob = `${text}\n${item.markers || ''}`;
  const need = [
    /gboard_ime focus=true\b/u,
    /gboard_ime inset_show\b/u,
    /gboard_ime inset_hide\b/u,
    /gboard_ic action=(updateSelection|setSelection)\b/u,
    /gboard_ic action=deleteSurroundingText\b/u,
    /gboard_ic action=commitText\b/u,
    /gboard_ic action=performEditorAction code=SEND\b/u,
  ];
  return need.every((re) => re.test(blob));
}

export function talkbackJourneyProven(item, text) {
  if (!item || item.ok !== true) return false;
  if (item.semantics_only) return false;
  if (item.talkbackEnabled !== true) return false;
  if (item.restored !== true) return false;
  if (item.webViewInTree === true) return false;
  if (item.recycleJump === true) return false;
  if (item.perTokenAnnounce === true) return false;
  if (item.streamAnnounceCoalesced !== true) return false;
  const order = item.focusOrder;
  if (!Array.isArray(order) || order.join(',') !== 'header,messages,composer') return false;
  if (item.scrollAction !== true || item.clickAction !== true) return false;
  const blob = `${text}\n${item.markers || ''}`;
  const need = [
    /talkback event=TYPE_VIEW_ACCESSIBILITY_FOCUSED node=header\b/u,
    /talkback event=TYPE_VIEW_ACCESSIBILITY_FOCUSED node=messages\b/u,
    /talkback event=TYPE_VIEW_ACCESSIBILITY_FOCUSED node=composer\b/u,
    /talkback action=SCROLL_FORWARD\b/u,
    /talkback (event=TYPE_VIEW_CLICKED|action=CLICK)\b/u,
    /a11y_announce kind=stream_begin\b/u,
    /a11y_announce kind=stream_end\b/u,
    /talkback recycle_jump=false\b/u,
    /talkback webview_in_tree=false\b/u,
    /talkback restored=true\b/u,
  ];
  if (need.some((re) => !re.test(blob))) return false;
  if ((blob.match(/a11y_announce kind=token\b/gu) || []).length > 0) return false;
  const begins = (blob.match(/a11y_announce kind=stream_begin\b/gu) || []).length;
  const ends = (blob.match(/a11y_announce kind=stream_end\b/gu) || []).length;
  if (begins < 1 || ends < 1 || begins > 2 || ends > 2) return false;
  return true;
}

function sendRoundTripPass(evidence) {
  const live = row(evidence, 'live_open');
  const send = row(evidence, 'send');
  const sendPersisted =
    typeof send?.after?.count === 'number' && send.after.count > (live?.messageCount ?? 0);
  const reopen = row(evidence, 'reopen');
  const reopenOk =
    typeof reopen?.after?.count === 'number'
      ? reopen.after.count > (live?.messageCount ?? 0)
      : Boolean(reopen?.ok);
  return Boolean(sendPersisted && reopenOk);
}

function isolated10kPass(evidence) {
  const isolated = row(evidence, 'isolated_10k');
  if (isolated?.header?.title === 'Isolated 10k' && isolated?.header?.count === 10_000) {
    return true;
  }
  return Boolean(isolated?.ok && isolated?.header?.count === 10_000);
}

function lifecyclePass(evidence, blob) {
  const rotate = row(evidence, 'rotate');
  const background = row(evidence, 'background');
  const gboard = row(evidence, 'gboard_journey');
  if (!rotate?.ok || !background?.ok) return false;
  if (gboard?.composingStuckAfterLifecycle === true) return false;
  return /gboard_ic action=lifecycle_resume composing=false\b/u.test(blob);
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
  const isolatedOk = isolated10kPass(evidence);
  const gboard = row(evidence, 'gboard_journey');
  const talkback = row(evidence, 'talkback_journey');
  const ime = row(evidence, 'ime');
  const blob = markerBlob(evidence, log, 'gboard_journey', 'talkback_journey', 'send');
  const gboardOk = gboardJourneyProven(gboard, blob);
  const talkbackSkipped = Boolean(talkback?.skipped || talkback?.operator_waived);
  const talkbackOk = talkbackJourneyProven(talkback, blob);
  const talkbackStatus = talkbackOk ? 'PASS' : talkbackSkipped ? 'SKIPPED' : 'NOT_PROVEN';
  const sendOk = sendRoundTripPass(evidence);
  const lifecycleOk = lifecyclePass(evidence, blob);
  const safeOk = Boolean(row(evidence, 'safe_mode')?.ok);
  const optional = [
    'a11y_semantics',
    'send',
    'reopen',
    'isolated_10k',
    'rotate',
    'background',
    'ime',
    'gboard_journey',
    'talkback_journey',
  ].map((name) => {
    const item = row(evidence, name);
    if (name === 'send') {
      return { id: name, ok: sendPersisted, value: item };
    }
    if (name === 'reopen') {
      return { id: name, ok: reopenOk, value: item };
    }
    if (name === 'isolated_10k') {
      return { id: name, ok: isolatedOk, value: item };
    }
    if (name === 'gboard_journey') {
      return { id: name, ok: gboardOk, value: item };
    }
    if (name === 'talkback_journey') {
      return { id: name, ok: talkbackOk, value: item };
    }
    return { id: name, ok: Boolean(item?.ok), value: item };
  });
  const liveLine = String(log || '');
  const cutoverOff =
    /production_cutover=false/u.test(liveLine) ||
    evidence?.production_cutover === 'NOT_STARTED';
  const canaryOff = evidence?.canary === false;
  const physical = serialOk && !emulator;
  const requiredOk = checks.every((item) => item.ok);
  const missing = [];
  if (!sendOk) missing.push('send_round_trip');
  if (!isolatedOk) missing.push('physical_10k');
  if (!gboardOk) missing.push('gboard_journey');
  if (!lifecycleOk) missing.push('lifecycle');
  if (!safeOk) missing.push('safe_mode');
  const journeyBatch =
    physical && requiredOk && missing.length === 0 && cutoverOff && canaryOff ? 'PASS' : 'FAIL';
  const gboardEnv = /google\.android\.inputmethod\.latin/u.test(
    String(ime?.default_input_method || gboard?.default_input_method || ''),
  )
    ? 'READY'
    : 'UNKNOWN';
  const attempt = {
    stamp: evidence?.stamp ?? null,
    outcome: 'FAILED_ATTEMPT',
    send_round_trip: sendOk ? 'PASS' : 'FAIL',
    live_open: live?.ok ? 'PASS' : 'FAIL',
    ten_k_physical: isolatedOk ? 'PASS' : 'NOT_RUN',
    gboard_environment: gboardEnv,
    gboard_journey: gboardOk ? 'PASS' : 'NOT_PROVEN',
    talkback_semantics: row(evidence, 'a11y_semantics')?.ok ? 'PASS' : 'FAIL',
    talkback_journey: talkbackStatus,
    lifecycle: lifecycleOk ? 'PASS' : 'FAIL',
    safe_mode: safeOk ? 'PASS' : 'FAIL',
    production_cutover: 'NOT_STARTED',
    apk_sha256: evidence?.apk_sha256 ?? null,
    source_commit: evidence?.source_commit ?? null,
  };
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
    send_round_trip: sendOk ? 'PASS' : 'FAIL',
    physical_10k: isolatedOk ? 'PASS' : 'NOT_RUN',
    gboard_environment: gboardEnv,
    gboard_journey: gboardOk ? 'PASS' : 'NOT_PROVEN',
    talkback_semantics: row(evidence, 'a11y_semantics')?.ok ? 'PASS' : 'FAIL',
    talkback_journey: talkbackStatus,
    talkback_rfc51: 'DEFERRED_BY_OWNER',
    product_accessibility_path: 'WEBVIEW_FALLBACK',
    gboard_typing_insets_send: gboardOk ? 'PASS' : 'NOT_PROVEN',
    ime_composition_contract: 'HOST_CONFORMANCE',
    lifecycle: lifecycleOk ? 'PASS' : 'FAIL',
    safe_mode: safeOk ? 'PASS' : 'FAIL',
    reason:
      journeyBatch === 'PASS'
        ? 'Critical harness journeys passed on Xiaomi; RFC §51 C DoD and owner-signed PARITY remain open'
        : missing.length
          ? `missing ${missing.join(',')}`
          : 'Physical C journey batch incomplete or not on required Xiaomi serial',
    checks: [
      ...checks,
      ...optional,
      { id: 'send_round_trip', ok: sendOk, value: sendOk ? 'PASS' : 'FAIL' },
      { id: 'physical_10k', ok: isolatedOk, value: isolatedOk ? 'PASS' : 'NOT_RUN' },
      { id: 'gboard_journey', ok: gboardOk, value: gboardOk ? 'PASS' : 'NOT_PROVEN' },
      { id: 'talkback_journey', ok: talkbackOk, value: talkbackStatus },
      { id: 'lifecycle', ok: lifecycleOk, value: lifecycleOk ? 'PASS' : 'FAIL' },
      { id: 'production_cutover_false', ok: cutoverOff, value: evidence?.production_cutover },
      { id: 'canary_off', ok: canaryOff, value: evidence?.canary },
      { id: 'serial', ok: serialOk, value: evidence?.serial },
    ],
    ten_k_messages: 'HOST_PROVEN',
    compositor_surfaceview_chat: false,
    compatibility_matrix: 'DEFERRED',
    failed_attempts: mergeFailedAttempts(previous, attempt, journeyBatch === 'PASS'),
    successful_attempt:
      journeyBatch === 'PASS'
        ? {
            stamp: evidence?.stamp ?? null,
            send_round_trip: 'PASS',
            physical_10k: 'PASS',
            gboard_journey: 'PASS',
            talkback_journey: talkbackStatus,
            lifecycle: 'PASS',
            safe_mode: 'PASS',
            apk_sha256: evidence?.apk_sha256 ?? null,
            source_commit: evidence?.source_commit ?? null,
          }
        : (previous?.successful_attempt ?? null),
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
    successful_attempt: record.successful_attempt ?? previous?.successful_attempt ?? null,
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
