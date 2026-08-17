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
| [BaselineReport M-1](m1-baseline-report.md)                                         | Host M-1 closed 2026-08-17. Emulator-only evidence. Physical low/mid + high-refresh **BLOCKED** (none attached). Gate P still `UNDECIDED`. Not a Track D GO. |
| [M0-D1a paint-seam probe](m0-d1a-probe.md)                                          | **PRE-GATE / BLOCKED** runner. Desktop Vulkan API timeline + AVD GLES 3.1 100-frame. Not admissible M0 until Gate P + GPU capture + phone. |
| [Gate P decision draft](gate-p-decision-draft.md)                                   | **Unsigned.** `decision`/`owner`/`date` empty. Technical recommendation `GateP:P0` until a high-refresh phone BaselineReport exists. |
