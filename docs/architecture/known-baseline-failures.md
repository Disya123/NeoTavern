# Known baseline failures

**Status:** recorded, **not** waived, **not** a green full baseline.
**Milestone B:** remains **STARTED**. Production cutover remains forbidden.

These failures do **not** make the independent PERF-18/19/20 physical
evidence inadmissible (`docs/rfc/perf-18-20-adjudication.json`). They
**must** be fixed or given an explicit owner/waiver before Milestone B
PASS. The machine-checkable gate is
[milestone-b-exit.json](../rfc/milestone-b-exit.json); it will not stamp
`Milestone B = PASS` while these rows are `OPEN`. Do not mass-format or silently skip them as part of an unrelated
slice.

## `KNOWN_BASELINE_FAILURE` — Prettier mass drift

| Field       | Value                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Id          | `prettier-mass-drift`                                                                                                                            |
| Command     | `pnpm format:check`                                                                                                                              |
| Fingerprint | Prettier `--check` fails on a large **pre-existing** set of files (hundreds), not on the PERF-18/19/20 probe/adjudication or this recovery slice |
| Owner       | unassigned; required before Milestone B PASS                                                                                                     |
| Waiver      | none                                                                                                                                             |

Do not run `pnpm format` across the tree as a drive-by. A dedicated slice
must either restore a clean Prettier baseline or record an owner/waiver
with a deadline.

## `KNOWN_BASELINE_FAILURE` — `runtime-kernel::diagnostics_export_counts_generation_runs`

| Field       | Value                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Id          | `runtime-kernel.diagnostics_export_counts_generation_runs`                                                                        |
| Crate       | `runtime-kernel`                                                                                                                  |
| Test        | `diagnostics_export_counts_generation_runs`                                                                                       |
| File        | `crates/runtime-kernel/tests/kernel_settings_diagnostics.rs`                                                                      |
| Fingerprint | `generationRuns.waiting` expected `1`, observed `0`                                                                               |
| Seed        | three `generation_runs` rows: `completed`, `failed`, and `streaming` with `pending_tool_call_json` set (derived waiting-for-tool) |
| Owner       | runtime-kernel                                                                                                                    |
| Status      | **FIXED**                                                                                                                         |
| Waiver      | none                                                                                                                              |

Waiting-for-tool is the derived pair `status = streaming` **and**
`pending_tool_call_json IS NOT NULL`. Diagnostics counts that pair, not
the marker alone. The accounting test seeds a **live** lease, then uses
`generation.get` as the startup-recovery barrier (the writer recovers
before serving unaries) and asserts wire `waiting_for_tool` before
reading `generationRuns.waiting`. An expired-lease companion proves
recovery interrupts the attempt and the waiting counter becomes `0`.
Do not replace the live-lease expected `1` with `0`.
