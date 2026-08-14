#!/usr/bin/env node
/**
 * check-milestone-gates — acceptance-ledger ordering gate (audit directive:
 * "CI gate blocking M2 while M1.status != accepted", ТЗ 10/10 rev2 §22).
 *
 * The ledger `docs/architecture/acceptance-ledger.json` records each program
 * milestone with a `status` (`in_progress` | `accepted`). A milestone may only
 * be `accepted` when EVERY earlier milestone is also `accepted` — later stages
 * build on earlier exit criteria, so an accepted M2 with an in-progress M1
 * would claim an impossible ordering (Этап 2 exits before Этап 1?).
 *
 * Additional structural checks, so a green gate means a readable ledger:
 *   - every milestone id is unique;
 *   - `accepted` milestones must have `acceptedCommit` and `acceptedBy`;
 *   - `blockingIssues`/`waivers` are arrays;
 *   - a milestone named "accepted" may still carry OPEN blocking issues
 *     (they are honest follow-ups), but the milestone ORDER above must hold.
 *
 * Modes:
 *   (default)  validate the real ledger and print a summary.
 *   --check    exit 1 if any milestone is out of order or structurally
 *              invalid; exit 0 otherwise (CI gate).
 *   --self-test  run fixture-driven positive/negative cases (used by `pnpm test`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = join(ROOT, 'docs', 'architecture', 'acceptance-ledger.json');
const CHECK = process.argv.includes('--check');
const SELF_TEST = process.argv.includes('--self-test');

/** ACCEPTED states (a later milestone may build on them). */
const ACCEPTED = new Set(['accepted']);

function fail(message) {
  if (CHECK) {
    console.error(`[milestone-gates] FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`[milestone-gates] FAIL: ${message}`);
  }
  return false;
}

function validate(milestones) {
  if (!Array.isArray(milestones) || milestones.length === 0) {
    return { ok: false, accepted: 0 };
  }

  const seen = new Set();
  let ok = true;
  let orderingHolds = true; // every accepted milestone has only accepted predecessors
  let acceptedPrefix = true; // the empty prefix is trivially accepted

  for (let i = 0; i < milestones.length; i += 1) {
    const m = milestones[i];
    const label = `${m.id ?? `<milestone ${i}>`} (${m.status ?? '<no status>'})`;

    if (!m.id || seen.has(m.id)) {
      ok = fail(`milestone ${i} has a missing or duplicate id (${m.id})`) && ok;
    }
    seen.add(m.id);

    if (!Array.isArray(m.blockingIssues)) {
      ok = fail(`${label}: blockingIssues must be an array`) && ok;
    }
    if (!Array.isArray(m.waivers)) {
      ok = fail(`${label}: waivers must be an array`) && ok;
    }

    if (ACCEPTED.has(m.status)) {
      if (!acceptedPrefix) {
        orderingHolds = false;
        ok =
          fail(
            `${label} is accepted while an earlier milestone is not accepted — ` +
              'later stages may only be accepted after every earlier stage (audit: ' +
              '"CI gate blocking M2 while M1.status != accepted")',
          ) && ok;
      }
      if (!m.acceptedCommit) {
        ok = fail(`${label}: accepted milestone must record acceptedCommit`) && ok;
      }
      if (!m.acceptedBy) {
        ok = fail(`${label}: accepted milestone must record acceptedBy`) && ok;
      }
    } else if (m.status === 'in_progress') {
      // in_progress milestones do not advance the accepted prefix. They may
      // carry a `deliveredCommit` (works shipped) while formal acceptance
      // waits for the ordering gate.
      acceptedPrefix = false;
    } else if (m.status === undefined) {
      ok = fail(`${label}: missing status (expected in_progress | accepted)`) && ok;
      acceptedPrefix = false;
    } else {
      ok = fail(`${label}: unknown status '${m.status}' (expected in_progress | accepted)`) && ok;
      acceptedPrefix = false;
    }
  }

  const accepted = milestones.filter((m) => ACCEPTED.has(m.status)).length;
  console.log(
    `[milestone-gates] ${milestones.length} milestones, ${accepted} accepted, ` +
      `ordering ${orderingHolds && ok ? 'holds' : 'BROKEN'}`,
  );
  return { ok, accepted };
}

/** Fixture-driven self-test: prove the gate fails exactly when an accepted
 *  milestone follows an unaccepted predecessor (the audit directive). */
function selfTest() {
  const base = (status) => ({
    id: 'M' + Math.random().toString(36).slice(2, 6),
    name: 'fixture',
    status,
    requirements: [],
    evidence: [],
    blockingIssues: [],
    waivers: [],
    ...(status === 'accepted'
      ? { acceptedCommit: 'f00d', acceptedBy: 'self-test' }
      : { acceptedCommit: null, acceptedBy: null }),
  });
  // accepted → accepted → accepted : holds
  const ok = validate([base('accepted'), base('accepted'), base('accepted')]);
  // accepted → in_progress → accepted : must fail (M3 accepted while M2 open)
  const broken = validate([base('accepted'), base('in_progress'), base('accepted')]);
  if (ok.ok && !broken.ok) {
    console.log('[milestone-gates] self-test PASS');
    return true;
  }
  console.error('[milestone-gates] self-test FAIL: expected ok + broken cases to behave');
  return false;
}

function main() {
  if (SELF_TEST) {
    return selfTest();
  }
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
  } catch (error) {
    return fail(`cannot read ${LEDGER}: ${error.message}`);
  }
  const { ok } = validate(ledger.milestones);
  return ok;
}

main();
