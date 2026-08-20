# ADR-0055: React UI oracle and portable Blueprint pilot

- Status: Accepted (pilot only)
- Date: 2026-08-20

## Context

The existing Android presentation experiment manually re-authors RSX, CSS
adaptations, and coordinate hit regions. Its design-system packer deliberately
flattens or rewrites CSS features that the current backend cannot represent.
That makes visual equivalence depend on repeated human inspection and cannot
scale from one shell to the full first-party UI.

React remains the current production frontend. For the migration it is a
useful observable oracle, but its DOM, hooks, CSS Modules classes, Radix
portals, and browser layout must not become the native UI ABI.

The current Product Wire covers the Character Manager Cards catalog/basic
CRUD/import/export boundary, but it does not yet cover all React editor,
gallery, creator-notes, or extension fields. A native UI must not invent those
missing values or silently substitute React defaults.

## Decision

Introduce a bounded, renderer-neutral pilot for the Character Manager **Cards
surface**:

```text
React fixture
  -> Chromium CaptureBundle (tooling only)
  -> strict normalizer/importer
  -> responsive UiBlueprint
  -> Rust Product Wire state + viewport
  -> UiScene
  -> platform renderer adapter
```

`CaptureBundle` contains browser-only DOM/semantic/layout/authoring evidence.
It is never passed to a production renderer. The importer emits a
`UiBlueprint` with component recipes, bindings, typed actions, and responsive
constraints; it excludes DOM paths, CSS Module names, browser bounds, and
computed pixel values.

The public native boundary is the new pure Rust
`neotavern-presentation-blueprint` crate. It has no dependency on Dioxus,
Blitz, Vello, wgpu, NeoCompositor, or a platform surface. Its scene publishes
parallel paint, hit-test, text-interaction, and semantic trees. A renderer is
an adapter over that same scene, not part of the SDK ABI.

The Chromium importer has an explicit component/CSS/value/at-rule support
matrix. An unknown item is a machine-readable import error; it is never
flattened, rewritten, or silently ignored. The current lossy Android CSS
packer remains a separate experiment and is not the importer.

The oracle gate compares four independently addressable artifacts:

1. semantic tree;
2. layout/bounds tree;
3. typed action trace and resulting state;
4. raster evidence.

V1 raster evidence is exact PNG hashing. Any future tolerance or mask policy
must be a versioned, reviewed evidence contract rather than an ad-hoc visual
decision.

The initial scope is Cards plus Product-Wire-backed basic intents. React
Editor, Advanced, Gallery, legacy plugin slots, creator-notes iframe, and
sanitized HTML are explicitly outside the native pilot until their data and
behavior contracts exist. Legacy plugin UI remains a contained WebSurface as
defined by ADR-0054.

## Consequences

- React does not enter a released native Android/UI runtime for a migrated
  surface; it remains an optional build/test oracle during migration.
- This ADR does not change the current desktop/web production frontend or
  claim renderer parity. No cutover happens until the four-dimension gate has
  an actual native candidate artifact.
- New first-party Rust presentation code must use the portable Blueprint/Scene
  ABI rather than Dioxus/Blitz/GPU types as its public interface.
- Product Wire extensions are required before the Rust UI can represent React
  fields that the Wire does not expose. No hidden cross-language state model is
  permitted.
- The pilot adds deterministic capture fixtures and test evidence, allowing a
  normal desktop development loop instead of repeated APK compilation for
  visual iteration.

## Alternatives considered

### Hand-port React JSX/CSS to RSX

Rejected. It repeats manual geometry and visual comparison for every small
change, and cannot make a browser DOM contract portable.

### Feed computed Chromium CSS directly to a renderer

Rejected. Computed styles already contain viewport-specific pixels, browser
defaults, and Chromium behavior, yielding a frozen DOM snapshot instead of an
adaptive SDK.

### Keep React in a WebView

Rejected for this pilot because it does not meet the requested Rust-native
first-party runtime/performance direction. It remains the contained legacy
plugin compatibility mechanism where required.

### Bind the public ABI to Dioxus or a compositor

Rejected. Those are replaceable renderer implementations and cannot serve as
the cross-platform SDK contract.
