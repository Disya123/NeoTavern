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

## Record (unsigned)

```text
decision:
owner:
date:
input evidence: BaselineReport M-1 (emulator-only 2026-08-17; physical devices BLOCKED 2026-08-17 evening; evening AVD recapture used a different 44 432 284-byte APK and is not the canonical fixture) + PRE-GATE D1a runner (desktop Vulkan API timeline + AVD GLES 3.1 100-frame; GPU capture absent; phone Vulkan absent)
qualified device definition: NOT SET — no physical low/mid or high-refresh reference was attached
allowed degraded semantics: NOT SET
critical Android journeys: NOT SET (proposal default remains packaged chat workspace over WebView)
budget/capacity ceiling: NOT SET
revisit/kill trigger: NOT SET
```

Empty `decision` / `owner` / `date` means the gate is **not** passed.

## Options

| Choice | Meaning | Consequence if signed |
| --- | --- | --- |
| `GateP:P0` | live backdrop glass on Android is **not** MUST | Track D compositor program closes as surplus; cheap WebView / native-toolkit optimization remains |
| `GateP:P1` | live glass is MUST **only** on capability-qualified devices | M0 may start after this record is signed; needs device matrix + degraded semantics + ABI justification |
| `GateP:P2` | live glass is MUST on the **entire** supported Android matrix | Forbidden without a lower-bound matrix, low-tier evidence, and staffing/thermal/degraded-mode budget |

## Comparison from measured / blocked evidence

| Track | Evidence status | Refresh | Live-glass semantic | What it showed | What it did not show |
| --- | --- | --- | --- | --- | --- |
| A (WebView + live glass, `file://`) | **MEASURED** emulator-only; **BLOCKED** on physical low/mid and high-refresh | AVD 60 Hz only (`already-max`) | Live | rAF ≈ 57.5 Hz, 77 misses / 63 streak on idle HostConnect | 120 Hz phone, input-to-present, scrolling chat |
| A0 (WebView, glass off) | same | same | Off | rAF ≈ 57.8 Hz — delta vs A is noise on this AVD | product-level cost of live glass on a high-refresh panel |
| B (AssetLoader HTTPS origin) | same | same | Live | document served; rAF ≈ 57.6 Hz | compositor upgrade; SPA rewrite was not required |
| C (Compose/Flutter/native toolkit) | **NOT MEASURED** | — | — | — | native blur feasibility |
| D (product compositor) | **NOT BUILT — forbidden until Gate P** | desktop Vulkan + AVD GLES probe only | host-authored static glass | PRE-GATE D1a: 1 device, 0 readback, 0 xdev, golden API timeline; runner **BLOCKED** | AGI/RenderDoc capture, physical Vulkan, D1b, D1=GO |

## Unsigned technical recommendation

Recommend **`GateP:P0`** until a high-refresh physical BaselineReport exists.

Reasons (not a signature):

1. RFC D1 must pick the cheapest track that satisfies Gate P. M-1 did not
   demonstrate a WebView-class bottleneck attributable to live glass.
2. The minimum M-1 device set (one low/mid phone + one high-refresh
   reference) is **BLOCKED**: `adb devices` on 2026-08-17 evening listed only
   `emulator-5554`. RFC §44: emulator does not replace real-device GPU.
3. `GateP:P2` is forbidden on this evidence (no low-tier matrix, no thermal
   budget).
4. `GateP:P1` would require the owner to define qualified devices and
   degraded semantics **without** the high-refresh measurement the gate is
   supposed to use. That is a product call, not a measurement result.
5. PRE-GATE D1a does not change this: runner `BLOCKED`, normative M0
   `NOT_ENTERED`, `D1b=NOT_STARTED`.

Revisit: attach the RFC device set, repeat A/A0/B (and Perfetto
input-to-present if available), then rewrite this draft. Kill Track D if
that phone run still shows no live-glass gap that Gate P cares about.

## Explicit non-actions

- Product owner has **not** signed `GateP:P0|P1|P2`.
- Normative Milestone 0 stays `NOT_ENTERED`.
- `M0-D1b` stays `NOT_STARTED`.
- `D1=Track D GO` stays `NOT_GRANTED`.
- Production React/WebView, Theme SDK, and Plugin SDK are unchanged.
