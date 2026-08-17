# ADR-0049: Track D compositor and Dioxus/Blitz producer (D1/D2 GO)

Date: 2026-08-18. Status: **Accepted** for D1/D2; **D3 Deferred**.
Related: [RFC 4.5](../rfc/neoui-v4-android-presentation-backend.md),
[TrackComparison](../rfc/m0-track-comparison.md),
[signed D1/D2 record](../rfc/d1-d2-decision.md),
[ADR-0038](0038-canonical-rust-kernel-core.md),
[ADR-0034](0034-android-local-host-jni-transport.md).

## Context

Gate P is `GateP:P1`. Technical M0 is PASS (host-side D1a/D1b/D2 on Xiaomi
Adreno 710 / Vulkan). TrackComparison is published and records that Track D
is technically proven on a physical production GPU, but **not** proven as
the cheapest track versus A/B/C on a matched physical fixture. Physical M-1
is BLOCKED; Track C is NOT MEASURED.

The owner still needs an independent D1 (who owns Android composition) and
D2 (which UI producer writes first-party Android UI). D3 (one presentation
UI vs Android/Web split) is a separate staffing/parity decision.

## Decision

- **D1 = Track D GO.** Android frame/composition ownership for live glass on
  capability-qualified devices is the product compositor path (NeoCompositor),
  not WebView as the long-term owner of that capability.
- **D2 = Dioxus + pinned Blitz GO.** First-party Android UI for that path is
  written through Dioxus and the pinned Blitz layout/paint seam proven in
  M0-D2. This is not an immediate rewrite of every Android screen.
- **D3 = DEFERRED.** Android receives the new Rust presentation path. Web
  remains the existing React client. Platform unification is not required now.
- **Scope.** Feature-flagged staged implementation. Not a blanket production
  migration. Public Android continues to ship React/WebView until Milestone
  B/C Definition of Done pass.
- **Rollback.** The acting React/WebView path. Durable Kernel state is not
  migrated away from Product Wire.
- **Kill trigger.** Production DoD miss; a required foundational private
  fork; an unsupported device matrix; or exceeding the approved budget.

## Alternatives

1. **Stay on Track A/B (WebView).** Cheapest delivery, but Gate P live glass
   on qualified devices stays unowned by a product compositor. Rejected by
   owner priority, with the honesty that A/B were not physically compared.
2. **Measure Track C (Compose/Flutter) before D1.** RFC-allowed. Not chosen;
   C remains NOT MEASURED and cannot win D1 on estimated rows.
3. **D3 = single UI now.** Would force a Web Dioxus rewrite. Deferred.

## Consequences

- Milestone A is **STARTED**, not PASS. The Product Wire / presentation
  boundary is **PASS**
  ([presentation-boundary.md](../architecture/presentation-boundary.md)).
  Presentation consumes Product Wire; it does not become a second product
  authority. A PASS still requires a feature-flagged Dioxus product shell,
  React ↔ Dioxus view-model parity, and presentation-path
  generation/backpressure tests.
- Theme SDK, Plugin SDK, and i18n stay on React/Web until later ABI decisions.
- A later superseding ADR is still required before declaring Android
  production cutover (no WebView main renderer).
