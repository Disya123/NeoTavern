---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/rfc/m0-track-comparison.md
---

# TrackComparison (final, after M0)

**Status:** published. This record **opens** the owner decision
`D1=Track D GO`. It does **not** grant that decision.
`D1=Track D GO` remains **`NOT_GRANTED`**.

**RFC:** [neoui-v4-android-presentation-backend.md](neoui-v4-android-presentation-backend.md) §0.4  
**Gate P:** signed `GateP:P1` ([gate-p-decision-draft.md](gate-p-decision-draft.md)); incomplete physical M-1 waiver unchanged  
**M0:** technical **PASS** after host-side [M0-D1a](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/m0-d1a-adjudication.json),
[M0-D1b](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/m0-d1b-adjudication.json), and [M0-D2](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/m0-d2-adjudication.json)

Historical D1a/D1b admission JSON is not rewritten.

## What this comparison may and may not claim

RFC §0.4 requires the same physical devices and the same content fixture.
That matched comparison **does not exist**:

- Physical M-1 low/mid + high-refresh device set is **`BLOCKED`** (none
  attached during M-1). Morning A/A0/B is **`MEASURED` emulator-only** on a
  60 Hz AVD. Evening A/A0/B is **`INVALID_FOR_COMPARISON`**. See
  [m1-baseline-report.md](m1-baseline-report.md).
- Track D M0 was measured on Xiaomi `8f5c2b7c` / `23122PCD1G` / Adreno 710
  with a **different** fixture (debug paint-seam / moving-sample probe, not
  HostConnect rAF).
- Track C was **not measured**.
- Rows with status `estimated` or `unavailable` **cannot win D1**.

The owner may still accept Track D as the only Gate-P-satisfying path that
was proven on a physical production GPU. That is a **product decision**, not
a benchmark win against A/B/C on a shared scroll fixture.

## Tracks

| Track  | Backend                                                | Evidence status                                                                            | Same device as D M0? | Same content fixture as M-1?           | May win D1 on this record?                               |
| ------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ | -------------------- | -------------------------------------- | -------------------------------------------------------- |
| A / A0 | WebView `file://`, live glass / glass off              | `MEASURED` emulator-only; physical **`BLOCKED`**; evening AVD **`INVALID_FOR_COMPARISON`** | no                   | M-1 HostConnect (AVD only)             | **no** (not physical Gate P device set)                  |
| B      | WebView + AssetLoader HTTPS                            | same as A                                                                                  | no                   | M-1 HostConnect (AVD only)             | **no**                                                   |
| C      | Compose/Flutter/other toolkit, no product compositor   | **`NOT MEASURED`**                                                                         | n/a                  | n/a                                    | **no**                                                   |
| D      | product compositor + Dioxus/Blitz producer (candidate) | M0-D1a/D1b/D2 **PASS** (host-side Vulkan)                                                  | Xiaomi Adreno 710    | **no** — M0 probe, not M-1 HostConnect | **not granted here**; this table only opens the decision |

## RFC §0.4 field matrix

Evidence status values: `measured` | `estimated` | `unavailable`.

| Field                                             | A / A0 / B                                                                                | C                             | D (M0)                                                                                                                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Physical devices                                  | **unavailable** (M-1 physical **BLOCKED**). AVD `MEASURED` 60 Hz only; not RFC device set | **unavailable**               | **measured** — Xiaomi `8f5c2b7c` / Adreno 710 / Vulkan. Not the M-1 pair (low/mid + high-refresh reference)                                                                      |
| Content fixture                                   | HostConnect idle (not a scrolling chat). AVD only                                         | **unavailable**               | M0 paint-seam probe (`M0D1aActivity` / `M0D1bActivity` / `M0D2Activity`). **Not** the M-1 HostConnect fixture                                                                    |
| Requested / observed refresh                      | AVD: requested=observed **60.000004 Hz** (`already-max`). Physical A/B **unavailable**    | **unavailable**               | D2 probe log: requested **120.00001 Hz** mode 2, observed **120.00001 Hz** mode 2 (`already-max` on this panel). **measured** for the probe Activity, not for production WebView |
| Frame timeline / application-caused misses        | AVD rAF ≈ 57.5–57.8 Hz, misses 67–77 / 30 s. Physical **unavailable**. rAF ≠ compositor   | **unavailable**               | Compositor 1000-frame blit loop. `frames=1000`, `sampled_gen=999`, `render_polls=0`. **Not** an M-1 rAF sampler. Application-caused misses vs vsync: **unavailable**             |
| Live / static / no-glass semantic                 | AVD: A/B Live, A0 Off. Physical **unavailable**                                           | **unavailable**               | Probe: two glass barriers + moving sample over live accumulator. **measured** on the probe; not a product chat header                                                            |
| Thermal / power snapshot                          | AVD thermal apply=0 / observed=0. Physical **unavailable**                                | **unavailable**               | **unavailable** on the M0 probe (short GPU run, no `m1-thermal` / power trace)                                                                                                   |
| Prototype effort                                  | Host extras + capture script (M-1 week)                                                   | **estimated** (not started)   | **measured** engineering: D1a/D1b compositor probe + D2 Dioxus/Blitz seam + 65-line paint hook + RenderDoc in-app capture                                                        |
| Estimated migration surface                       | keep WebView; Theme SDK / Plugin SDK unchanged                                            | **estimated** — new native UI | **estimated** — Android first-party UI on Dioxus/Blitz; React/Web Theme SDK/Plugin frontend not replaced until D2/D3 GO + ADR. Local paint hook is not upstream                  |
| Known platform / OEM blockers                     | AVD cannot vote a second refresh mode; physical phones missing at M-1                     | **unavailable**               | Xiaomi 120 Hz panel worked for the probe. OEM/WebView 120 Hz cost **unavailable**. AGI 3.3.3 remains `CAPTURED_BUT_NOT_REPLAYABLE`; admitted path is RenderDoc Vulkan            |
| GPU capture (pass order, no readback, one device) | **unavailable**                                                                           | **unavailable**               | **measured** — D1a ROI/glass order; D1b and D2 `moving-blit:g120 → roi:2 → glass:2:g120`; `devices=1`, `readbacks=0`, `xdev=0`, `capture_driver=Vulkan`                          |

## Track D M0 admission (measured)

| Object        | Record                                                                                                 | Verdict                        |
| ------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------ |
| M0-D1a        | [m0-d1a-adjudication.json](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/m0-d1a-adjudication.json) stamp `2026-08-17T17-18-59-431Z`                  | **PASS**                       |
| M0-D1b        | [m0-d1b-adjudication.json](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/m0-d1b-adjudication.json) stamp `2026-08-17T18-15-34-453Z`                  | **PASS**                       |
| M0-D2         | [m0-d2-adjudication.json](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/m0-d2-adjudication.json) stamp `2026-08-17T20-11-27-178Z`                    | **PASS**                       |
| D2 APK        | commit `3036422`, SHA-256 `ff425359…`, `apk_linkage=BOUND`, `evidence_dirty=false`                     | bound                          |
| D2 producer   | `dioxus-virtualdom+blitz-paint-traversal+host-node-marker`, `glass_from_hook=2`                        | producer seam                  |
| D2 motion     | `pass_compiles=1`, `layout_rebuilds=0`, `paint_scene_rebuilds=0`, `sampled_gen=999`, `capture_gen=120` | compile-once                   |
| Dirty-tree D2 | control `2026-08-17T19-34-27-050Z`, capture `2026-08-17T19-41-18-304Z`                                 | **REHEARSAL / NON-ADMISSIBLE** |

Technical **M0 PASS** means the RFC M0 kill-probe chain (D1a + D1b + D2)
admitted on a physical production GPU. It is **not** production NeoCompositor,
**not** `D2=Dioxus` GO, and **not** `D1=Track D GO`.

Missing capabilities remain: upstream `host_node_marker`; typed Blitz Glass
node. The 65-line patch is bounded, not a foundational private fork.

## Decision this record opens

```text
question: D1 = Track D GO ?
opened_by: this TrackComparison
current: NOT_GRANTED
must_not_cite_as_yes: M0 PASS, D1a/D1b/D2 JSON, this file's existence
cheapest_track_that_satisfies_Gate_P_on_a_matched_physical_fixture: not established
honest_alternative: keep WebView (A/B) until a physical M-1 exists, or accept D on M0 feasibility plus the Gate P waiver
```

Owner `Disya123 <gamedisya@gmail.com>` still has to sign `D1=Track D GO` or
choose another track. D3 remains a separate decision.
