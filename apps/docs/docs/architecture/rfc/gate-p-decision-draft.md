---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/rfc/gate-p-decision-draft.md
---

# Gate P decision record (signed)

**Status:** **signed** `GateP:P1` / **PASSED** on 2026-08-17. This is the
product-owner decision record from RFC §0.3. It is **not** an ADR, **not**
`D1=Track D GO`, **not** M0 PASS, and **not** a D1a PASS.

**RFC:** [neoui-v4-android-presentation-backend.md](neoui-v4-android-presentation-backend.md) §0.3  
**Evidence:** [BaselineReport M-1](m1-baseline-report.md), [M0-D1a probe](m0-d1a-probe.md)

Prefix `GateP:` is required so this is not confused with plugin tiers
`Plugin:P0…P5`.

## Record (signed)

```text
decision: GateP:P1
owner: Disya123 <gamedisya@gmail.com> (NeoTavern product owner; authenticated git identity)
date: 2026-08-17
input evidence: docs/rfc/m1-baseline-report.md as of this signature, with the recorded limitations (physical device set BLOCKED; evening A/A0/B INVALID_FOR_COMPARISON; morning AVD emulator-only MEASURED). PRE-GATE D1a remains BLOCKED / NON-ADMISSIBLE and is not admitted as D1a PASS.
qualified device definition: physical Android without a software renderer; supported production GPU backend; required compute and sampleable-texture capabilities; proven D1a/D1b PASS and the established performance thresholds
allowed degraded semantics: on unqualified devices, under thermal pressure, or under memory pressure, a static/simplified material without live backdrop blur is allowed; application functionality is preserved
critical Android journeys: launch and open chat; continuous scroll; live-glass header and composer; IME/keyboard; images; media/surface interleaving; lifecycle and recovery
budget/capacity ceiling: until a further owner review, bounded M0 and the required technical preparation are allowed; production migration budget remains zero until M0 PASS and D1/D2 decisions
compatibility: React/WebView, Theme SDK, and Plugin SDK are not replaced until the corresponding decisions and ADRs
revisit/kill trigger: any M0 NO-GO; a required foundational private fork; a CPU readback or cross-device path; no viable physical Android backend; or exceeding the approved M0 scope
```

## Explicit owner waiver (incomplete physical M-1)

The current M-1 does **not** contain a valid RFC §0.3.1 physical device set.
The owner **knowingly** accepts that limitation:

- incomplete physical M-1 is **not** a technical PASS of the measurement week;
- it **does not** raise morning AVD A/A0/B from emulator-only `MEASURED`;
- it **does not** reclassify evening A/A0/B (`INVALID_FOR_COMPARISON`);
- it **does not** attach a physical low/mid or high-refresh reference;
- it **does not** raise PRE-GATE D1a (desktop `BLOCKED`; evening AVD
  `BLOCKED / NON-ADMISSIBLE`) to D1a PASS or to admitted M0 evidence;
- it **does not** block the **product** choice `GateP:P1`.

M0 exists to establish **technical feasibility** of live glass on
capability-qualified devices. A later valid physical M-1 remains required
before D1/TrackComparison claims about high-refresh cost.

## Consequence of `GateP:P1`

Live backdrop glass on Android is MUST **only** on capability-qualified
devices, as defined above. Unqualified devices use the allowed degraded
semantics.

| Object                                          | Status after this signature                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| Gate P                                          | **`GateP:P1` / PASSED**                                                    |
| Normative M0                                    | **`ENTERED`** (entry allowed; **not** PASS)                                |
| M0-D1a                                          | may start from pinned source; existing PRE-GATE artifacts are **not** PASS |
| M0-D1b                                          | **`NOT_STARTED`** until D1a PASS                                           |
| M0-D2                                           | **`NOT_STARTED`** until D1a and D1b PASS                                   |
| `D1=Track D GO`                                 | **`NOT_GRANTED`** until M0 PASS and TrackComparison                        |
| Production React/WebView, Theme SDK, Plugin SDK | unchanged                                                                  |

## Required next technical chain (does not reuse PRE-GATE APK)

```text
clean source bundle
→ new APK hash (built from that bundle, apk_linkage=BOUND via --bind-apk)
→ physical Android production GPU
→ GPU capture (pass/resource order, two accumulator reads at barriers)
→ D1a verdict
```

Only **`D1a PASS`** allows D1b. Counters and an API timeline do **not**
replace GPU capture.

## Follow-on (not part of the signed Gate P body)

The signed record above is unchanged. After that signature, host-side
adjudication of the physical Vulkan capture
[`m0-d1a-adjudication.json`](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/m0-d1a-adjudication.json) set:

| Object          | Status after D1a admission                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| Gate P          | still **`GateP:P1` / PASSED**                                                                             |
| Normative M0    | still **`ENTERED`**, not PASS                                                                             |
| M0-D1a          | **PASS** (host-side; probe log `capture=false`)                                                           |
| M0-D1b          | **PASS** (see [m0-d1b-adjudication.json](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/m0-d1b-adjudication.json)); D1a JSON still records `NOT_STARTED` |
| `D1=Track D GO` | still **`NOT_GRANTED`**                                                                                   |

## Follow-on after M0-D2 admission (not part of the signed Gate P body)

Host-side adjudication [`m0-d2-adjudication.json`](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/m0-d2-adjudication.json)
and [m0-track-comparison.md](m0-track-comparison.md) set:

| Object          | Status after D2 admission                             |
| --------------- | ----------------------------------------------------- |
| Gate P          | still **`GateP:P1` / PASSED** (signed body unchanged) |
| Normative M0    | technical **PASS**                                    |
| M0-D2           | **PASS** (host-side; probe log `capture=false`)       |
| TrackComparison | **published**; opens `D1=Track D GO`                  |
| `D1=Track D GO` | still **`NOT_GRANTED`**                               |

## Follow-on after D1/D2 signature (not part of the signed Gate P body)

[`d1-d2-decision.md`](d1-d2-decision.md) / [ADR-0049](../adr/0049-track-d-dioxus-presentation.md):

| Object                   | Status after D1/D2 signature                          |
| ------------------------ | ----------------------------------------------------- |
| Gate P                   | still **`GateP:P1` / PASSED** (signed body unchanged) |
| `D1=Track D GO`          | **GRANTED**                                           |
| `D2=Dioxus+Blitz GO`     | **GRANTED**                                           |
| `D3`                     | **DEFERRED**                                          |
| Production WebView/React | rollback default; cutover not declared                |

## Classified input evidence (unchanged by this signature)

| Track                                         | Evidence status                 | What may be cited                    | Must not be cited as                           |
| --------------------------------------------- | ------------------------------- | ------------------------------------ | ---------------------------------------------- |
| A morning AVD (58 337 647 B APK, HostConnect) | `MEASURED` emulator-only 60 Hz  | rAF ≈ 57.5; live glass on `file://`  | high-refresh cost; Gate P device-set complete  |
| A0 morning AVD (same APK)                     | `MEASURED` emulator-only        | rAF ≈ 57.8; glass Off                | product-level live-glass delta                 |
| B morning AVD (same APK)                      | `MEASURED` emulator-only        | AssetLoader HTTPS loaded             | compositor upgrade                             |
| A/A0/B evening AVD                            | **`INVALID_FOR_COMPARISON`**    | raw dumps exist                      | A vs A0 vs B, or vs morning table              |
| Physical low/mid + high-refresh               | **`BLOCKED`**                   | none attached                        | a valid M-1 PASS                               |
| C                                             | `NOT MEASURED`                  | —                                    | native-toolkit GO                              |
| D / D1a AVD evening APK                       | **`BLOCKED / NON-ADMISSIBLE`**  | older `.so`, no `timeline=`          | D1a PASS                                       |
| D / D1a desktop Vulkan                        | `PRE-GATE / BLOCKED`            | API timeline; 0 readback / 0 xdev    | AGI/RenderDoc; Android production backend      |
| D / D1a physical Vulkan (Adreno 710)          | **PASS** (host-side 2026-08-17) | RenderDoc `.rdc` + XML; eight checks | M0 PASS; `D1=Track D GO`; probe `capture=true` |
