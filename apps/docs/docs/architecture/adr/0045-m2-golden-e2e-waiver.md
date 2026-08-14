---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0045-m2-golden-e2e-waiver.md
---

# ADR-0045: M2 packaged golden E2E with fault injection — limited waiver

- **Status:** accepted (limited waiver, delivered with the M2 PR, pr-kernel-golden)
- **Date:** 2026-08-15
- **Related:** [ADR-0038](0038-canonical-rust-kernel-core.md),
  [ADR-0044](0044-generation-run-step-model.md),
  [ТЗ 10/10 rev2 §17.2, §18.2](https://github.com/Disya123/NeoTavern/blob/main/NeoTavern_architecture_10_of_10_spec_2026-08-13.md)

## Context

ТЗ §17.2 defines the mandatory golden vertical slice: the full user flow on a
packaged artifact with **fault injection** — forced process death at given
fault points (including tool wait and final commit), deterministic recovery
without a repeated external effect, backup/restore drill, and secret absence
in exports. The M2 milestone (Этап 2, Golden Kernel vertical slice) delivers
the golden flow through the real Tauri host path as an honest, deterministic
**kernel-flow smoke** (`NEOTA_DESKTOP_SMOKE=1`): character → chat → user
message → `generation.start` (fake grammar) → `completed` with exactly one
24-character assistant message → `KernelHost::register_tool` → second run
durably `waiting_for_tool` → `generation.tools.list` → `generation.tool.result`
→ completed with a second assistant message. The smoke exits non-zero on any
failed assertion and covers the durable run/step/tool-loop model of
ADR-0044 over the real packaged host path.

What M2 does **not** yet deliver is the §17.2 **fault-injection and recovery
suite**: forced process death at tool wait / final commit with deterministic
recovery, crash-window backups/restores, and the Windows lock-contention
drill. Those are §18.2 merge/release-branch checks (packaged Tauri golden E2E,
backup/restore drill, Windows activation suite) — not the Этап 2 exit
criterion, which is "golden vertical slice passes on packaged Desktop without
the Fastify product core" (satisfied by the smoke).

## Decision

1. **M2 is acceptable with the smoke as its packaged-flow evidence.** The
   real host path and the durable model are proven on the packaged artifact;
   the smoke is the honest fulfillment of the Этап 2 packaged-flow exit
   criterion.
2. **The §17.2 fault-injection golden E2E is waived for M2 as a limited
   P2 waiver**, with expiry at the release gate: the full suite (crash at
   tool wait / final commit, deterministic recovery, no repeated external
   effect, backup/restore drill, secret absence in exports) must land before
   the merge/release branch per §18.2. An expired waiver re-opens the M2
   blocker.
3. **No silent claim.** The ledger, the PR description and the capability
   matrix keep the smoke honestly named (`kernel flow smoke`), and the open
   item stays recorded in the M2 blockingIssues/waivers pair until the suite
   lands.
4. **CI keeps the smoke green** on the packaged desktop build; the waiver
   does not relax any security requirement.

## Alternatives considered

- **Hold M2 acceptance until the full §17.2 suite exists.** Rejected: §17.2
  is the program acceptance suite and §18.2 assigns the fault-injection and
  recovery checks to the merge/release branch; requiring them inside Этап 2
  would block the vertical-slice milestone on release-gate work and force the
  sequence out of order (migration/restore fault injection belongs with the
  Этап 3 data cutover context).
- **Remove the packaged-flow requirement from M2 entirely.** Rejected: the
  honest smoke is a real, meaningful fulfillment of the packaged-flow exit
  criterion; deleting the requirement would hide the gap instead of recording
  it.
- **Rename the smoke 'golden E2E' and claim §17.2.** Rejected: dishonest —
  the fault-injection and recovery cases are genuinely absent.

## Consequences

- M2's packaged-flow evidence is the kernel-flow smoke; the §17.2
  fault-injection suite is an explicit open item tracked to the release gate
  (M5/merge-branch context).
- The waiver's expiry (release gate) is machine-checked by the milestone gate
  (`scripts/check-milestone-gates.mjs`); an expired waiver fails CI.
- The honest naming convention established in M1 (a self-check is called a
  smoke until the full acceptance suite exists) continues into M2 and the
  later milestones.
