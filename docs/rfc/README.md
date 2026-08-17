# RFC / proposals

Non-canonical decision documents. They do **not** supersede
[ADR](../adr/README.md), the [architecture index](../architecture/README.md),
or the target-architecture ТЗ until a later ADR is `Accepted`.

Code PRs MUST NOT treat files in this folder as a rewrite mandate.

| RFC                                                                                 | Status                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [NeoUI v4 — Android presentation backend](neoui-v4-android-presentation-backend.md) | Draft **4.5**. Gate P **`GateP:P1` / PASSED**. Normative M0 **`ENTERED`**, not PASS. **M0-D1a PASS**. **M0-D1b PASS**. `D1=Track D GO` not granted. |
| [BaselineReport M-1](m1-baseline-report.md)                                         | Morning AVD `MEASURED` (emulator-only). Evening A/A0/B **`INVALID_FOR_COMPARISON`**. Physical device set **`BLOCKED`**. Owner waiver: incomplete M-1 does not block P1 and does not raise these results. |
| [M0-D1a paint-seam probe](m0-d1a-probe.md)                                          | Program **M0-D1a PASS** (host-side). Probe log `capture=false` expected. PRE-GATE desktop/AVD stay unadmitted. |
| [M0-D1a host adjudication](m0-d1a-adjudication.json)                                | `android_gpu_capture=true`, `capture_driver=Vulkan`, `d1a_verdict=PASS`. Lab-only re-run: `node scripts/m0-d1a-adjudicate.mjs`. |
| [M0-D1b moving sample](m0-d1b-probe.md)                                             | Program **M0-D1b PASS** (host-side). Probe log `capture=false`. D1a JSON unchanged. |
| [M0-D1b host adjudication](m0-d1b-adjudication.json)                                | `android_gpu_capture=true`, `capture_driver=Vulkan`, `d1b_verdict=PASS`. Lab: `node scripts/m0-d1b-adjudicate.mjs`. |
| [M0-D1b physical capture runbook](m0-d1b-physical-runbook.md)                       | Lab procedure. Admitted Vulkan stamp `2026-08-17T18-15-34-453Z`. |
| [Gate P decision record](gate-p-decision-draft.md)                                  | **Signed `GateP:P1`** 2026-08-17, owner `Disya123 <gamedisya@gmail.com>`. Explicit incomplete-M-1 waiver. D1a follow-on PASS is not a re-signature. |
| [M0-D1a physical capture runbook](m0-d1a-physical-runbook.md)                       | Lab procedure. Capture tool **RenderDoc v1.45**. GLES 1437-byte file is `WRONG_API_CAPTURE`. Admitted Vulkan stamp `2026-08-17T17-18-59-431Z`. |
