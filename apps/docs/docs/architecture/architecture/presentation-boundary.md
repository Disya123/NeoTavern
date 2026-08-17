---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/architecture/presentation-boundary.md
---

# Presentation boundary (Milestone A)

**Status:**

```text
Milestone A = STARTED
A/Product Wire boundary = PASS
```

This is **not** Milestone A PASS. The TypeScript/Product Wire boundary is
closed; RFC §49 still requires a feature-flagged Dioxus product shell,
React ↔ Dioxus canonical view-model parity, and presentation-path
generation/backpressure/streaming tests.

**Decisions:** [ADR-0049](../adr/0049-track-d-dioxus-presentation.md),
[d1-d2-decision.md](../rfc/d1-d2-decision.md).
**D3:** **DEFERRED** — Android may take a Rust presentation path; Web stays
React. Rollback is the acting React/WebView host.

This is not a production migration and not Milestone B/C PASS.

## Audit (RFC §49)

| Deliverable                              | Status                                                         | Where                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Product Wire                             | **present**                                                    | `packages/contracts/src/wire/` (97 operations, kernel dispatch 1:1)                                         |
| Canonical view models                    | **present** (product DTOs); **React ↔ Dioxus parity unproven** | Wire DTOs. Presentation does not own a second durable model                                                 |
| Typed commands                           | **PASS** (boundary)                                            | Presentation may issue only Product Wire `operationId`s (`packages/contracts/src/presentation/boundary.ts`) |
| React Web adapter                        | **present**                                                    | `apps/web` + `@neotavern/neobackend` over Product Wire                                                      |
| Dioxus presentation shell                | **missing** (blocks A PASS)                                    | M0-D2 is a paint-seam probe, not a Product Wire product shell                                               |
| Fixture recorder                         | **PASS** (boundary)                                            | `recordPresentationFixture` in the boundary module                                                          |
| Generation / backpressure tests          | **Kernel present**; **presentation-path missing**              | Kernel generation suite does not prove React/Dioxus streaming parity                                        |
| PresentationCompatibilityMatrix          | **baseline**                                                   | [presentation-compatibility-matrix.md](../rfc/presentation-compatibility-matrix.md)                         |
| Theme / Plugin / i18n / legacy inventory | **baseline**                                                   | same matrix; no silent supersede                                                                            |
| D3 plan                                  | **accepted as DEFERRED**                                       | Android Rust path + Web React; no unification mandate                                                       |

## Rules

1. The Rust Kernel remains the only durable product authority (ADR-0038).
2. Presentation (React, WebView, future Dioxus/NeoCompositor) **consumes**
   Product Wire. It MUST NOT open SQLite, write `database.sqlite`, or bypass
   Wire for product mutations.
3. A presentation command is invalid unless its `wireOperationId` exists in
   `buildProductWireRegistry()`.
4. Production Android `MainActivity` stays WebView until Milestone B/C DoD.

## Surfaces

```text
react-web                  — production Web / desktop UI
webview-android-rollback   — production Android default
dioxus-android-flagged     — experimental; not the launcher
```
