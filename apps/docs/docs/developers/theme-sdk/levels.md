---
title: Theme Levels
description: The three levels of theming — tokens, component skin, and shell layout.
sidebar_position: 2
---

A theme is built from three independent levels. Understanding the split is
what lets a theme change the look of the whole application without touching
its behavior.

## Level 1: Design Tokens

Tokens are semantic CSS custom properties prefixed with `--st-`. They cover
colors, typography, spacing, radii, borders, shadows, z-index layers, motion,
control sizes, scrollbars, and the chat canvas.

Components reference tokens only — they never hardcode a color, font, or
spacing value. Overriding a token in the theme manifest restyles every
component that uses it:

```json
{
  "tokens": {
    "dark": {
      "color-accent": "#ff00aa",
      "font-ui": "'Atkinson Hyperlegible', system-ui, sans-serif"
    }
  }
}
```

Tokens resolve through an inheritance chain: built-in defaults for the mode,
then parent themes, then the theme itself. A dark mode falls back to the
theme's light tokens when no dark override exists. See
[Design Tokens](design-tokens.md) for the complete contract.

## Level 2: Component Skin

The component skin is CSS that restyles the built-in components through
stable hooks. The host publishes `data-component`, `data-part`,
`data-role`, and `data-state` attributes; a theme styles these attributes,
never generated CSS-module class names:

```css
@layer theme {
  [data-component='button'][data-variant='primary'] {
    background: var(--st-color-accent);
  }
}
```

The skin is applied through cascade layers in a fixed order, with the user
override layer last. `!important` is forbidden in theme CSS except in the
accessibility preferences layer. See
[Component Skin](component-skin.md) for the layer order and hook reference.

## Level 3: Shell Layout

The shell layout is the composition of the main areas: the navigation rail,
the management panels, and the chat workspace. It is declarative, expressed
in `theme.json` — never in JavaScript:

```json
{
  "shellLayout": {
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

Valid rail items are `chats`, `characters`, `personas`, `lorebooks`,
`backgrounds`, `ai-settings`, `plugins`, `settings`, and the optional
`menu-toggle`. The `main` group flows from the top; `bottom` is pinned to the
lower edge. Items you omit are added back in the standard order, so a theme
cannot accidentally hide Settings and lock the user out of recovery.

## Imitating Other Interfaces

Because the levels are disjoint, a theme can imitate a completely different
interface paradigm:

- A console-style theme changes tokens and skins, making the rail, panels,
  and buttons look like a game UI.
- A visual-novel theme restyles the chat viewport, messages, and the
  character header while the chat logic stays intact.
- A mobile-app theme uses the declarative shell layout to reorder the rail
  and panels.

None of these require touching chat logic, data, or plugin behavior — which
is exactly why the theme surface can be replaced wholesale. The one thing
v1 does not provide is free-form rearrangement of shell areas; slots are
styled and filled, not moved. See [Shell Contract](shell-contract.md) for
what is in scope.
