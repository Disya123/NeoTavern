---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/architecture/known-baseline-failures.md
---

# Known baseline failures

**Status:** both listed rows are **FIXED**. This is not Milestone B PASS
and not a waiver. Production cutover remains forbidden.

These rows do **not** make the independent PERF-18/19/20 physical
evidence inadmissible (`docs/rfc/perf-18-20-adjudication.json`). The
machine-checkable gate is
[milestone-b-exit.json](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/milestone-b-exit.json); it will not stamp
`Milestone B = PASS` while remaining PERF evidence is missing.

## `KNOWN_BASELINE_FAILURE` — Prettier mass drift

| Field       | Value                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Id          | `prettier-mass-drift`                                                                                                                            |
| Command     | `pnpm format:check`                                                                                                                              |
| Fingerprint | Prettier `--check` fails on a large **pre-existing** set of files (hundreds), not on the PERF-18/19/20 probe/adjudication or this recovery slice |
| Owner       | presentation / docs                                                                                                                              |
| Status      | **FIXED**                                                                                                                                        |
| Waiver      | none                                                                                                                                             |

Generated, vendor, and capture artifacts are ignored **by path with a
reason** in `.prettierignore` (codegen fixtures, the Docusaurus
`docs/` mirror, the generated capability matrix, `crates/vendor/`,
starter JSON, the local TZ dump). Maintained source and `docs/` were
formatted in a dedicated style commit. Broad masks such as `docs/**` or
`crates/**` are not used. `pnpm format:check` is green.

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
