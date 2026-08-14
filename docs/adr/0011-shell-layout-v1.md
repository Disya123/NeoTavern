# ADR-0011: Shell layout v1 — tokenized geometry, slots as skin-targets

- **Status:** Accepted
- **Date:** 2026-07-31
- **Related ADRs:** [0006](0006-declarative-theme-shell.md) (declarative theme shell), [0005](0005-remote-session-auth.md)

## Context

The spec describes an App Shell with named areas, including
`navigation.secondary`, `character.browser` and `panel.right`, and promises
that the Shell theme "rearranges" areas: themes in the spirit of Wii U, macOS,
console, visual novel or mobile client.

The audit showed a gap between the promise and the implementation:

- In fact 10 of the 11 spec slots exist in code; `navigation.secondary` and
  `panel.right` are not implemented, `chat.viewport` is duplicated (outer
  `<main>` and inner canvas), the docs table promises slots that do not
  exist.
- The documentation (docs/theme-sdk, ADR-0006) claims that the shell
  "changes the placement of named areas via CSS Grid/Flex/Container Queries" —
  there is no implemented area-movement mechanism: components declare their
  geometry in module.css, and a theme can currently only recolor the skin and
  override tokens.
- An error in a single "rearranging" theme rule visually breaks the whole
  chat; the claimed complex shells need stable React slots with a consistent
  data contract, which are not yet defined.

Goals: an honest v1 contract (no area-rearrangement promises), a stable
skin-target for themes, measurable backward compatibility, preservation of
pixel stability of e2e snapshots.

## Decision

Adopt **Option A — honest v1**:

1. **Slots are skin-targets, not layout tools.** `data-slot` hooks are fixed
   as a stable contract for styling and content insertion. The
   area-movement/rearrangement mechanism is absent in v1 and is explicitly
   not promised.

2. **A single slot registry (10 of 11):**

   | Slot                   | Where declared                          | Status      |
   | ---------------------- | --------------------------------------- | ----------- |
   | `app.shell`            | AppShell root                           | implemented |
   | `navigation.primary`   | Sidebar navigation rail                 | implemented |
   | `character.browser`    | CharactersPage root                     | implemented |
   | `chat.header`          | ChatHeader                              | implemented |
   | `chat.viewport`        | outer `<main>` in AppShell              | implemented |
   | `chat.composer`        | ChatComposer                            | implemented |
   | `panel.left`           | Sidebar context panel                   | implemented |
   | `status.area`          | connection status                       | implemented |
   | `modal.layer`          | plugin-runtime + system-surface (stack) | implemented |
   | `notification.layer`   | PluginRuntimeUi                         | implemented |
   | `navigation.secondary` | —                                       | not in v1   |
   | `panel.right`          | —                                       | not in v1   |

   Multiple registrations of one slot are allowed only for `modal.layer`
   (stack: plugins → system surface). The inner scrollable chat canvas is
   declared as `data-part="canvas"`, not as a slot.

3. **Content geometry is a documented exception.** Grid layouts of content
   pages (e.g. `grid-template-columns` of character cards, chat list,
   `width: min(100%, 920px)` etc.) remain with the components: they describe
   content, not the shell. Tokenized and checked: control sizes, spacing,
   radii, weights, layers, breakpoints.

4. **Breakpoint registry.** All viewport- (`480…1080px`) and container-
   breakpoints (`20…44rem`) are fixed in `packages/theme-sdk/src/breakpoints.ts`
   and checked by a style-contract test; `px` in container queries is
   forbidden (migration `560px` → `35rem`).

5. **Style-contract regressions.** `packages/theme-sdk/test/style-contract.test.ts`
   forbids literal font-weight/font-size(px)/z-index/border-radius(px),
   control sizes and `!important` (except the a11y layer) in all built-in
   CSS.

6. **Component-level placement.** The position of parts inside a component
   (for example, the `order` of the tab list in `data-component="tabs"` —
   mobile tab bar at the bottom of the panel, and for
   `data-role="floating-tab-panel"` — a `shellLayout.managementTabs.pinned`
   selection picks a non-scrollable menu-header row with shell-inset or
   cloud placement above the ScrollArea with a separate scrollable spacer
   instead of a padding wrapper) is a documented hook of the component
   contract (theme-sdk README), not shell-area movement.
   It does not open up slot rearrangement (`navigation.primary`, `panel.left`
   etc.) and does not undo the v1 limitation.

7. **Bounded declarative composition of the navigation rail.**
   `theme.json#shellLayout.navigationRail` controls only the DOM order of
   known buttons inside the already existing slot `navigation.primary`:
   `main` remains the top flow, `bottom` is pinned at block-end.
   An optional `menu-toggle` moves `data-component="navigation-rail"` to
   `data-state="collapsed"`: the root and the single toggle are kept, the
   remaining rail items are excluded from the React tree and do not
   participate in layout/paint. An open `panel.left` closes and unmounts
   together with its heavy content; no hidden panel remains under the toggle.
   The toggle stays in its position and opens the rail back. This is
   component-level composition, not shell-slot rearrangement.
   The built-in layout puts the toggle first in `main`; on a mobile viewport
   its top cell is aligned with `chat.header` before the character identity
   without creating a second DOM instance. The theme keeps the right to move
   any item via the same `main`/`bottom`; there is no separate mobile
   override. The rail is a full-size shell block
   above the header layer: expanding it takes the rail width and shifts the
   `main-area`, while the toggle stays in the top cell of the column. Mobile
   backdrop blur is disabled.
   Unspecified system destinations return to `main` so that a theme cannot
   block Settings/safe mode. The configuration is inherited along the theme
   chain, replacing each explicitly set array.

## Consequences

Positive:

- themes get stable skin-targets and a verifiable token contract;
- the docs/theme-sdk update removes non-existent promises
  (area rearrangement, `navigation.secondary`);
- ADR-0006 is amended with a reference to this ADR;
- e2e snapshots remain the criterion of pixel stability.

Negative:

- the "console/mobile" shells claimed in the spec, with real area
  rearrangement, require a future React-slot contract (v2+);
- adding new slots is a breaking change for themes relying on the absence of
  a slot (due to a potential selector conflict).

Backward compatibility: slots are added, existing attributes
(`data-component`, `data-part`) are preserved; `data-slot="chat.viewport"` on
the outer `<main>` is kept (used by release.spec.ts).

No DB migrations required. Only CSS/data-attribute changes and
documentation.
