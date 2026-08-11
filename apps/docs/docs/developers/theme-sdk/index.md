---
title: Theme SDK Overview
description: 'What the Theme SDK is: a full visual shell replacement, level by level.'
sidebar_position: 1
---

The Theme SDK is the versioned contract for replacing the entire visual shell
of NeoTavern — not just recoloring it.

## What the Theme SDK Is

A theme is a package (`.sttheme`) that controls how the application looks and
how its main areas are composed. Unlike a plugin, a theme has no JavaScript:
it is CSS, semantic tokens, and a declarative shell layout in a manifest.
Because the SDK is declarative, a theme cannot break the application's
behavior or reach its data.

The `@neotavern/theme-sdk` package provides the contract itself: the canonical
token names, manifest validation, inheritance resolution, and CSS-variable
generation. The reference implementation of the host applies a theme by
writing `--st-*` custom properties onto the document root and loading the
theme's stylesheets in a defined order.

## The Three Levels

Theming is structured in three levels, and a theme can use any of them:

1. **Design tokens** — semantic variables for colors, fonts, spacing, radii,
   shadows, z-index layers, motion, and control sizes. Components reference
   these tokens exclusively, so overriding a token restyles the whole
   interface consistently.
2. **Component skin** — CSS that restyles components through stable
   `data-component`, `data-part`, `data-role`, and `data-state` hooks.
3. **Shell layout** — declarative composition of the main areas: the
   navigation rail, management panels, and chat workspace.

Because the chat logic, data model, and behavior are untouched, a theme can
imitate an operating system, a game console, a visual-novel interface, or a
mobile app layout without breaking any feature. See
[Levels](levels.md) for the details.

## Authoring Without a Build Step

A theme is a ZIP with `theme.json`, `components.css`, and `shell.css`. You
can build one by hand:

1. Open the Themes manager and download the theme starter kit.
2. Unpack it and edit `theme.json`, `components.css`, and `shell.css`.
3. Re-zip the files at the archive root and install the package.
4. Check light and dark modes, mobile, keyboard focus, RTL, and safe mode,
   then apply the theme.

No Node.js, npm, JavaScript, or Theme SDK CLI is required for a first theme.

## Installation and Activation

Installing a package does not activate it. Activation validates the whole
`extends` chain for missing parents and cycles, then updates the enabled
theme and the saved theme selection in one transaction. Updating a package
with the same id atomically replaces its directory and keeps the current
activation state; on a registry error the previous directory is restored.

The distribution ships a set of built-in themes, such as AMOLED, GitHub Dark,
Matrix, Nord, Gruvbox, Dracula, Tokyo Night, Catppuccin Mocha, Solarized
Dark, and One Dark, so the Themes manager never opens empty.

## Safety

Themes cannot read chats, API keys, or the filesystem, and they contain no
executable code. Every stylesheet is scanned for forbidden constructs, and
safe mode disables third-party themes entirely. See
[Safe Mode](safe-mode.md) for the guarantees, and the generated
[Theme SDK reference](../api/theme-sdk/) for the full API.

## Next Steps

- [Levels](levels.md) — tokens, skins, and shell layouts.
- [Design Tokens](design-tokens.md) — the semantic token contract.
- [Component Skin](component-skin.md) — the styling stack and hooks.
- [Shell Contract](shell-contract.md) — named areas and stable slots.
- [Safe Mode](safe-mode.md) — recovery from broken themes.
