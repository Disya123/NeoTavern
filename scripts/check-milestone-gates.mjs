#!/usr/bin/env node
/**
 * check-milestone-gates — acceptance-ledger gate (audit directive: "CI gate
 * blocking M2 while M1.status != accepted", ТЗ 10/10 rev2 §22, §18.3).
 *
 * The ledger `docs/architecture/acceptance-ledger.json` records each program
 * milestone with a `status` (`in_progress` | `accepted`). This gate enforces:
 *
 * Ordering (audit): a milestone may only be `accepted` when EVERY earlier
 *   milestone is also `accepted` — later stages build on earlier exit
 *   criteria, so an accepted M2 with an in-progress M1 would claim an
 *   impossible ordering.
 *
 * Parallel development policy: `policy.parallelDevelopment` (ledger top
 * level, default `false` = strict sequential) controls whether an
 * `in_progress` milestone may carry a `deliveredCommit` before its
 * predecessors are accepted. Under the strict default, shipping work for
 * milestone N while N-1 is still open fails the gate — the branch stops at
 * the red stage instead of accumulating later-stage commits. Setting the
 * flag to `true` is the documented ТЗ change that allows parallel
 * development, in which case formal `accepted` still requires every
 * predecessor (merge/activate/accept remains ordered).
 *
 * Acceptance integrity (an `accepted` milestone must be provable):
 *   - `acceptedCommit` is a non-empty git commit that exists and is an
 *     ancestor of HEAD;
 *   - `acceptedBy` is recorded;
 *   - `blockingIssues` is empty, or every issue is covered by a formal
 *     `waivers` entry (`{ issue, by, date, reason }`);
 *   - any `P0` blocking issue forbids acceptance even with a waiver;
 *   - `evidence` is a non-empty array of strings (checkable statements);
 *   - the ledger itself is non-empty and structurally valid — an empty or
 *     broken ledger exits 1 (no ignored failures).
 *
 * Modes:
 *   (default)  validate the real ledger and print a summary; exit 1 on any
 *              violation (same as --check).
 *   --check    CI gate: exit 1 on any violation.
 *   --self-test  run fixture-driven positive/negative cases (used by `pnpm test`).
 *   --acceptance-drill  dry-run accepting the first non-accepted milestone
 *              exactly as its own `acceptanceProposal` prescribes and re-run
 *              the gate on the copy: PASS means the proposed acceptance is
 *              mechanically valid (later red milestones are expected under
 *              the strict sequential policy), FAIL means the proposal itself
 *              would be rejected. A human can use this to verify an
 *              acceptance before flipping status/acceptedCommit/acceptedBy.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = join(ROOT, 'docs', 'architecture', 'acceptance-ledger.json');
const CHECK = process.argv.includes('--check');
const SELF_TEST = process.argv.includes('--self-test');
const ACCEPTANCE_DRILL = process.argv.includes('--acceptance-drill');

/** ACCEPTED states (a later milestone may build on them). */
const ACCEPTED = new Set(['accepted']);

/** Matches a P0 blocker ("P0", "P0:", "[P0]", "p0"). */
const P0_RE = /\bP0\b/i;

/** Non-empty sha1/sha256-looking git revision. */
const COMMIT_RE = /^[0-9a-fA-F]{7,64}$/;

function fail(message) {
  console.error(`[milestone-gates] FAIL: ${message}`);
  return false;
}
/** Is `commit` a real git object that is an ancestor of HEAD? */
function commitExistsAndIsAncestor(commit) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function validate(milestones, policy) {
  if (!Array.isArray(milestones) || milestones.length === 0) {
    fail('ledger has no milestones — an empty ledger must exit 1 (no acceptance can be proven)');
    return { ok: false, accepted: 0, failures: [] };
  }

  const failures = [];
  const recordFail = (milestone, message) => {
    failures.push({ milestone, message });
    return fail(message);
  };

  const parallel = Boolean(policy && policy.parallelDevelopment === true);
  const seen = new Set();
  let ok = true;
  let acceptedPrefix = true; // the empty prefix is trivially accepted
  let accepted = 0;

  for (let i = 0; i < milestones.length; i += 1) {
    const m = milestones[i];
    const label = `${m.id ?? `<milestone ${i}>`} (${m.status ?? '<no status>'})`;

    if (!m.id || seen.has(m.id)) {
      ok =
        recordFail(`<milestone ${i}>`, `milestone ${i} has a missing or duplicate id (${m.id})`) &&
        ok;
    }
    seen.add(m.id);

    if (!Array.isArray(m.blockingIssues)) {
      ok = recordFail(label, 'blockingIssues must be an array') && ok;
    }
    if (!Array.isArray(m.waivers)) {
      ok = recordFail(label, 'waivers must be an array') && ok;
    }
    if (!Array.isArray(m.evidence)) {
      ok = recordFail(label, 'evidence must be an array') && ok;
    }

    const isAccepted = ACCEPTED.has(m.status);
    if (isAccepted) accepted += 1;

    if (isAccepted) {
      // --- ordering: every predecessor must be accepted.
      if (!acceptedPrefix) {
        ok =
          recordFail(
            label,
            `${label} is accepted while an earlier milestone is not accepted — ` +
              'later stages may only be accepted after every earlier stage (audit: ' +
              '"CI gate blocking M2 while M1.status != accepted")',
          ) && ok;
      }
      // --- acceptedCommit must exist and be an ancestor of HEAD.
      if (typeof m.acceptedCommit !== 'string' || !COMMIT_RE.test(m.acceptedCommit)) {
        ok =
          recordFail(label, `${label}: accepted milestone must record a git acceptedCommit`) && ok;
      } else if (!SELF_TEST && !commitExistsAndIsAncestor(m.acceptedCommit)) {
        ok =
          recordFail(
            label,
            `${label}: acceptedCommit '${m.acceptedCommit}' is not a git commit in HEAD's ancestry`,
          ) && ok;
      }
      if (!m.acceptedBy) {
        ok = recordFail(label, `${label}: accepted milestone must record acceptedBy`) && ok;
      }
      // --- evidence must be checkable.
      if (
        !Array.isArray(m.evidence) ||
        m.evidence.length === 0 ||
        !m.evidence.every((e) => typeof e === 'string')
      ) {
        ok =
          recordFail(label, `${label}: accepted milestone must carry non-empty string evidence`) &&
          ok;
      }
      // --- blockers: empty, or every issue formally waived; P0 never waivable.
      const blockers = Array.isArray(m.blockingIssues) ? m.blockingIssues : [];
      const waivers = Array.isArray(m.waivers) ? m.waivers : [];
      for (const blocker of blockers) {
        if (typeof blocker !== 'string') {
          ok = recordFail(label, `${label}: blockingIssues entries must be strings`) && ok;
          continue;
        }
        if (P0_RE.test(blocker)) {
          ok =
            recordFail(
              label,
              `${label}: P0 blocking issue forbids acceptance even with a waiver — ` +
                `'${blocker.slice(0, 120)}'`,
            ) && ok;
          continue;
        }
        const covered = waivers.some((w) => w && typeof w === 'object' && w.issue === blocker);
        if (!covered) {
          ok =
            recordFail(
              label,
              `${label}: accepted milestone has an un-waived blocking issue — ` +
                `'${blocker.slice(0, 120)}' (waive it in waivers[] with issue/by/date/reason)`,
            ) && ok;
        }
      }
    } else if (m.status === 'in_progress') {
      // --- parallel-development policy: shipping work for a later stage while
      // a predecessor is open is only legal under policy.parallelDevelopment.
      if (!parallel && m.deliveredCommit && !acceptedPrefix) {
        ok =
          recordFail(
            label,
            `${label} records deliveredCommit '${m.deliveredCommit}' while an earlier ` +
              'milestone is not accepted — parallel development is disabled ' +
              '(policy.parallelDevelopment=false). Finish and accept the predecessor, ' +
              'or set policy.parallelDevelopment=true as the documented ТЗ change.',
          ) && ok;
      }
      acceptedPrefix = false;
    } else if (m.status === undefined) {
      ok = recordFail(label, `${label}: missing status (expected in_progress | accepted)`) && ok;
      acceptedPrefix = false;
    } else {
      ok =
        recordFail(
          label,
          `${label}: unknown status '${m.status}' (expected in_progress | accepted)`,
        ) && ok;
      acceptedPrefix = false;
    }
  }

  console.log(
    `[milestone-gates] ${milestones.length} milestones, ${accepted} accepted, ` +
      `parallel=${parallel ? 'on' : 'off'}, ${ok ? 'GATE PASS' : 'GATE FAIL'}`,
  );
  return { ok, accepted, failures };
}

/** Fixture-driven self-test: the gate fails exactly on the documented rules. */
function selfTest() {
  const base = (status) => ({
    id: 'M' + Math.random().toString(36).slice(2, 6),
    name: 'fixture',
    status,
    requirements: [],
    evidence: ['fixture evidence'],
    blockingIssues: [],
    waivers: [],
    ...(status === 'accepted'
      ? { acceptedCommit: 'f00df00', acceptedBy: 'self-test' }
      : { acceptedCommit: null, acceptedBy: null }),
  });
  const cases = [
    // accepted → accepted → accepted : holds
    [
      'accepted chain holds',
      () =>
        validate([base('accepted'), base('accepted'), base('accepted')], {
          parallelDevelopment: false,
        }),
    ],
    // accepted → in_progress(delivered) → accepted : ordering + strict parallel fail
    [
      'ordering fail',
      () => {
        const late = base('accepted');
        const mid = base('in_progress');
        mid.deliveredCommit = 'f00df00';
        return validate([base('accepted'), mid, late], { parallelDevelopment: false });
      },
    ],
    // accepted with an open blocker (no waiver) : fail
    [
      'unwaived blocker fail',
      () => {
        const m = base('accepted');
        m.blockingIssues = ['some open issue'];
        return validate([m], { parallelDevelopment: false });
      },
    ],
    // accepted with a formally waived non-P0 blocker : holds
    [
      'waived blocker holds',
      () => {
        const m = base('accepted');
        m.blockingIssues = ['waived issue'];
        m.waivers = [
          { issue: 'waived issue', by: 'self-test', date: '2026-01-01', reason: 'fixture' },
        ];
        return validate([m], { parallelDevelopment: false });
      },
    ],
    // accepted with a P0 blocker even when waived : fail
    [
      'P0 never waivable',
      () => {
        const m = base('accepted');
        m.blockingIssues = ['P0: critical'];
        m.waivers = [
          { issue: 'P0: critical', by: 'self-test', date: '2026-01-01', reason: 'fixture' },
        ];
        return validate([m], { parallelDevelopment: false });
      },
    ],
    // accepted without acceptedCommit : fail
    [
      'missing acceptedCommit',
      () => {
        const m = base('accepted');
        delete m.acceptedCommit;
        return validate([m], { parallelDevelopment: false });
      },
    ],
    // empty milestone list : fail
    ['empty ledger fails', () => validate([], { parallelDevelopment: false })],
    // strict policy: in_progress delivered after open predecessor : fail
    [
      'strict delivered-while-open fails',
      () => {
        const m = base('in_progress');
        m.deliveredCommit = 'f00df00';
        return validate([base('in_progress'), m], { parallelDevelopment: false });
      },
    ],
    // parallel policy: same shape is allowed
    [
      'parallel policy allows delivered',
      () => {
        const m = base('in_progress');
        m.deliveredCommit = 'f00df00';
        return validate([base('in_progress'), m], { parallelDevelopment: true });
      },
    ],
  ];
  const results = cases.map(([name, run]) => ({ name, ok: run().ok }));
  const expected = {
    'accepted chain holds': true,
    'ordering fail': false,
    'unwaived blocker fail': false,
    'waived blocker holds': true,
    'P0 never waivable': false,
    'missing acceptedCommit': false,
    'empty ledger fails': false,
    'strict delivered-while-open fails': false,
    'parallel policy allows delivered': true,
  };
  let pass = true;
  for (const { name, ok } of results) {
    const want = expected[name];
    if (ok !== want) {
      pass = false;
      console.error(`[milestone-gates] self-test case '${name}': expected ${want}, got ${ok}`);
    }
  }
  if (pass) {
    console.log('[milestone-gates] self-test PASS');
  } else {
    console.error('[milestone-gates] self-test FAIL');
  }
  return pass;
}

/**
 * Acceptance drill: dry-run the acceptance of the FIRST non-accepted milestone
 * exactly as its own `acceptanceProposal` prescribes (status=accepted,
 * acceptedCommit=<proposedAcceptedCommit>, acceptedBy=<acceptance-drill>) and
 * re-run the gate on the copy. PASS means "accepting this milestone as
 * proposed is mechanically valid" — remaining red milestones are expected
 * under the strict sequential policy and are NOT a drill failure. FAIL means
 * the proposed acceptance itself would be rejected by the gate.
 */
function acceptanceDrill() {
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
  } catch (error) {
    return fail(`cannot read ${LEDGER}: ${error.message}`);
  }
  if (!Array.isArray(ledger.milestones) || ledger.milestones.length === 0) {
    return fail('ledger has no milestones — nothing to drill');
  }
  const firstOpen = ledger.milestones.find((m) => m.status !== 'accepted');
  if (!firstOpen) {
    console.log(
      '[milestone-gates] acceptance drill: every milestone is already accepted — nothing to drill',
    );
    return true;
  }
  const proposal = firstOpen.acceptanceProposal;
  const commit = proposal?.proposedAcceptedCommit;
  if (typeof commit !== 'string' || !COMMIT_RE.test(commit)) {
    return fail(
      `${firstOpen.id} has no valid acceptanceProposal.proposedAcceptedCommit — ` +
        'add one before drilling its acceptance',
    );
  }
  if (!SELF_TEST && !commitExistsAndIsAncestor(commit)) {
    return fail(
      `${firstOpen.id}: acceptanceProposal.proposedAcceptedCommit '${commit}' is not a git commit in HEAD's ancestry`,
    );
  }
  const drill = structuredClone(ledger);
  const target = drill.milestones.find((m) => m.id === firstOpen.id);
  target.status = 'accepted';
  target.acceptedCommit = commit;
  target.acceptedBy = '<acceptance-drill>';
  const result = validate(drill.milestones, drill.policy);
  const targetFails = result.failures.filter((f) => f.milestone.includes(firstOpen.id));
  if (targetFails.length === 0) {
    console.log(
      `[milestone-gates] acceptance drill PASS: accepting ${firstOpen.id} per its ` +
        `acceptanceProposal (acceptedCommit ${commit}) is mechanically valid — ` +
        `${result.accepted} milestone(s) accepted after the drill; remaining red ` +
        'milestones are later-stage delivered work waiting for their predecessors (expected)',
    );
    return true;
  }
  console.error(
    `[milestone-gates] acceptance drill FAIL: accepting ${firstOpen.id} as proposed would be rejected:`,
  );
  for (const f of targetFails) {
    console.error(`  - ${f.message}`);
  }
  return false;
}

function main() {
  if (SELF_TEST) {
    return selfTest();
  }
  if (ACCEPTANCE_DRILL) {
    return acceptanceDrill();
  }
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
  } catch (error) {
    return fail(`cannot read ${LEDGER}: ${error.message}`);
  }
  if (typeof ledger.policy !== 'object' || ledger.policy === null) {
    return fail('ledger is missing the top-level policy object (policy.parallelDevelopment)');
  }
  if (typeof ledger.policy.parallelDevelopment !== 'boolean') {
    return fail('ledger policy.parallelDevelopment must be a boolean');
  }
  return validate(ledger.milestones, ledger.policy).ok;
}

const ok = main();
if (!CHECK && !SELF_TEST && !ACCEPTANCE_DRILL && !ok) {
  // default mode is also a gate: non-zero exit on any violation.
  process.exitCode = 1;
} else if (CHECK && !ok) {
  process.exitCode = 1;
} else if (ACCEPTANCE_DRILL && !ok) {
  process.exitCode = 1;
}
