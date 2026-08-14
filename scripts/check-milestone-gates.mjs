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
 *   - `acceptedBy` is a person or an explicit human-ratified signature, never
 *     an automated actor (acceptance is a human verdict);
 *   - `blockingIssues` is empty, or every issue is covered by a formal
 *     `waivers` entry `{ issue, by, date, severity, expiry, reason, adr }`
 *     whose fields are validated: `by` is human (not the agent), `severity`
 *     matches the blocker's P-level, `expiry` bounds the exception, and `adr`
 *     links a real limited-waiver ADR document in `docs/adr/` (ТЗ requires an
 *     ADR waiver, not just a JSON record);
 *   - any `P0` blocking issue forbids acceptance even with a waiver;
 *   - `evidence` is a non-empty array of STRUCTURED, reproducible items —
 *     `{ type: "test-run"|"ci"|"artifact"|"inspection", command, result,
 *     commit, ciRun, artifact }` — a test-run item must record the exact
 *     command and a commit in HEAD's ancestry, a ci item the CI run URL;
 *     bare "597/597" strings are rejected;
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

/** Evidence item types the gate accepts (see validateEvidence). */
const EVIDENCE_TYPES = new Set(['test-run', 'ci', 'artifact', 'inspection']);

/**
 * Automated actors can never waive or accept a milestone — the waiver's `by`
 * (and an accepted milestone's `acceptedBy`) must be a person or an explicit
 * human-ratified process signature, not the implementing agent.
 */
const AUTO_ACTOR_RE = /\b(agent|assistant|system|bot|llm|claude|gpt)\b/i;

/**
 * Validate one structured evidence item (audit: evidence must be
 * REPRODUCIBLE, not a bare statement — record the command, the commit it ran
 * on, and/or the CI run / artifact). When `requireAncestry` is true (real
 * gate / drill, not self-test), a test-run evidence commit must be a git
 * commit in HEAD's ancestry.
 */
function evidenceFailures(milestoneLabel, item, index, requireAncestry) {
  const out = [];
  const at = `${milestoneLabel}: evidence[${index}]`;
  if (typeof item === 'string') {
    out.push(
      `${at} is a bare string — record structured evidence ` +
        '{ type: "test-run"|"ci"|"artifact"|"inspection", command, result, commit, ciRun, artifact }',
    );
    return out;
  }
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    out.push(`${at} must be a structured evidence object`);
    return out;
  }
  if (!EVIDENCE_TYPES.has(item.type)) {
    out.push(
      `${at}.type must be one of ${[...EVIDENCE_TYPES].join('|')} (got '${String(item.type)}')`,
    );
  }
  if (typeof item.result !== 'string' || item.result.length === 0) {
    out.push(`${at} must carry a non-empty result statement`);
  }
  if (item.type === 'test-run') {
    if (typeof item.command !== 'string' || item.command.length === 0) {
      out.push(`${at} (test-run) must record the exact command that was run`);
    }
    if (typeof item.commit !== 'string' || !COMMIT_RE.test(item.commit)) {
      out.push(`${at} (test-run) must record the commit the command ran on`);
    } else if (requireAncestry && !commitExistsAndIsAncestor(item.commit)) {
      out.push(
        `${at}.commit '${item.commit}' is not a git commit in HEAD's ancestry — ` +
          'the evidence is not reproducible from this branch',
      );
    }
  }
  if (item.type === 'ci') {
    if (typeof item.ciRun !== 'string' || !/^https?:\/\//.test(item.ciRun)) {
      out.push(`${at} (ci) must record the ciRun URL of the CI run`);
    }
  }
  if (item.type === 'artifact') {
    if (typeof item.artifact !== 'string' || item.artifact.length === 0) {
      out.push(`${at} (artifact) must record the artifact path or id`);
    }
  }
  return out;
}

/**
 * Validate the waiver that covers a blocker (audit: the gate must check
 * `by` / `reason` / `severity` / `expiry`, not just the `issue` match, and
 * the ТЗ requires a limited ADR waiver — so a waiver must link a real ADR
 * document in docs/adr/).
 */
function waiverFailures(milestoneLabel, blocker, waiver) {
  const out = [];
  const at = `${milestoneLabel}: waiver for '${blocker.slice(0, 80)}'`;
  if (typeof waiver.by !== 'string' || waiver.by.length === 0) {
    out.push(`${at} must record who approved the waiver (by)`);
  } else if (AUTO_ACTOR_RE.test(waiver.by)) {
    out.push(`${at}.by '${waiver.by}' looks like an automated actor — a person or an explicit human-ratified process signature must waive`);
  }
  if (typeof waiver.reason !== 'string' || waiver.reason.trim().length < 20) {
    out.push(`${at} must record a real reason (>= 20 characters)`);
  }
  const severity = /(P[0-9])(?:\b|:)/.exec(blocker)?.[1];
  if (severity === undefined) {
    out.push(`${at}: cannot extract a severity (P0/P1/...) from the blocker to check the waiver`);
  } else if (waiver.severity !== severity) {
    out.push(`${at}.severity '${String(waiver.severity)}' does not match the blocker severity ${severity}`);
  }
  if (typeof waiver.expiry !== 'string' || waiver.expiry.length === 0) {
    out.push(`${at} must record an expiry (milestone or date) — a waiver without an expiry is not limited`);
  }
  if (typeof waiver.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(waiver.date)) {
    out.push(`${at} must record the waiver date as YYYY-MM-DD`);
  }
  if (typeof waiver.adr !== 'string' || !waiver.adr.startsWith('docs/adr/')) {
    out.push(`${at} must link the limited waiver ADR (docs/adr/NNNN-...) — ТЗ requires an ADR waiver`);
  } else {
    try {
      readFileSync(join(ROOT, waiver.adr), 'utf8');
    } catch {
      out.push(`${at}: the linked ADR '${waiver.adr}' does not exist`);
    }
  }
  return out;
}

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
      } else if (AUTO_ACTOR_RE.test(m.acceptedBy)) {
        ok =
          recordFail(
            label,
            `${label}: acceptedBy '${m.acceptedBy}' looks like an automated actor — ` +
              'acceptance is a human verdict',
          ) && ok;
      }
      // --- evidence must be reproducible, not a bare statement.
      const ev = Array.isArray(m.evidence) ? m.evidence : [];
      if (ev.length === 0) {
        ok = recordFail(label, `${label}: accepted milestone must carry non-empty evidence`) && ok;
      }
      for (let e = 0; e < ev.length; e += 1) {
        for (const message of evidenceFailures(label, ev[e], e, !SELF_TEST)) {
          ok = recordFail(label, message) && ok;
        }
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
        const waiver = waivers.find((w) => w && typeof w === 'object' && w.issue === blocker);
        if (!waiver) {
          ok =
            recordFail(
              label,
              `${label}: accepted milestone has an un-waived blocking issue — ` +
                `'${blocker.slice(0, 120)}' (waive it in waivers[] with issue/by/date/severity/expiry/reason/adr)`,
            ) && ok;
        } else {
          for (const message of waiverFailures(label, blocker, waiver)) {
            ok = recordFail(label, message) && ok;
          }
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
    evidence: [
      {
        type: 'test-run',
        command: 'pnpm test -- fixture',
        result: 'fixture suite passed',
        commit: 'f00df00',
      },
    ],
    blockingIssues: [],
    waivers: [],
    ...(status === 'accepted'
      ? { acceptedCommit: 'f00df00', acceptedBy: 'self-test human' }
      : { acceptedCommit: null, acceptedBy: null }),
  });
  const goodWaiver = {
    issue: 'P1: fixture waived issue',
    by: 'fixture human reviewer',
    date: '2026-01-01',
    severity: 'P1',
    expiry: 'M4 cutover',
    reason: 'fixture waiver with a sufficiently long and real reason text',
    adr: 'docs/adr/0038-canonical-rust-kernel-core.md',
  };
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
        m.blockingIssues = [goodWaiver.issue];
        m.waivers = [goodWaiver];
        return validate([m], { parallelDevelopment: false });
      },
    ],
    // waiver signed by an automated actor : fail (human verdict)
    [
      'waiver by automated actor fails',
      () => {
        const m = base('accepted');
        m.blockingIssues = [goodWaiver.issue];
        m.waivers = [{ ...goodWaiver, by: 'agent (fixture round)' }];
        return validate([m], { parallelDevelopment: false });
      },
    ],
    // waiver with the wrong severity : fail
    [
      'waiver severity mismatch fails',
      () => {
        const m = base('accepted');
        m.blockingIssues = [goodWaiver.issue];
        m.waivers = [{ ...goodWaiver, severity: 'P2' }];
        return validate([m], { parallelDevelopment: false });
      },
    ],
    // waiver without an expiry : fail (must be limited)
    [
      'waiver without expiry fails',
      () => {
        const m = base('accepted');
        m.blockingIssues = [goodWaiver.issue];
        const { expiry, ...rest } = goodWaiver;
        void expiry;
        m.waivers = [rest];
        return validate([m], { parallelDevelopment: false });
      },
    ],
    // waiver without a linked ADR : fail (ТЗ requires an ADR waiver)
    [
      'waiver without ADR fails',
      () => {
        const m = base('accepted');
        m.blockingIssues = [goodWaiver.issue];
        const { adr, ...rest } = goodWaiver;
        void adr;
        m.waivers = [rest];
        return validate([m], { parallelDevelopment: false });
      },
    ],
    // bare-string evidence : fail (evidence must be reproducible)
    [
      'bare-string evidence fails',
      () => {
        const m = base('accepted');
        m.evidence = ['597/597 tests passed'];
        return validate([m], { parallelDevelopment: false });
      },
    ],
    // test-run evidence without a commit : fail
    [
      'test-run evidence without commit fails',
      () => {
        const m = base('accepted');
        m.evidence = [
          { type: 'test-run', command: 'pnpm test', result: 'passed' }, // no commit
        ];
        return validate([m], { parallelDevelopment: false });
      },
    ],
    // ci evidence without a URL : fail
    [
      'ci evidence without URL fails',
      () => {
        const m = base('accepted');
        m.evidence = [{ type: 'ci', result: 'run green' }];
        return validate([m], { parallelDevelopment: false });
      },
    ],
    // accepted with a P0 blocker even when waived : fail
    [
      'P0 never waivable',
      () => {
        const m = base('accepted');
        m.blockingIssues = ['P0: critical'];
        m.waivers = [{ ...goodWaiver, issue: 'P0: critical' }];
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
    // accepted by an automated actor : fail
    [
      'acceptedBy automated actor fails',
      () => {
        const m = base('accepted');
        m.acceptedBy = 'the assistant';
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
    'waiver by automated actor fails': false,
    'waiver severity mismatch fails': false,
    'waiver without expiry fails': false,
    'waiver without ADR fails': false,
    'bare-string evidence fails': false,
    'test-run evidence without commit fails': false,
    'ci evidence without URL fails': false,
    'P0 never waivable': false,
    'missing acceptedCommit': false,
    'acceptedBy automated actor fails': false,
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
  // The drill validates the PROPOSED evidence: the proposal's exit criteria
  // map carries the structured, reproducible evidence the acceptance would
  // record (command / result / commit / ciRun per exit criterion).
  const proposedEvidence =
    Array.isArray(proposal?.exitCriteriaMap) || typeof proposal?.exitCriteriaMap === 'object'
      ? Object.values(proposal.exitCriteriaMap)
      : target.evidence;
  if (Array.isArray(proposedEvidence) && proposedEvidence.length > 0) {
    target.evidence = proposedEvidence;
  }
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
