# presentation-design-system

Packed React golden assets for the Android Dioxus/Blitz presentation path.

Source of truth is the React UI (`packages/ui`, `apps/web` CSS modules,
`@fontsource-variable/*`, `@phosphor-icons/react` regular weight). This crate
does not invent tokens, icon shapes, or typefaces.

Rebuild generated files after a design-system change in React:

```text
python crates/presentation-design-system/scripts/pack_design_system.py
```

The packer copies exact Outfit / JetBrains Mono variable TTF files, Phosphor
regular SVG paths (`viewBox 0 0 256 256`), and the dark-theme `--st-*` token
sheet plus App Shell / Sidebar / Character Manager CSS modules (class names
prefixed to avoid collisions). `--st-*` `var()` usages, leftover
`color-mix()`, and component custom properties (`--tabs-segment-*`) are
flattened to literal dark values because Blitz does not apply UA custom
properties. Translucent `color-mix(..., transparent)` is composited onto
`--st-color-surface-canvas` (`#151311`) so surfaces stay opaque (React glass
over canvas). Light `:root { color-scheme: light }` is stripped. The compact
`@media (max-width: 600px)` overlay breakpoint is unwrapped; desktop
`min-width: 601px` rules are dropped. Conflicting `--shell-rail-current-width`
(`60px` vs collapsed `0`) is kept at `60px` so the panel sits beside the
rail. `position: fixed` / `sticky` become `relative` because Blitz has no
viewport containing block. Logical properties
(`padding-block-start`, `min-block-size`) are rewritten to physical
`padding-top` / `min-height`. `--nt-inset-*` is
left as `var(--nt-safe-area-*)` and baked to CSS pixels at produce time from
Android WindowInsets.

Component geometry that Blitz cannot express (`::after` dividers,
`-webkit-line-clamp`, sibling rail separators, `text-overflow: ellipsis`
glyphs) is added as real nodes / flattened rules / RSX ellipsis in
`BLITZ_NEUTRALIZE`. Avatars are GPU
overlays, not display-sized `data:` images in the DOM. Token values stay the
React dark sheet; do not retune `#151311` / `#24211e` from screenshots.

Visual screenshot diffs are a later verification gate. Implementation is from
this packed source, not from device photographs.
