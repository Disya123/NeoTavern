---
title: Safe Mode
description: How safe mode disables third-party themes and plugins, and why reset always works.
sidebar_position: 6
---

Safe mode is the recovery mechanism for the visual layer: it disables
third-party themes and plugins so the interface always returns to a working
state.

## What Safe Mode Does

Safe mode is activated with `?safe=1` in the URL. It is handled before any
package code loads:

- Third-party theme CSS and token overrides are not added to the document.
- Third-party plugin entry points never run, including legacy entry points.
- The built-in theme and built-in plugin runtime remain active.

The interface falls back to the built-in light and dark tokens, which are
always present. Leaving safe mode restores the previously saved active theme
and plugin state — exiting does not change your selection.

## Why a Broken Theme Cannot Block Recovery

Several guarantees protect the user from a broken theme:

- **Preview before apply** — themes are previewed before activation, and
  installing a package never activates it automatically.
- **Safe mode is pre-package** — `?safe=1` is processed before the theme
  registry is consulted, so even a theme whose CSS crashes the renderer is
  never loaded.
- **The reset button** — the reset action returns the built-in theme,
  removes runtime CSS links, and clears inline `--st-*` overrides. Deleting
  the active theme also resets the saved theme selection.
- **Themes cannot hide Settings** — the navigation rail always keeps the
  Settings item reachable, because omitted system items are restored in the
  standard order. In safe mode the built-in rail order is used and the
  menu toggle stays available.
- **No code execution** — themes contain no JavaScript at all. They are CSS,
  tokens, and declarative layout, so there is no theme code that could run
  before safe mode takes effect.

## Theme Package Restrictions

A theme package never receives access to chats, API keys, or the filesystem.
Its stylesheets are validated against forbidden constructs (`@import`,
remote URLs, `javascript:` URLs, `expression()`, `!important`, and others)
before they are accepted, and its tokens must be safe CSS values. There is
no executable entry point in the Theme SDK.

## Safe Mode for Plugins

The same switch disables third-party plugins. Plugin sandboxes, process
isolation, and host-enforced cleanup are the runtime layer; safe mode is the
belt-and-suspenders switch that prevents untrusted code from loading in the
first place. See [Plugin sandboxing](../plugin-sdk/sandboxing.md) for the
plugin-side details.

## Checking Safe Mode Programmatically

The `@neotavern/theme-sdk` package exports `getSafeModeFromSearch(search)`, which
parses the URL search string and returns whether `?safe=1` is present. The
host uses it as the single gate before loading package CSS and token
overrides, and the same function is available to alternative hosts.

For the shell areas that remain available in safe mode, see
[Shell Contract](shell-contract.md).
