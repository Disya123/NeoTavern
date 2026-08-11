---
title: Themes
description: Installing, switching, and creating themes in NeoTavern, plus safe mode.
sidebar_position: 8
---

This page explains how themes work in NeoTavern: what they can change, how
to install and switch them, and how safe mode protects you.

## What a Theme Changes

A theme has three levels:

- **Design tokens** — colors, fonts, spacing, radii, shadows, and motion
  durations.
- **Component skin** — the look of buttons, panels, and other controls.
- **Shell layout** — the arrangement of named regions: navigation,
  character browser, chat viewport, side panels, and modal layer.

This means themes are full visual overhauls, not just color swaps. A theme
can restyle the app like a game console, a visual novel, or a mobile client
without changing any chat logic. Switching the theme, component skin, or
shell layout never requires a restart.

## Bundled Themes

The first run seeds a set of built-in themes, including AMOLED, GitHub
Dark, Matrix, Nord, Gruvbox, Dracula, Tokyo Night, and Catppuccin Mocha.
The Themes manager always opens with these available, so you can switch
styles immediately.

## Installing Themes

A theme package is a `.sttheme` file — a ZIP with a `theme.json` manifest
and CSS, up to 25 MB. Install it through the Themes manager:

1. Open Themes from the navigation rail or the Settings → Themes tab.
2. Install the package. The server validates paths, file types, sizes, and
   the manifest before anything is written, and rejects traversal paths,
   symlinks, and forbidden CSS.
3. Preview the theme before applying it. From the preview you can accept
   the theme, go back, or open its settings.
4. Activate it. Installation never activates a theme by itself.

Updates to an installed theme replace it atomically and keep its activation
state. If a theme fails to load, the shell automatically restores the last
working layout.

## Custom Themes

Themes are packages, not hacks: a theme gets no access to your chats, API
keys, or filesystem. The Theme SDK documents the stable hooks —
`data-component`, `data-part`, `data-role`, and `data-state` — that themes
style, and the shell contract that defines the named regions. Custom CSS
overrides load last in the cascade. See the
[Theme SDK](../developers/theme-sdk/) reference for building your own.

## Safe Mode and Recovery

Safe mode disables all third-party themes and plugins and is reachable
before they load, so a broken theme can never lock you out. After a crash
loop the app offers a safe launch automatically. The built-in **Reset
interface** action restores the default theme without editing files by
hand, and no theme is allowed to hide that action.

See [Settings](settings) for the General tab where the active theme and
message style options live.
