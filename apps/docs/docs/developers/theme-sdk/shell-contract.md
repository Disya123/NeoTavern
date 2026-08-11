---
title: Shell Contract
description: The named shell areas that themes style and plugins fill.
sidebar_position: 5
---

The shell contract defines the named areas of the application. Themes style
these areas; plugins add content into them through stable slots.

## Named Shell Areas

The host publishes each major area with a stable slot attribute:

| Slot                 | Area                                               |
| -------------------- | -------------------------------------------------- |
| `app.shell`          | The application shell root                         |
| `navigation.primary` | The navigation rail                                |
| `chat.header`        | The chat header                                    |
| `chat.viewport`      | The chat scrolling viewport                        |
| `chat.composer`      | The message composer                               |
| `character.browser`  | The character browser root                         |
| `panel.left`         | The left context panel                             |
| `status.area`        | The connection status area                         |
| `modal.layer`        | The modal layer (plugins below the system surface) |
| `notification.layer` | The notification layer                             |

Two slots are reserved but not part of v1: `navigation.secondary` and
`panel.right`.

## What the Contract Allows

A theme can:

- **Style any named area** through its `data-slot` attribute and the
  component hooks inside it.
- **Arrange the main areas** through the declarative `shellLayout` in the
  manifest — currently the navigation rail order (`main` and `bottom`
  groups) and the placement of management tabs (`pinned`).
- **Replace the chat canvas background** through the `chat-wallpaper-*`
  tokens.

Free-form rearrangement of areas — moving the rail to the right side, for
example — is not part of v1. Slots are styled and filled, not relocated.

## How Plugins Add Content

Plugins receive the SDK registration APIs and the host places their content
into the stable slots. For example, a sidebar panel registered with
`slot: 'left'` renders inside `panel.left`, and plugin dialogs stack inside
`modal.layer` below the system surface.

The contract that follows from this split:

- Themes never depend on a plugin's internal DOM.
- Plugins never depend on the internal React hierarchy or on specific
  generated class names.
- Both sides meet only at the named slots and the hook attributes.

## Stable Hooks Inside Areas

Within the areas, components publish the standard hook attributes. Notable
examples:

- The composer root publishes `data-slot="chat.composer"`, with a toolbar
  part, a field part, and a `data-component="textarea"` input.
- Buttons publish `data-component="button"` with `data-part="icon"` and
  `data-part="label"`; related actions live in an action bar
  (`data-component="action-bar"`) with primary and secondary groups.
- Tabs publish `data-component="tabs"` with `list`, `trigger`, and `content`
  parts; the management panels use the segment variant.
- Messages publish `data-component="chat-message"` with
  `data-role="user|assistant|system|tool"` and states such as `streaming`.
- The navigation rail publishes `data-component="navigation-rail"` with
  `data-part="main-items"`, `data-part="bottom-items"`, and
  `data-item="<id>"` per entry, plus `data-state="expanded|collapsed"`.
- All rail panels share one header chrome
  (`data-component="sidebar-panel-header"`) so a theme styles them once.

## Layout Responsibilities

The host owns behavior-critical layout: focus trapping, logical RTL
direction, safe-area insets, and minimum interactive target sizes. A shell
theme may change the look and arrangement of areas, but must preserve DOM
order where documented, the horizontal scrolling of action lists, and
keyboard behavior. Breakpoints are registered in the SDK
(`VIEWPORT_BREAKPOINTS` for viewport widths in px, `CONTAINER_BREAKPOINTS`
for container sizes in rem) and feature queries such as
`prefers-reduced-motion` are not layout breakpoints.

For the styling layer that skins these areas, see
[Component Skin](component-skin.md); for recovery when a shell is broken,
see [Safe Mode](safe-mode.md).
