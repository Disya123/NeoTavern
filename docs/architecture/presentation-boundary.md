# Presentation boundary (Milestone A)

**Status:**

```text
Milestone A = PASS
A/Product Wire boundary = PASS
Milestone B = STARTED
```

Milestone A **PASS** is the feature-flagged Product Wire shell, React ↔
Dioxus canonical projection parity, and presentation-path streaming tests.
It is **not** a production migration, **not** Milestone B/C PASS, and **not**
a `MainActivity` cutover.

**Decisions:** [ADR-0049](../adr/0049-track-d-dioxus-presentation.md),
[d1-d2-decision.md](../rfc/d1-d2-decision.md).
**D3:** **DEFERRED** — Android may take a Rust presentation path; Web stays
React. Rollback is the acting React/WebView host.

This is not a production migration and not Milestone B/C PASS.

## Audit (RFC §49)

| Deliverable                              | Status                                        | Where                                                                                                       |
| ---------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Product Wire                             | **present**                                   | `packages/contracts/src/wire/` (97 operations, kernel dispatch 1:1)                                         |
| Canonical view models                    | **present**; **React ↔ Dioxus parity tested** | Shared fixture `packages/contracts/src/presentation/fixtures/canonical-chat.json`                           |
| Typed commands                           | **PASS** (boundary)                           | Presentation may issue only Product Wire `operationId`s (`packages/contracts/src/presentation/boundary.ts`) |
| React Web adapter                        | **present**                                   | `apps/web` + `@neotavern/neobackend` over Product Wire                                                      |
| Dioxus presentation shell                | **present (flagged)**                         | `crates/presentation-dioxus-shell`. Not `MainActivity`. `NEOTA_DIOXUS_SHELL=1` is non-default               |
| Fixture recorder                         | **PASS** (boundary)                           | `recordPresentationFixture` in the boundary module                                                          |
| Generation / backpressure tests          | **present** (presentation-path)               | Stale generation drop + bounded stream cap; React ↔ Dioxus golden projection                                |
| PresentationCompatibilityMatrix          | **baseline**                                  | [presentation-compatibility-matrix.md](../rfc/presentation-compatibility-matrix.md)                         |
| Theme / Plugin / i18n / legacy inventory | **baseline**                                  | same matrix; no silent supersede                                                                            |
| D3 plan                                  | **accepted as DEFERRED**                      | Android Rust path + Web React; no unification mandate                                                       |

## Rules

1. The Rust Kernel remains the only durable product authority (ADR-0038).
2. Presentation (React, WebView, future Dioxus/NeoCompositor) **consumes**
   Product Wire. It MUST NOT open SQLite, write `database.sqlite`, or bypass
   Wire for product mutations.
3. A presentation command is invalid unless its `wireOperationId` exists in
   `buildProductWireRegistry()`.
4. Production Android `MainActivity` stays WebView until Milestone B/C DoD.
   `NEOTA_NEOCOMPOSITOR=1` is a **non-default** feature flag for
   `crates/neocompositor`, not a cutover switch.
   `NEOTA_DIOXUS_SHELL=1` is a **non-default** flag for the Dioxus Product
   Wire shell crate; it is not a launcher switch.
5. M0 probe crates stay probes and are not production JNI. Interchange
   types (`NeoDisplayList`, `compile_passes`) live in
   `neotavern-neocompositor`; probes re-export them.

## Surfaces

```text
react-web                  — production Web / desktop UI
webview-android-rollback   — production Android default
dioxus-android-flagged     — experimental; not the launcher
```

## Milestone B start

`crates/neocompositor` holds production interchange types, a bounded
`FrameTransaction` mailbox, spatial/scroll/clip/effect property trees,
CPU scroll/animation fast paths, async hit-test / nested-scroll dispatch,
interaction-ready text snapshots, a cross-tile selection underlay (PERF-19
**PASS** on physical Vulkan, not B PASS), a PERF-18 effect-scope
backdrop capture (**PASS** on physical Vulkan, not B PASS), and a CPU
device/surface recovery state machine (injection-tested, not production JNI,
not B PASS). Chat
virtualization lives
in `crates/chat-viewport` (height index, predictor, bounded tile cache,
geometry epochs / C0/C1 remap; compositor sees only the **active** tile
descriptors and geometry snapshot). PERF-20 is **PASS** on the physical
Vulkan multi-frame trace, not B PASS. The Blitz producer publishes `TextInteractionSnapshot`
from already-shaped Parley layouts (no compositor reshape). Viewport remap and
selection go through `crates/presentation-session` (one
`FrameTransaction`, logical selection, `DeltaToken`). Independent stamps:
[`docs/rfc/perf-18-20-adjudication.json`](../rfc/perf-18-20-adjudication.json).
Debug-only
`crates/presentation-perf-probe` / `PresentationPerfActivity` is the
physical capture vehicle (not production JNI). Neither crate is linked into
production JNI. Device/surface recovery is a CPU injection-tested state
machine in `crates/neocompositor` (`GpuRecovery`); GPU telemetry is not
started. Product cutover is not declared. Known host baseline failures are
recorded in
[known-baseline-failures.md](known-baseline-failures.md) and do not make
PERF-18/19/20 evidence inadmissible.
