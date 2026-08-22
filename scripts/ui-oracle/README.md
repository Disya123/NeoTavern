# UI oracle tooling

This folder holds build/test-only migration tooling. It is not bundled into an
Android APK, desktop release, or Web client runtime.

- `capture.mjs` observes explicit React `data-ui-*` annotations in Chromium,
  including semantic data, bounds, selected computed styles, and authored CSS
  declarations. Authored `::before`/`::after` rules are captured via stylesheet
  inspection; resolved computed styles for those pseudo-elements
  (`getComputedStyle(el, '::before')`) are **not** captured yet. This is an
  explicit pending strict-import boundary: the importer must not silently drop
  pseudo data, so any future pseudo-element support must capture both authored
  and resolved layers or fail the import.
- `gate.mjs` compares source and candidate evidence in four separate
  dimensions: semantics, layout, action trace, and raster hash.

The strict normalizer and TypeBox schemas live in
`packages/contracts/src/presentation/blueprint.ts`. It rejects unknown CSS,
value grammar, conditions, or component recipes rather than flattening them.

The first target is the Character Manager Cards surface. See
`docs/adr/0055-react-ui-oracle-blueprint-pilot.md` for scope, fixture rules,
and the explicit Product Wire limitations. Repeating elements (e.g.
`character-card`) must use `data-ui-key="<stable-id>"` so the capture adapter
produces unique nodeIds like `character-card.<character-id>` and the same
resolved IDs in `parentNodeId` and `actionTrace`; otherwise the strict importer
rejects `PRESENTATION_CAPTURE_DUPLICATE_NODE`.
