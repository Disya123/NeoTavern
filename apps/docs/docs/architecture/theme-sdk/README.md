---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/theme-sdk/README.md
---

# Theme SDK

Three levels of a theme:

1. **Token theme** — colors, fonts, sizes, spacing, radii, shadows, z-index,
   animations (semantic `--st-*` tokens).
2. **Component skin** — the appearance of buttons, fields, menus, cards, messages.
3. **Shell theme** — navigation structure, panels, chat layout, desktop/console/
   mobile views.

## Tokens

The canonical set of names is `TOKEN_NAMES` in `@neotavern/theme-sdk` (colors, typography,
spacing, radii, shadows, layers, motion, control sizes, panel sizes,
scrollbars). Default values: `DEFAULT_LIGHT_TOKENS` /
`DEFAULT_DARK_TOKENS` (duplicated in the CSS `tokens.css`).

Components use only tokens; hardcoding colors/fonts/spacing is forbidden
(AGENTS.md §14). The integration test
`packages/theme-sdk/test/token-contract.test.ts` guarantees: every
`var(--st-*)` in the UI sources exists in `TOKEN_NAMES`, and `tokens.css`
declares exactly the canonical set with the same values — a single source of
truth with no drift.
Additional canonical tokens (an extension of the `TOKEN_NAMES` set,
verified by the same token-contract test):

- `--st-custom-*` — user theme variables (for example,
  `custom-glass-blur`) that theme packages declare as input for
  derived values;
- `--st-chat-markdown-column-width`, `--st-chat-message-block`,
  `--st-chat-message-inline` — chat surface geometry;
- `--st-layer-raised` — the layer of raised surfaces (drawer, popover),
  above `layer-overlay`.
- `--st-layer-plugin-overlay` — the layer of plugin overlay surfaces (iframe + host
  hit layer), above `layer-panel`, below chrome;
- `--st-layer-plugin-chrome` — the layer of host overlay chrome (indicator of an
  active `full` overlay + close button), above all plugin layers, below
  `layer-modal` (the permission/security UI host stays above the plugin).

Derived values are resolved in `tokens.css`: for example, the blur of glass
surfaces is derived from `--st-custom-glass-blur` rather than hardcoded in
components.

### App Shell sizes

| Token                   | Purpose                                 | Default value |
| ----------------------- | --------------------------------------- | ------------- |
| `shell-rail-width`      | Width of the persistent navigation rail | `60px`        |
| `shell-panel-width`     | Width of the open context panel         | `380px`       |
| `shell-panel-min-width` | Minimum width of the resizable panel    | `260px`       |
| `shell-panel-max-width` | Maximum width of the resizable panel    | `720px`       |

The desktop shell subtracts both widths from the main area while the context panel
is open. On narrow screens the panel becomes an overlay; the theme MUST NOT cover
the composer or shrink its available area.

The resize host clamps the persisted `shell-panel-width` to the
`shell-panel-min-width` / `shell-panel-max-width` tokens; the panel and the chat
workspace use the same final `min(clamp(), viewport)` expression. Therefore
the theme can change all three values without desynchronizing the visible boundary
and the chat offset. The resize handle supports the mouse, `Home`/`End`, and logical
`ArrowLeft`/`ArrowRight` in LTR/RTL.

### Panel sizes and scrollbars

| Token                      | Purpose                                                | Default value       |
| -------------------------- | ------------------------------------------------------ | ------------------- |
| `size-panel-max-height`    | Maximum height of panels                               | `70vh`              |
| `size-content-max-height`  | Maximum height of lists                                | `20rem`             |
| `scrollbar-width`          | Scrollbar width (Chromium; Firefox fixes it to `thin`) | `8px`               |
| `scrollbar-radius`         | Scrollbar radius                                       | `999px`             |
| `scrollbar-track-bg`       | Scrollbar track background                             | `transparent`       |
| `scrollbar-thumb-bg`       | Thumb background                                       | `color-mix(...)`    |
| `scrollbar-thumb-hover-bg` | Thumb background on hover                              | `color-mix(...)`    |
| `scrollbar-fade-duration`  | Duration of the overlay scrollbar fade in/out          | `320ms`             |
| `scrollbar-fade-easing`    | Overlay scrollbar animation easing                     | `cubic-bezier(...)` |
| `scrollbar-hide-delay`     | Delay before hiding after scrolling stops              | `1000ms`            |

### Radii, borders, and overlay limits

| Token                  | Purpose                                          | Default value |
| ---------------------- | ------------------------------------------------ | ------------- |
| `radius-inset`         | Inner radius (nested menu elements)              | `4px`         |
| `border-width`         | Width of standard borders                        | `1px`         |
| `overlay-width-limit`  | Width limit of overlays (dialog/popover)         | `92vw`        |
| `overlay-height-limit` | Height limit of dropdown lists                   | `60vh`        |
| `dialog-sheet-height`  | Height of the mobile dialog sheet (bottom sheet) | `88dvh`       |

### Chat message Markdown

ST1-compatible roleplay formatting uses dedicated tokens (themes may
override, like SmartTheme Quote / Em):

| Token                    | Purpose                                            | Default value               |
| ------------------------ | -------------------------------------------------- | --------------------------- |
| `color-message-quote`    | Dialogue `"..."` → `<q data-part="message-quote">` | `#a55f12` (dark: `#e8943a`) |
| `color-message-emphasis` | Italic `*...*` / `<em>`                            | `#6e6e6e` (dark: `#919191`) |
| `color-message-code`     | Text of `` `...` ``                                | mode-dependent              |
| `color-message-code-bg`  | Background of highlighted inline code              | mode-dependent              |

Stable `data-part` hooks inside a message: `message-quote`, `message-emphasis`,
`message-strong`, `message-code`, `message-link`, `message-image`.

### Chat background

The chat canvas background is a swappable theme contract, not a component asset:

| Token                     | Purpose                                    | Default value  |
| ------------------------- | ------------------------------------------ | -------------- |
| `chat-wallpaper-image`    | CSS image: `url(...)`, gradient, or `none` | `none`         |
| `chat-wallpaper-position` | Position of the background image           | `center`       |
| `chat-wallpaper-size`     | Image scaling                              | `cover`        |
| `chat-wallpaper-overlay`  | Adaptive layer for text readability        | mode-dependent |
| `chat-wallpaper-blur`     | Blur of the background layer               | `0px`          |

The home screen and the chat screen publish the stable hook
`data-part="chat-wallpaper"`. A theme may use any local background,
gradient, or disable the image entirely. Content, controls, and the contrast
overlay remain independent layers; the theme MUST preserve WCAG 2.2 AA.

If the user picked a chat background, the app sets the scoped custom
property `--st-chat-wallpaper-image: url("/api/v2/assets/backgrounds/…")` on
the workspace root, overriding the `chat-wallpaper-image` token for that
surface; the `position/size/overlay/blur` tokens still belong to the theme. The
theme cannot and must not read the background catalog itself — it is managed
through the Backgrounds panel (`backgrounds` rail item).

## Stable hooks

Themes target the documented attributes, not generated classes:

```html
<div
  data-component="chat-message"
  data-part="container"
  data-role="assistant"
  data-state="streaming"
></div>
```

The `data-component/data-part/data-role/data-state` contract is versioned.

### Chat composer

The workspace container publishes `data-component="chat-panel"`; the composer
root is `data-slot="chat.composer"`, the top bar is
`data-part="toolbar"`, the field area is `data-part="field"`, and the input
itself is `data-component="textarea"`. The expanded usage statistics publish
`data-component="context-usage-panel"` and four cells `data-part="metric"`.
The host shell is a header + `chat-viewport` (scroll) with `composer-sticky` inside
the scroller (`position: sticky; inset-block-end: var(--chat-composer-edge-inset)`).
Messages pass under the composer's full height without a `ResizeObserver`. Glass —
a single layer on `.composer` (`backdrop-filter`); `toolbar`/`field` ≤12% tint.
`margin-inline-end: var(--st-space-md)` on the wrapper keeps the scrollbar off the glass.
The composer root is `data-slot="chat.composer"`, the top bar is
`data-part="toolbar"`, the field area is `data-part="field"`, the input is
`data-component="textarea"`. The expanded usage statistics publish
`data-component="context-usage-panel"` and four cells `data-part="metric"`.

### Buttons, action groups, and tabs

A standard button publishes `data-component="button"`, and when it uses
`startIcon` / `endIcon` — the structural parts `data-part="icon"` and
`data-part="label"`. The icon position is available through
`data-position="start|end"`; the presence of icons through
`data-has-icon="start|end|both"`. The icon is decorative and excluded from the
accessible name; the text remains the only action name.

### Host-connect gate (Android / remote-flow)

The packaged Android UI and the Web Client remote-flow show
`data-component="host-connect"` **before** `app.shell`. It is a Theme SDK
surface, not a one-off HTML page: chrome is Card / Button / TextField /
Segmented from `@neotavern/ui`, and the gate layout is in
`packages/ui/src/styles/components.css` (`@layer components`). Themes restyle
it by overriding `--st-*` tokens or `[data-component='host-connect']` in the
`theme` layer.

Stable parts: `panel`, `header`, `mark`, `eyebrow`, `title`, `subtitle`,
`body`, `link-form`, `hint`, `preview`, `error`, `actions`. Modes are a
`data-component="segmented"` group (this device / link / QR). `ThemeSync`
mounts above the gate so an installed kernel theme paints the first frame;
without a reachable theme list the built-in default tokens apply.

On the Android host, CSS `env(safe-area-inset-*)` is 0 inside WebView, and
WebView ignores `View.setPadding` for HTML. Do not pad a native host around
the WebView (that leaves a dead strip). `MainActivity` publishes
`WindowInsets` as `--nt-safe-area-*`; chrome uses `--nt-inset-*` so titles
and buttons stay below the clock while wallpaper and scrollable content pass
under the transparent status bar. Keep `env()` in `--nt-inset-*` for iOS /
PWA; do not treat it as the Android inset source. On viewports ≤ 600 px the
built-in chrome also floors at `--st-space-2xl` so a late 0-inset cannot
cover the clock or the gesture pill.

Settings → General → Host (packaged WebView / mobile shell only) reopens
this gate so the user can switch local kernel vs pairing link. Cancel
leaves the saved session in place.

Related actions go into an `ActionBar`, not a local flex container:

```html
<div data-component="action-bar" data-align="split" data-collapse="stack">
  <div data-part="inner">
    <div data-part="group" data-role="primary">…</div>
    <div data-part="group" data-role="secondary">…</div>
  </div>
</div>
```

`data-collapse` sets the host strategy: `wrap` wraps items, `compact`
keeps the toolbar horizontal and visually collapses icon-button labels,
`stack` stretches and stacks form/footer actions across the width of their own
container, `scroll` keeps a single-line panel with local horizontal
scrolling. In `compact` the label is not removed from the DOM and remains the accessible
name; the button MUST have localized `aria-label` and `title`. `compact` compares
the natural width of the real groups with the available width of the ActionBar
itself and publishes the result in `data-compact="true|false"`; no viewport/container
breakpoint is used for this. Hysteresis from `--st-space-sm` prevents jitter at
the boundary. The theme can change skin and shell without manually syncing a
breakpoint. For `wrap`/`stack` SHOULD NOT hide labels or disable text wrapping —
long translations and font-size increases must keep working.

Tabs publish the root `data-component="tabs"`, parts `list`, `trigger`,
`content`, and the list gets `data-layout="content|equal"` and
`data-overflow="wrap|scroll"`. All system surfaces (Personas,
Characters, AI Settings panels and plugin panels / character tabs) use the
segment variant (`data-variant="segment"`): equal columns, a shared frame and
background; the active tab is highlighted with a sliding indicator
(`data-component="tabs-indicator"`). In a narrow container the segment wraps
two columns per row.
In a narrow panel `equal + scroll` switches to natural-width tabs with
scrolling, so labels do not overlap.

Full-height Personas and Characters panels additionally publish
`data-role="floating-tab-panel"`. On desktop the built-in shell by default
places the segment list into a separate sticky menu-header row with
`--management-tabs-edge-inset` on top and sides. The row sits outside the active
ScrollArea, so images and forms never pass under the control.
The stable state is available as
`data-management-tabs-pinned="true|false"` on `navigation-panel`.

The Theme SDK manages this mode declaratively:

```json
{
  "shellLayout": {
    "managementTabs": {
      "pinned": true
    }
  }
}
```

`pinned: false` returns the desktop variant to an absolute translucent
cloud layer over its own ScrollArea. In this mode
`data-part="floating-tab-content"` adds a scrollable spacer on the cloud side,
and the full-bleed viewer keeps the ScrollArea without wrapper padding. At
viewport ≤ 600 px the tab list remains a bottom floating cloud with the mobile
safe area regardless of the desktop setting. The base cloud uses no shadow; a theme
skin may change the background, blur, and border through the stable `data-role` /
`data-component` hooks. `--management-tabs-safe-offset` synchronizes the spacer with
the geometry of the unpinned cloud, and `--management-tabs-edge-inset` its inset
from the edge and the mobile safe area.

The root `data-component="tabs"` is a flex column: the visual position of the tab
list is controlled by `order` on `[data-component="tabs-list"]` without changing
the DOM order (List stays before Content for screen readers). By default
`order: 0` — the list on top. Inside `data-component="navigation-panel"` at
viewport ≤ 600px the built-in CSS sets `order: 2` — the tabs move to the bottom
(mobile tab bar; 600px is the same breakpoint at which the panel becomes an
overlay). For `floating-tab-panel` the host first applies
`shellLayout.managementTabs.pinned`, after which a theme skin may change only the
visual shell through `@layer theme`, for example:

```css
@layer theme {
  [data-role='floating-tab-panel'] [data-component='tabs-list'] {
    border-color: var(--st-color-border-strong);
    background: var(--st-color-surface-overlay);
    backdrop-filter: blur(var(--st-effect-glass-blur));
  }
}
```

Positioning component parts (placement) is a component-level hook,
not moving shell areas: slot rearrangement remains out of v1
(ADR-0011).

Example component skin without a CSS Modules dependency:

```css
@layer theme {
  [data-component='button'][data-variant='primary'] > [data-part='icon'] {
    color: var(--st-color-accent-text);
  }

  [data-component='action-bar'] [data-part='group'][data-role='secondary'] {
    color: var(--st-color-text-secondary);
  }
}
```

### Navigation rail: order and menu hiding

`theme.json` can declaratively change the button order inside
`navigation.primary` through `shellLayout.navigationRail`. The `main` group flows
in the usual order from the top, `bottom` is anchored to the bottom edge of the
rail. Allowed identifiers: `chats`, `characters`, `personas`, `lorebooks`,
`backgrounds`, `ai-settings`, `plugins`, `settings`, and the optional
`menu-toggle`.

```json
{
  "shellLayout": {
    "managementTabs": {
      "pinned": true
    },
    "navigationRail": {
      "main": [
        "menu-toggle",
        "chats",
        "characters",
        "personas",
        "lorebooks",
        "backgrounds",
        "ai-settings",
        "plugins"
      ],
      "bottom": ["settings"]
    }
  }
}
```

In the standard configuration the regular navigation group starts after
`menu-toggle`, with `chats` as its first item. The separator is computed
structurally from the array order: if the theme puts another icon after the toggle,
the boundary moves with it and does not stay tied to `chats` or
`characters`. When `menu-toggle` is the first item, the boundary of that group
on desktop and mobile matches the bottom edge of `chat.header` in coordinate and
color, but remains a separate compact segment inside the rail's inline padding.
The mobile header line starts after an identical `--st-space-xs` inset on both
sides — the same one the rail uses to constrain its own separator. Therefore
both segments stay compact inside their containers, with a transparent gap
between them, and the header line does not reach the opposite edge of the viewport.

`menu-toggle` can be placed first or between any items in `main`,
left at the bottom in `bottom`, or removed from both arrays. If the toggle is absent,
the rail always stays expanded. Unspecified system sections are automatically
added to `main` in the standard order, so a theme cannot accidentally
hide Settings and block UI recovery.

In the built-in layout `menu-toggle` is first in `main`. On desktop and mobile
its top cell is aligned with `chat.header` before
`data-part="character-identity"`; no copy is created. A theme can change this
order with the same `main`/`bottom` arrays: there is no separate hidden mobile
override.
The mobile rail remains a full-size shell block above the header layer: when
expanded it takes `--st-shell-rail-width` and smoothly shifts `main-area`.
The toggle occupies the top cell of that column, and the other items start below
it. The toggle's center coincides with the vertical center of `chat.header` and the
avatar; mobile `backdrop-filter` is disabled.

The component skin MUST account for `data-state="expanded|collapsed"`: the rail's
background and blur apply only in `expanded`. Otherwise the full-size surface of
the collapsed rail would cover the chat canvas or the composer even though only
the system toggle remains among its items.

When `menu-toggle` is pressed, the `expanded` state changes to `collapsed`:
`data-component="navigation-rail"` and the single `menu-toggle` remain
mounted, while the other rail items are removed from the active React tree and
take no part in DOM/layout/paint. The rail surface becomes transparent; the chat
canvas and `panel.left` receive the freed width. The state of
`data-component="navigation-panel"` itself moves from `data-state="open"` to
`data-state="closing"`: for the duration of the exit animation the subtree stays
in the DOM but gets `inert` and `aria-hidden="true"`. After `animationend` it is
fully unmounted, so there is no hidden interactive panel under the toggle. A quick
re-open before the animation finishes returns the state to `open` and cancels the
unmount. The toggle keeps its configured position and switches its action to
opening; no duplicate recovery control is created.
The choice is saved locally. Safe mode uses the built-in order and always
keeps the toggle available.

In the expanded rail the stable parts `data-part="main-items"`,
`data-part="bottom-items"`, `data-part="item"`, and
`data-part="item-control"` are available; a concrete item is published as
`data-item="<id>"`, an action as `data-action="menu-toggle"`. Navigation
publishes `data-leading-menu-toggle="true"` when the toggle is the first
item of `main`; the built-in skin uses this state for a shared row height
with `chat.header`. The toggle still honors `--nt-inset-top` so it sits
below the status bar on Android WebView (do not zero `padding-block-start`).
After the rail transitions to `collapsed`
the top-cell separator is not drawn: the remaining toggle does not overlay its own
border on the `chat.header` line.

### Context panel header

All navigation-rail panels (Settings, AI Settings, Personas, Characters, and
others) share one common header chrome. The theme styles it once —
the changes apply to all panels without exception:

```html
<header data-component="sidebar-panel-header" data-part="personas-header">
  <div data-part="identity">
    <span data-part="avatar">…</span>
    <div data-part="title-group">
      <h2 data-part="title">Persona Management</h2>
    </div>
  </div>
  <div data-part="actions">
    <button data-part="close">…</button>
  </div>
</header>
```

- `data-part="avatar"` is present only where the panel shows a
  selected object (persona, character). The avatar is not a contract: the theme
  may change its skin but is not required to rely on its presence.
- `data-part="actions"` holds the panel's optional actions (for example,
  saving in Character Management) and the `data-part="close"` button.
- `data-part="eyebrow"` remains an optional skin hook and appears only
  when the surface explicitly passed an eyebrow; the shared chrome no longer adds
  a `Workspace` row by default.
- The base header row has the height `--st-control-height-large` on desktop and
  mobile. The top safe area is added inside this same header, not as an external
  panel margin, so its bottom edge aligns with the other shell headers.
- The shared chrome creates a positioned stacking layer directly above
  `--st-layer-panel` (`calc(var(--st-layer-panel) + 1)`) and paints its own
  surface. Its bottom edge therefore stays above the panel's scrollable
  content and floating controls even at an equal base layer. The separator
  is drawn as a separate overlay `::after`, not as a box border, and keeps the
  original `--st-color-border`; adjacent content cannot overlap its paint layer.
- The close button publishes a localized `aria-label`
  (`accessibility:closeMenu`) and remains the last element in the header's DOM
  order.
- Legacy hooks `data-part="personas-header"` and
  `data-part="character-management-header"` on the header root are kept for
  backward compatibility with old themes; new themes use
  `data-component="sidebar-panel-header"`.

### App Shell slots

Slots are stable **skin-targets**: themes style them and inject content
through the plugin SDK. The mechanics of moving areas are not provided in v1
(see [ADR-0011](../adr/0011-shell-layout-v1.md)).

| Slot                    | Where declared                          | Status      |
| ----------------------- | --------------------------------------- | ----------- |
| `data-slot="app.shell"` | AppShell root                           | implemented |
| `navigation.primary`    | Sidebar navigation rail                 | implemented |
| `character.browser`     | CharactersPage root                     | implemented |
| `chat.header`           | ChatHeader                              | implemented |
| `chat.viewport`         | Outer `<main>` in AppShell              | implemented |
| `chat.composer`         | ChatComposer                            | implemented |
| `panel.left`            | Sidebar context panel                   | implemented |
| `status.area`           | Connection status                       | implemented |
| `modal.layer`           | Plugin runtime + system surface (stack) | implemented |
| `notification.layer`    | PluginRuntimeUi                         | implemented |
| `navigation.secondary`  | —                                       | not in v1   |
| `panel.right`           | —                                       | not in v1   |

Multiple registrations of one slot are allowed only for `modal.layer` (stack:
plugins → system surface). The inner scrollable chat canvas is declared
as `data-part="canvas"` and is not a slot.

### Breakpoint registry

All viewport and container breakpoints of the built-in CSS are pinned in
`@neotavern/theme-sdk` (`VIEWPORT_BREAKPOINTS` / `CONTAINER_BREAKPOINTS`) and
verified by the style-contract test:

| Type            | Values                          |
| --------------- | ------------------------------- |
| Viewport (px)   | `480, 600, 620, 760, 980, 1080` |
| Container (rem) | `20, 28, 32, 35, 36, 42, 44`    |

Rules: viewport media queries are written in px (max-width), container queries —
only in rem; `px` in container queries is forbidden. Feature queries
(`prefers-reduced-motion`, `pointer`, `forced-colors`, `prefers-color-scheme`,
`prefers-contrast`) do not belong to the registry.

### Capabilities and prohibitions (style contract)

v1 themes MAY: override semantic tokens (including control
geometry, radii, layers; breakpoints stay registry-based), change the component
skin through the `plugin-base`/`theme`/`user` layers, style slots and
`data-part` hooks, set the chat wallpaper.

Hardcoding is forbidden (verified by
`packages/theme-sdk/test/style-contract.test.ts` across the entire built-in CSS):
numeric `font-weight`, `font-size` in px, numeric `z-index`, raw
`border-radius` in px, control sizes `40/44/52px` and `32/36px`,
`!important` (except the a11y layer `preferences.css`). Content geometry
(card grid layouts, list widths, row heights) is a deliberate exception and
is not part of the token contract (ADR-0011).

System tools publish `data-component="system-surface"` and
`data-surface="<id>"`. A theme may change their skin, but must not turn the
catalog, settings, plugins, or themes into a standalone main screen.

## Manifest (theme.json)

```json
{
  "id": "author.theme",
  "name": "My Theme",
  "version": "1.0.0",
  "apiVersion": 1,
  "modes": ["light", "dark"],
  "tokens": { "dark": { "color-accent": "#ff00aa" } },
  "componentsCss": "components.css",
  "shell": "shell.css",
  "shellLayout": {
    "navigationRail": {
      "main": [
        "menu-toggle",
        "chats",
        "characters",
        "personas",
        "ai-settings",
        "plugins",
        "settings"
      ],
      "bottom": []
    }
  },
  "settings": {}
}
```

A theme can inherit (`extends`), have light/dark modes, settings,
icon/sound packs, and apply without a restart. `resolveTokens()` merges:
mode defaults → parent chain → theme (a dark mode falls back to the
theme's light tokens when dark is absent).

`componentsCss` (component skin level) and `shell` (shell layout level)
MUST reference a `.css` file inside the package. There is no
JavaScript/TypeScript entrypoint for themes: the shell styles the named areas
through the stable `data-component`/`data-part` hooks and the token contract.
`shellLayout` contains only declarative composition validated by the host;
`navigationRail` is currently the public contract. Rearranging areas
(moving panels, the rail, etc.) is not supported in v1 —
[ADR-0011](../adr/0011-shell-layout-v1.md).

## Package, installation, and lifecycle

A `.sttheme` package is a ZIP up to 25 MiB. `theme.json` sits at the ZIP root or
in a single root folder. The server limits the number of files and the unpacked
size, and rejects absolute/traversal paths, backslash paths, symlinks, and
encrypted entries. CSS is limited to 2 MiB per file; `@import`, executable CSS
constructs, and remote/protocol-relative URLs are forbidden.

Installing does not activate the new theme. Updating with the same `id`
atomically replaces the directory and preserves the current activation state. On a
registry error the server restores the previous directory. Activation validates
the entire `extends` chain — missing parents and cycles — then updates
`theme_registry.enabled` and `settings.themeId` in a single SQLite transaction.

The `componentsCss` and `shell` URLs get a cache-buster from the version and
installation time. Therefore reinstalling a package with the same `id` reloads the
CSS after the registry update, even if the asset path did not change.

The `/themes` URL opens the manager as a route-aware modal over the
unmounted chat. Closing, Back, and Escape return to the same chat and
draft. Reset restores the built-in theme, removes runtime CSS links and inline
`--st-*` overrides. Deleting the active theme also resets `settings.themeId`.

### Quick start without build tools

1. Open Themes from the navigation rail.
2. In the Author Theme Starter Kit block, download `theme-starter.zip`.
3. Unpack the archive and edit `theme.json`, `components.css`, and `shell.css`.
4. Re-create a ZIP with these files at the root and install it with the same
   manager. Installing does not activate the theme automatically.
5. Check light/dark, mobile, keyboard focus, RTL, and safe mode, then
   apply the theme.

The starter package uses only semantic tokens and stable
`data-slot`/`data-component` hooks. No Node.js, npm,
JavaScript, or a separate Theme SDK CLI is needed for a first theme.

### Bundled themes

The distribution ships with a ready-made theme set in
`apps/server/assets/themes/<id>/` (per the Theme SDK contract: `theme.json`,
`components.css`, `shell.css`, `preview.png`). On first launch the server
copies each package into `data/themes/<id>/` and registers it in
`theme_registry` (`seedBundledThemes`, see `apps/server/src/lib/bundledThemes.ts`),
so the theme manager opens not with an empty list but with a set like AMOLED,
GitHub Dark, Matrix, Nord, Gruvbox, Dracula, Tokyo Night, Catppuccin Mocha,
Solarized Dark, and One Dark.

The seeding semantics match the starter character:

- the `app_meta` marker `themes.bundled.v1` stores an array of already installed ids;
- only ids missing from the marker are seeded — new themes from an update
  appear on the next launch, and themes deleted by the user are **not**
  restored (their directory and registry record are removed by the manager's
  regular action);
- seeding never activates a theme — the choice stays with the user, and the
  built-in light/dark tokens remain the fallback for safe mode and reset;
- a corrupted bundled package leaves a retry marker and does not block the
  server launch; the package is validated by `validateThemeManifest` and
  `containsForbiddenCssConstruct` before copying.

Adding a new bundled theme: create a directory in
`apps/server/assets/themes/` with `theme.json`/`components.css`/`shell.css`,
run `pnpm theme:previews` to generate `preview.png`, update the catalog
in the `apps/server/test/bundledThemes.test.ts` test (the count threshold), and
if necessary — this list. Copying assets into `dist/assets/themes/`
is done by `pnpm --filter @neotavern/server assets`; the desktop build includes
them via `pkg.assets`.

## Application

`buildThemeVariables(theme, mode, parents)` returns `Record<'--st-…', value>`;
the web app sets them on `document.documentElement`. `data-theme-mode` on `<html>`
switches the light/dark set from `tokens.css`.

## Security (safe mode)

- preview before applying;
- `?safe=1` disables third-party themes (`getSafeModeFromSearch()`);
- loading a package does not activate the theme automatically;
- a reset button and a separate theme manager;
- the theme gets no access to chats, API keys, or the filesystem;
- `user.css` loads last.

`?safe=1` is handled before the theme registry request: package CSS and token
overrides are not added to the document. Leaving safe mode does not change the
saved active theme. Architectural decisions: [ADR-0006](../adr/0006-declarative-theme-shell.md),
[ADR-0011](../adr/0011-shell-layout-v1.md).

## Testing themes

The theme contract is protected at four levels:

- unit — `packages/theme-sdk/test/`: token contract (`TOKEN_NAMES` without the
  `--st-` prefix), style contract over the built-in CSS, the theme starter
  installs and applies its tokens;
- backend — `apps/server/test/api.test.ts`, `describe('themes')`: installing
  a non-ZIP (400), a missing/broken manifest, traversal paths, forbidden
  CSS (`url(//…)`, `url(https://…)`, `behavior:url(#default#VML)`,
  `url(javascript:…)`, `!important`) and non-CSS assets (422 `THEME_INVALID`);
  `extends` cycles, deleting the active theme, asset serving
  (`FILE_NOT_FOUND` 404, `FILE_TYPE_NOT_ALLOWED` 415), and per-theme settings
  (422 `VALIDATION`);
- e2e — `e2e/theme-contract.spec.ts`: localized installation errors in the UI,
  traversal archives (400), settings persisting into CSS variables after reload,
  deleting the active theme removes overrides; happy path and safe mode —
  `e2e/release.spec.ts`;
- visual — `e2e/visual.spec.ts`: snapshots of the base theme light/dark/high
  contrast, of an active installed theme (`home-installed-theme.png`), and of
  the responsive character panel actions (`character-actions-narrow.png`).

The default theme messages meet WCAG 2.2 AA (4.5:1)
on the chat surface by default; this is covered by the axe checks in `e2e/` and
pinned in `packages/ui/src/styles/tokens.css` + `@neotavern/theme-sdk` default
tokens.

### Message details and revision-history hooks

The message action surfaces expose stable theme selectors independent of CSS Modules:

- `[data-component='message-details-card']` with `data-state='details|actions|edit'`
  and `data-role='user|assistant|system|tool'`;
- parts `drag-handle`, `details-header`, `details-badges`, `details-meta`,
  `details-meta-row`, `details-actions`, `details-content`, `details-footer`,
  `details-footer-action`, `details-action-menu`, `details-danger-zone`,
  `details-core-actions`, `details-editor`, and `details-editor-error`;
- `[data-component='plugin-message-actions'][data-variant='inline|circle|list']`;
- `[data-component='message-version-controls']` with parts
  `message-version-controls` and `message-version-actions`;
- `[data-component='message-revision-history-card'][data-state='loading|ready']`
  with parts `revision-history-header`, `revision-history-list`,
  `revision-history-item`, `revision-history-content`, `revision-history-empty`,
  and `revision-history-error`. Revision items use `data-state='current|archived'`.

Shell themes may change layout and skin through these hooks and semantic tokens, but must
preserve DOM order, the horizontal scrolling behavior of `details-actions`, focus trapping,
logical RTL direction, safe-area insets, and 44 px interactive targets.
