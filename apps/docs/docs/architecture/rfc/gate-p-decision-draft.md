---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/rfc/gate-p-decision-draft.md
---

# Gate P decision draft (unsigned)

**Status:** draft for product owner. **Not signed.** `decision` / `owner` /
`date` remain empty, so Gate P stays `UNDECIDED`. This file is not an ADR,
not a Track D GO, and not normative M0.

**RFC:** [neoui-v4-android-presentation-backend.md](neoui-v4-android-presentation-backend.md) §0.3  
**Evidence:** [BaselineReport M-1](m1-baseline-report.md), [M0-D1a probe](m0-d1a-probe.md)

Prefix `GateP:` is required so this is not confused with plugin tiers
`Plugin:P0…P5`.

A missing lab (no phone) is **not** a product choice of `GateP:P0`. Lab
shortage keeps the gate `UNDECIDED` until a **valid** M-1 exists, or until
the owner explicitly decides live glass is not MUST.

## Record (unsigned)

```text
decision:
owner:
date:
input evidence: no valid M-1 for Gate P (physical device set BLOCKED; evening A/A0/B INVALID_FOR_COMPARISON). Morning AVD A/A0/B is emulator-only MEASURED, not a substitute for the RFC device set. PRE-GATE D1a is BLOCKED / NON-ADMISSIBLE against current source (installed APK .so ≠ pinned bundle).
qualified device definition: NOT SET
allowed degraded semantics: NOT SET
critical Android journeys: NOT SET
budget/capacity ceiling: NOT SET
revisit/kill trigger: NOT SET
```

Empty `decision` / `owner` / `date` means the gate is **not** passed.

## Options

| Choice | Meaning | Consequence if signed |
| --- | --- | --- |
| `GateP:P0` | live backdrop glass on Android is **not** MUST | Track D closes. GPU capture and D1b are not required. Cheap WebView / native-toolkit work remains |
| `GateP:P1` | live glass is MUST **only** on capability-qualified devices | First: valid physical M-1 (same APK, same content fixture, low/mid + high-refresh). Then sign. Then M0-D1a from pinned source |
| `GateP:P2` | live glass is MUST on the **entire** supported Android matrix | Same as P1, plus a lower-bound matrix, low-tier evidence, and staffing/thermal/degraded-mode budget. Forbidden without those |

## Allowed outcomes (only these three)

1. **Owner signs `GateP:P0`.** Track D compositor program closes. Capture and
   D1b are not needed. This is a product refusal of live glass as MUST, not
   a lab-shortage default.
2. **Owner considers `P1` or `P2`.** Do **not** sign yet. First attach
   physical low/mid and high-refresh devices, rebuild **one** APK, run A/A0/B
   on the **same** content fixture, publish a valid BaselineReport M-1, then
   sign Gate P.
3. **Owner does not choose.** Everything stays stopped: M0 `NOT_ENTERED`,
   D1b `NOT_STARTED`, `D1=Track D GO` `NOT_GRANTED`.

## After a `P1`/`P2` signature only

Repeat D1a from pinned source. Do not reuse the evening AVD APK or a dirty
unrelated tree:

```text
clean source bundle
→ new APK hash (built from that bundle)
→ physical Android production GPU
→ GPU capture (pass/resource order, two accumulator reads)
→ D1a verdict
```

Only **`D1a PASS`** allows D1b. Technical compositor implementation stays
stopped until that PASS.

## Comparison (classified)

| Track | Evidence status | What may be cited | Must not be cited as |
| --- | --- | --- | --- |
| A morning AVD (58 337 647 B APK, HostConnect) | `MEASURED` emulator-only 60 Hz | rAF ≈ 57.5; live glass on `file://` | high-refresh cost; Gate P device-set complete |
| A0 morning AVD (same APK) | `MEASURED` emulator-only | rAF ≈ 57.8; glass Off | product-level live-glass delta |
| B morning AVD (same APK) | `MEASURED` emulator-only | AssetLoader HTTPS loaded | compositor upgrade |
| A/A0/B evening AVD | **`INVALID_FOR_COMPARISON`** | raw dumps exist | A vs A0 vs B, or vs morning table (different APK **and** different screens) |
| Physical low/mid + high-refresh | **`BLOCKED`** | none attached | anything |
| C | `NOT MEASURED` | — | native-toolkit GO |
| D / D1a AVD evening APK | **`BLOCKED / NON-ADMISSIBLE`** | older `.so`, no `timeline=`, ≠ current bundle | D1a PASS, GPU capture, phone Vulkan |
| D / D1a desktop Vulkan | `PRE-GATE / BLOCKED` | API timeline; 0 readback / 0 xdev | AGI/RenderDoc; Android production backend |

## Unsigned note to the owner (not a recommendation of P0)

- Default while unsigned: **`UNDECIDED` until a valid M-1** (RFC device set,
  same APK, same content fixture).
- Choose **`GateP:P0` only if** live backdrop glass on Android is not a
  product MUST. Missing phones do not imply P0.
- Choose to **consider P1/P2** only together with a plan to collect that
  valid M-1, then sign, then repeat D1a from a clean pinned bundle.
- `GateP:P2` remains forbidden until low-tier matrix and thermal/degraded
  budget exist.

## Explicit non-actions

- Product owner has **not** signed `GateP:P0|P1|P2`.
- Normative Milestone 0 stays `NOT_ENTERED`.
- `M0-D1b` stays `NOT_STARTED`.
- `D1=Track D GO` stays `NOT_GRANTED`.
- Production React/WebView, Theme SDK, and Plugin SDK are unchanged.
- No further compositor/probe implementation until one of the three
  outcomes above is taken.
