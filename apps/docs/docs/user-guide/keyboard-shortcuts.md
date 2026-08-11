---
title: Keyboard Shortcuts
description: The default keyboard shortcuts in NeoTavern at a glance.
sidebar_position: 11
---

This page lists the default keyboard shortcuts in NeoTavern. The whole app
is operable from the keyboard, and every modal keeps focus inside itself
until you close it.

## Composer

| Action                       | Shortcut                                        |
| ---------------------------- | ----------------------------------------------- |
| Send message                 | `Enter`                                         |
| Insert a new line            | `Shift+Enter`                                   |
| Open chat search             | Focus the search field in the chat header       |
| Scroll to the latest message | Use the "new message" action after scrolling up |

The composer hint always shows the current mode, so you can see whether
`Enter` sends or adds a line at a glance.

## Editing Messages

| Action          | Shortcut                                            |
| --------------- | --------------------------------------------------- |
| Save the edit   | `Ctrl+Enter` (Windows/Linux) or `Cmd+Enter` (macOS) |
| Cancel the edit | `Escape`                                            |

Editing is non-destructive: the previous content is archived in the
message's edit history, and a conflict keeps your draft instead of
overwriting it. See [Chatting](chat).

## Navigation and Panels

| Action                                   | Shortcut                                                      |
| ---------------------------------------- | ------------------------------------------------------------- |
| Close the topmost panel, dialog, or menu | `Escape`                                                      |
| Move focus forward / backward            | `Tab` / `Shift+Tab`                                           |
| Close a route-aware surface              | Browser Back                                                  |
| Resize a resizable panel                 | `ArrowLeft` / `ArrowRight` while the resize handle is focused |
| Open and close the navigation menu       | The rail toggle button                                        |

`Escape` closes the topmost surface first: a nested dialog closes before
the panel behind it, and focus returns to the control that opened it.

## Chat Actions

| Action                                | Shortcut                                                           |
| ------------------------------------- | ------------------------------------------------------------------ |
| Switch between swipe variants         | Previous / next arrows in the `N/M` pager                          |
| Open a checkpoint snapshot            | Click the checkpoint flag (or `Shift+Click` to create a fresh one) |
| Exclude or restore a message manually | The exclude action in the message                                  |
| bar (manual context strategy)         |

Message actions are always visible on desktop and grouped in the compact
message card on mobile; every action is a focusable control, so no action
requires hover or a pointer.

## Plugin Hotkeys

Plugins register their hotkeys through the Plugin SDK, which resolves
collisions so the newest active registration wins and frees the binding
when the plugin is disabled. Plugin shortcuts never intercept the system
browser combos, and the command palette lists each command's shortcut in
context. See [Extensions & Plugins](extensions).
