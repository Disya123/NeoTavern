---
title: Groups
description: How NeoTavern handles multi-character conversations and group chats.
sidebar_position: 4
---

This page explains what groups are and how NeoTavern handles
multi-character conversations today.

## What a Group Is

A group is a single conversation in which several characters take part.
Where a regular chat has one character plus your persona, a group chat
switches between characters so that each reply can come from a different
participant.

## Groups in NeoTavern Today

The core chat model of NeoTavern is one character per conversation, with
your persona layered on top. A dedicated group chat feature that lets you
create a conversation and switch its members in the app is **planned**; it
is not available in the current release, so this page describes what works
today instead.

## Imported Group Chats

When you migrate a SillyTavern backup through Settings → Data, group chats
are handled safely:

- Group definitions and their transcripts are imported as regular chats,
  carrying the original group record in the chat metadata.
- The transcript keeps every participant name, message, and swipe variant,
  so the multi-character history remains readable and you can continue the
  conversation.
- Unsupported categories are listed explicitly in the import report instead
  of being silently dropped.

## Working with Multiple Characters Now

While native groups are planned, these features cover the common
multi-character workflows:

- **Separate chats per character.** Each character keeps their own chat
  history, and the Chats panel scopes the list to the current character.
- **A shared world via lorebooks.** Bind a lorebook to several characters
  so consistent world knowledge reaches every conversation. See
  [Lorebooks](lorebook).
- **Storyline branches.** Use checkpoints and branches to explore divergent
  paths with any character without losing the main conversation. See
  [Chatting](chat).
- **Personas.** Switch your own persona per chat to change how you present
  yourself in each conversation.

If you need a true multi-character conversation, keep the imported group
chat approach in mind: it preserves your existing group history, and the
planned native feature will build on the same data.
