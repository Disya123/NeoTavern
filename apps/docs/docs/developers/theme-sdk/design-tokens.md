---
title: Design Tokens
description: The semantic design-token contract and what components may not hardcode.
sidebar_position: 3
---

Design tokens are the semantic variables that carry all visual values in the
application. Components reference them; themes override them; nothing is
hardcoded.

## The Token Contract

Every token is a CSS custom property prefixed with `--st-`, and every token
name is part of the versioned contract in `@neotavern/theme-sdk`. The host ships
default values for light and dark modes, so every token always resolves even
when a theme defines none.

The canonical token groups are:

- **Text colors** — `color-text-primary`, `color-text-secondary`,
  `color-text-muted`, `color-text-inverse`, `color-text-link`.
- **Surfaces** — `color-surface-primary`, `color-surface-secondary`,
  `color-surface-tertiary`, `color-surface-overlay`, `color-surface-canvas`,
  `color-surface-elevated`.
- **Accent and status** — `color-accent`, `color-accent-hover`,
  `color-accent-text`, `color-accent-soft`, `color-accent-soft-text`,
  `color-border`, `color-border-strong`, `color-success`, `color-warning`,
  `color-danger`, `color-info`.
- **Chat message markdown** — `color-message-quote`,
  `color-message-emphasis`, `color-message-code`, `color-message-code-bg`.
- **Typography** — `font-ui`, `font-mono`, `font-size-2xs` through
  `font-size-2xl`, `line-height-body`, `font-weight-normal` through
  `font-weight-bold`.
- **Spacing** — `space-2xs` through `space-3xl`.
- **Radii and borders** — `radius-control`, `radius-card`,
  `radius-overlay`, `radius-panel`, `radius-round`, `radius-inset`,
  `border-width`.
- **Elevation** — `shadow-card`, `shadow-soft`, `shadow-focus`,
  `shadow-overlay`.
- **Layers (z-index)** — `layer-base`, `layer-raised`, `layer-panel`,
  `layer-plugin-overlay`, `layer-plugin-chrome`, `layer-dropdown`,
  `layer-modal`, `layer-notification`.
- **Motion** — `motion-duration-fast`, `motion-duration-normal`,
  `motion-duration-slow`, `motion-easing-standard`, `effect-glass-blur`.
- **Control sizes** — `control-height`, `control-height-large`,
  `control-height-sm`, `control-height-xs`, `control-height-2xs`,
  `control-hit-min`, `switch-width`, `switch-height`, `switch-thumb-size`,
  `menu-min-width`, `dialog-max-width`, `dialog-max-height`,
  `textarea-min-height`, `spinner-size`.
- **Panel and content sizes** — `size-panel-max-height`,
  `size-content-max-height`, `size-chat-column-max`.
- **Viewport limits** — `overlay-width-limit`, `overlay-height-limit`,
  `dialog-sheet-height`.
- **Scrollbars** — `scrollbar-width`, `scrollbar-radius`,
  `scrollbar-track-bg`, `scrollbar-thumb-bg`, `scrollbar-thumb-hover-bg`,
  `scrollbar-fade-duration`, `scrollbar-fade-easing`,
  `scrollbar-hide-delay`.
- **App shell sizes** — `shell-rail-width`, `shell-panel-width`,
  `shell-panel-min-width`, `shell-panel-max-width`.
- **Chat canvas** — `chat-wallpaper-image`, `chat-wallpaper-position`,
  `chat-wallpaper-size`, `chat-wallpaper-overlay`, `chat-wallpaper-blur`,
  `custom-wallpaper-overlay-alpha`.
- **Chat typography metrics** — `chat-markdown-column-width`,
  `chat-message-block`, `chat-message-inline`.
- **User-adjustable knobs** — `custom-glass-blur`, `custom-ui-opacity`.

## Overriding Tokens

A theme overrides any subset of the names. Values are validated: they must
be safe non-empty CSS values, and constructs such as `{`, `}`, and `;` are
rejected.

```json
{
  "tokens": {
    "dark": {
      "color-accent": "#e38a62",
      "shadow-card": "0 1px 2px rgba(0, 0, 0, 0.35)"
    }
  }
}
```

If the user picks a chat background, the application sets a scoped custom
property for the wallpaper image on the workspace root; position, size,
overlay, and blur remain the theme's tokens.

## Resolution Rules

Tokens resolve in this order, later winning:

1. Built-in defaults for the active mode.
2. The parent-theme chain, root first.
3. The theme itself.

A theme may omit any subset of the canonical names: every omitted token
resolves to the built-in default for the active mode (`DEFAULT_LIGHT_TOKENS`
/ `DEFAULT_DARK_TOKENS`), so an additive theme never leaves a token
undefined. Dark mode falls back to the theme's light tokens when no dark
override exists, so a light-only theme still works in dark mode. The
`resolveTokens` and `buildThemeVariables` functions in `@neotavern/theme-sdk`
implement this, and the host writes the result as CSS variables on
`document.documentElement`.

## What Components May Not Hardcode

The style contract forbids hardcoded values anywhere in the built-in UI, and
the same rules apply to what a theme must not rely on:

- Numeric `font-weight`, `font-size` in px, and raw `border-radius` in px.
- Numeric `z-index` values — use the `layer-*` tokens.
- Control sizes such as `40px`, `44px`, `52px`, `32px`, and `36px`.
- `!important` in theme CSS, except in the accessibility preferences layer.
- Layout rules: coordinates, grid and flex schemes, breakpoints, and area
  order are not part of the token contract. Breakpoints come from the
  registry (`VIEWPORT_BREAKPOINTS` and `CONTAINER_BREAKPOINTS`), and moving
  shell areas is out of scope for v1.

Content geometry such as the grid scheme of card lists is an explicit
exception: it is not covered by the token contract. Everything a theme needs
to restyle is available through tokens, hooks, and the declarative shell
layout. The generated [Theme SDK reference](../../api/theme-sdk/) documents the
exact `TokenName` list.
