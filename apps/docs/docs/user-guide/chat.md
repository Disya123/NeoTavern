---
title: Chatting
description: How chatting works in NeoTavern — streaming, swipes, regenerate, edit, and stop.
sidebar_position: 2
---

This page covers the chat view: composing and sending messages, watching
replies stream in, and working with the message actions that NeoTavern
provides.

## Sending Messages

The composer sits at the bottom of the chat canvas. Type a message and press
`Enter` to send; press `Shift+Enter` for a new line. Your message appears
instantly, and the reply streams into the view in batches of at most 30 UI
updates per second. You can scroll through history while a reply streams —
auto-scroll only follows you while you stay at the bottom, and a "new
message" action appears after you scroll up manually.

While a reply is generating, the main composer button becomes **Stop**.
Stopping keeps the text received so far as an explicitly marked incomplete
response. A dropped connection offers a reconnect and never creates a
duplicate message.

Your draft is saved per chat, so switching away and back never loses what
you were typing.

## Swipes (Alternative Messages)

Every assistant message can hold several alternative replies, called
swipes. A pager under the message shows the count as `N/M` with previous and
next arrows; clicking the arrows cycles through the variants without
losing any of them. Swipe history is preserved and non-destructive.

## Regenerate

The regenerate action rewrites the **latest** assistant message in place: a
new reply streams into the existing bubble, and the previous text becomes
another variant in the swipe pager. If generation fails or is stopped, the
old text stays on disk untouched.

## Editing Messages

Open the edit action on a message to change its text. The inline editor
saves with `Ctrl+Enter` (or `Cmd+Enter` on macOS) and cancels with
`Escape`. Edits are non-destructive: the previous content is archived into
the message's edit history, from which you can restore it at any time. If
the message changed elsewhere while you were editing, the editor keeps your
draft and shows a conflict notice instead of overwriting silently.

## Message Actions

The action bar on each message is always visible, not hover-only:

- Copy the raw message text.
- Edit the message.
- Regenerate the last assistant reply.
- Swipe through variants.
- Create a **checkpoint** or **branch**: a snapshot of the chat frozen at
  that message, copied into a child chat. Use checkpoints to explore
  storylines without touching the main conversation.
- Delete the message. Deletion moves chats to a trash state rather than
  destroying them instantly.

Plugins can add their own actions to the same bar, subject to the
permissions you granted them. See [Extensions](extensions).

## Keyboard Control

The whole chat flow works from the keyboard: `Tab` and `Shift+Tab` move
focus, `Escape` closes the topmost panel or dialog, and the swipe pager,
checkpoint links, and message actions are all focusable controls. See
[Keyboard Shortcuts](keyboard-shortcuts) for the full list.
