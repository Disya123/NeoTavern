---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/rfc/d1-d2-decision.md
---

# D1/D2 decision record (signed)

**Status:** **signed** 2026-08-18. This is the product-owner decision that
TrackComparison opened. It is **not** a production migration, **not**
Milestone B/C PASS, and **not** `D3=single UI`.

**RFC:** [neoui-v4-android-presentation-backend.md](neoui-v4-android-presentation-backend.md) §0.2 / §0.4  
**Evidence:** [m0-track-comparison.md](m0-track-comparison.md)  
**ADR:** [ADR-0049](../adr/0049-track-d-dioxus-presentation.md)

Historical M0-D1a / M0-D1b / M0-D2 admission JSON is not rewritten.

## Record (signed)

```text
owner: Disya123 <gamedisya@gmail.com>
date: 2026-08-18
evidence: docs/rfc/m0-track-comparison.md
decision: D1=Track D GO; D2=Dioxus+Blitz GO
D3: DEFERRED
waiver: Track D технически доказан, но не доказан как самый дешёвый относительно A/B/C
rationale: owner приоритизирует live glass, Rust-owned composition path и дальнейшую реализацию
scope: feature-flagged staged implementation; не blanket production migration
rollback: действующий React/WebView path
kill trigger: нарушение production DoD, foundational fork, неподдерживаемая device matrix или превышение бюджета
```

`D3=DEFERRED` means Android gets a new Rust presentation path and Web stays
React. Platform unification is not imposed now.

## What this grants

| Object                                    | Status                                                         |
| ----------------------------------------- | -------------------------------------------------------------- |
| `D1=Track D GO`                           | **GRANTED**                                                    |
| `D2=Dioxus + pinned Blitz GO`             | **GRANTED**                                                    |
| `D3`                                      | **DEFERRED** (dual presentation: Android Rust path, Web React) |
| Technical M0                              | still **PASS** (not re-run)                                    |
| Production WebView / React                | **rollback default**; unchanged as the public Android renderer |
| Production migration / no-WebView cutover | **not declared** until Milestone B/C Definition of Done        |
| Theme SDK / Plugin SDK                    | unchanged until later ABI decisions                            |

## What this does not grant

- Milestone B or C PASS
- replacing production `MainActivity` WebView
- `D2=Dioxus` as a rewrite of all Android UI in one step
- a claim that Track D is the cheapest Gate-P-satisfying track on a matched
  physical A/B/C fixture (TrackComparison says that comparison does not exist)
- upstream landing of `host_node_marker` or a typed Blitz Glass node

## Next technical chain

```text
Milestone A — Product Wire / presentation boundary (audit + close gaps)
→ Milestone B — NeoCompositor production implementation (feature-flagged)
→ Milestone C — Android product slice only after B/C DoD
→ rollback remains React/WebView
```

M0 probe crates stay probes. Production work does not relitigate M0.
