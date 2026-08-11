# ADR-0012: Multi-surface sandbox composition

## Context

A sandboxed frontend plugin can register more than one UI surface at once. A
separate iframe per registration makes lifecycle handling costly and causes
independent stacking contexts to intercept application input.

## Decision

Use one full-viewport iframe for each plugin. The host owns a registration map
and batches mount rectangle updates. It sends the rectangles to independent
sandbox roots and maintains an SVG `clipPath` containing their union. The
clip restricts rendering and hit testing to plugin surfaces. Dialog roots are
above ordinary roots of their own plugin; the application's system surface
remains higher.

Unmount removes one root and tracker. Reload, disable, crash, and shutdown
remove the complete per-plugin frame state. The iframe remains sandboxed with
no same-origin privilege.

## Alternatives

- One iframe per registration: simpler local layout, but many process-like
  documents and fragile stacking/input behavior.
- A plugin-controlled full-window iframe: gives untrusted UI control over
  application hit testing.

## Consequences

The host has a small geometry synchronization path, which is covered by
runtime tests. SDK consumers retain their existing registration API and must
not depend on the internal number of iframe documents.
