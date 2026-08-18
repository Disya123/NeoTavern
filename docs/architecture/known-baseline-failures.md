# Known baseline failures

**Status:** recorded, **not** waived, **not** a green full baseline.
**Milestone B:** remains **STARTED**. Production cutover remains forbidden.

These failures do **not** make the independent PERF-18/19/20 physical
evidence inadmissible (`docs/rfc/perf-18-20-adjudication.json`). They
**must** be fixed or given an explicit owner/waiver before Milestone B
PASS. Do not mass-format or silently skip them as part of an unrelated
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
| Owner       | unassigned; required before Milestone B PASS                                                                                      |
| Waiver      | none                                                                                                                              |

The export still counts `total` / `completed` / `failed`. The waiting
counter is the failing assertion. Do not treat `pnpm crates:test` / a
full kernel suite as green while this test fails.
