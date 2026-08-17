# RFC / proposals

Non-canonical decision documents. They do **not** supersede
[ADR](../adr/README.md), the [architecture index](../architecture/README.md),
or the target-architecture ТЗ until a later ADR is `Accepted`.

Code PRs MUST NOT treat files in this folder as a rewrite mandate.

| RFC                                                                                 | Status                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [NeoUI v4 — Android presentation backend](neoui-v4-android-presentation-backend.md) | Draft **4.5**. Gate P **`GateP:P1` / PASSED**. Normative M0 **`ENTERED`**, not PASS. PRE-GATE D1a artifacts not admitted. D1b until D1a PASS.                                                            |
| [BaselineReport M-1](m1-baseline-report.md)                                         | Morning AVD `MEASURED` (emulator-only). Evening A/A0/B **`INVALID_FOR_COMPARISON`**. Physical device set **`BLOCKED`**. Owner waiver: incomplete M-1 does not block P1 and does not raise these results. |
| [M0-D1a paint-seam probe](m0-d1a-probe.md)                                          | Desktop `PRE-GATE / BLOCKED`. Evening AVD **`BLOCKED / NON-ADMISSIBLE`**. Not D1a PASS. Repeat from pinned source after P1.                                                                              |
| [Gate P decision record](gate-p-decision-draft.md)                                  | **Signed `GateP:P1`** 2026-08-17, owner `Disya123 <gamedisya@gmail.com>`. Explicit incomplete-M-1 waiver.                                                                                                |
| [M0-D1a physical capture runbook](m0-d1a-physical-runbook.md)                       | Lab procedure. **`capture_host=READY`** (AGI 3.3.3 at `E:\agi`). **`physical_device=BLOCKED_EXTERNAL`**. Not a PASS.                                                                                     |
