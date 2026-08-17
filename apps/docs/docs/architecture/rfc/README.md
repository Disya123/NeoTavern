---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/rfc/README.md
---

# RFC / proposals

Non-canonical decision documents. They do **not** supersede
[ADR](../adr/README.md), the [architecture index](../architecture/README.md),
or the target-architecture ТЗ until a later ADR is `Accepted`.

Code PRs MUST NOT treat files in this folder as a rewrite mandate.

| RFC                                                                                 | Status                                                                                                                                       |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [NeoUI v4 — Android presentation backend](neoui-v4-android-presentation-backend.md) | Draft **4.5**. Gate P `UNDECIDED`. Normative M0 `NOT_ENTERED`. Track D compositor forbidden until Gate P. Pre-gate: M-1 week plus existing D1a runner artifact only — no new compositor prototype, no D1b. |
| [BaselineReport M-1](m1-baseline-report.md)                                         | Morning AVD `MEASURED` (emulator-only). Evening A/A0/B **`INVALID_FOR_COMPARISON`**. Physical device set **`BLOCKED`**. Gate P `UNDECIDED`. Not a Track D GO. |
| [M0-D1a paint-seam probe](m0-d1a-probe.md)                                          | Desktop `PRE-GATE / BLOCKED`. Evening AVD **`BLOCKED / NON-ADMISSIBLE`** (APK `.so` ≠ current source). Not D1a PASS. |
| [Gate P decision draft](gate-p-decision-draft.md)                                   | **Unsigned.** Default: `UNDECIDED` until valid M-1. `P0` only if owner refuses live glass as MUST. |
