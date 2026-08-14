# ADR-0043: Web Client — Remote-Only Mode and Standalone Browser Runtime Decision

- **Status:** accepted (decision in force; referenced by ADR-0038 and
  `AGENTS.md` since the M0 baseline — this ADR records the decision that the
  references point to)
- **Date:** 2026-08-14
- **Related:** [ADR-0038](0038-canonical-rust-kernel-core.md),
  [ADR-0030](0030-remote-http-adapter.md),
  [ADR-0035](0035-desktop-remote-access.md),
  [ТЗ 10/10 rev2 §11.3](../../NeoTavern_architecture_10_of_10_spec_2026-08-13.md)

## Context

The repository ships an installable web artifact. The target architecture
(ТЗ 10/10 rev2 §11.3) requires an unambiguous statement of what that artifact
is and is not:

- **is** a Remote/Installable **Web Client**: the browser runs the UI shell and
  talks to the Kernel on a user-controlled Headless/Desktop host through an
  authenticated Product Wire HTTP/stream transport;
- **is not** a standalone offline runtime: it does not host the Kernel in the
  browser, does not own a canonical database, and must not allow product
  mutations when disconnected.

Two facts created the need for this ADR as an explicit record: (1) ADR-0038
and `AGENTS.md` already reference "ADR-0043" for this decision, and (2) the
capability matrix enforces ARC-12 ("Web Client не заявляет offline product
capability без browser runtime") against `release-manifest.json`. The decision
was in force but had no ADR file of its own, leaving the reference dangling.

## Decision

1. **Remote-only product scope.** The installable web artifact is a
   Remote/Installable Web Client. Kernel, canonical database, providers and
   secrets run on the user's Headless/Desktop host. The browser receives the
   UI shell and connects via the typed Product Wire client
   ([ADR-0029](0029-wire-contract-toolchain.md),
   [ADR-0030](0030-remote-http-adapter.md)); remote exposure is opt-in with
   authentication and origin policy (ADR-0035, ADR-0005).
2. **Honest offline state.** The service worker caches only the versioned app
   shell and public static assets. API responses, SSE/stream events, prompts,
   provider events and secrets never enter Cache Storage. Without a
   connection the Web Client shows a connection/offline screen and does not
   allow product mutations.
3. **Standalone Browser Runtime is a separate product track.** The scenario
   "the browser hosts the Kernel entirely on its own, with no backend to
   connect to" is **not supported** by this architecture (ТЗ §11.3.2): it
   cannot be reached with a service worker or a WASM-compiled transport
   layer. If it ever becomes a requirement, a new ADR/RFC must be accepted
   first, covering a browser-compatible application core, async Storage
   port, SQLite WASM + OPFS adapter with single-writer protocol,
   quota/eviction and emergency export, crash recovery/migration/backup in
   OPFS, browser secret encryption, provider CORS/network model and mobile
   Safari lifecycle, plus conformance/fault-injection/offline E2E suites.
   Until those criteria pass, standalone browser capability is reported
   `Not supported`, never `Designed`/`Experimental`/`Offline-ready`
   (ARC-12).
4. **Naming.** Documentation, store metadata and UI copy use `Web Client` or
   `Installable Web Client`; the shipped artifact is never branded with the
   legacy progressive-web-app naming that implies standalone capability.
5. **Data locality semantics.** "Local-first" in this mode means data lives on
   the user-controlled backend, not autonomous operation of every browser.

## Alternatives considered

- **Fully offline web app with a browser-hosted Kernel.** Rejected: requires a
  Rust/WASM or equivalent second core, async SQLite in OPFS with Web Locks,
  browser secret storage and provider CORS/proxy handling — a separate
  product track with its own ADR (ТЗ §11.3.2, §24). Claiming it now would
  re-introduce two owners of product logic and data.
- **No web artifact at all.** Rejected: the remote Web Client is a supported
  host per ADR-0038 support tiers and provides the headless/remote UX the
  architecture requires; the decision is about being honest about its
  capabilities, not removing it.
- **Keep the references without a dedicated ADR.** Rejected: an enforced
  architectural decision must have a durable, reviewable record; the dangling
  reference was a documentation gap.

## Consequences

- ARC-12 stays enforced by `release-manifest.json` + the generated capability
  matrix + `docs:check`; `webClient` capabilities never exceed
  `Integrated`/`Implemented` until the separate browser-runtime ADR is
  accepted.
- The Web Client offline screen and cache policy are implemented and tested
  in the Web Client milestone (M5, host parity); this ADR is their
  authority.
- Any future standalone-browser proposal starts from this ADR and must pass
  the ТЗ §11.3.2 criteria before implementation; until then the capability
  status remains `Not supported`.
