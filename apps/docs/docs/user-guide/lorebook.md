---
title: Lorebooks
description: What lorebooks are, how entries activate, and how to bind them to characters.
sidebar_position: 5
---

This page explains lorebooks: collections of world knowledge that NeoTavern
injects into the prompt exactly when it becomes relevant.

## What a Lorebook Is

A lorebook is a set of entries about a world, a setting, or a character:
locations, factions, history, people, rules of magic — anything the model
should know but that would waste tokens to include in every message.
Instead of loading the whole book into the prompt, the app activates only
the entries whose keywords match the current conversation.

A book is scoped either **global** (available in every chat) or bound to a
**character** (used only in that character's conversations). You can link
and unlink books per character from the character editor's Lore section.

## Entries

Each entry has:

- **Primary keys** — one or more activation keywords. At least one primary
  key is required.
- **Secondary keys** — additional optional keywords.
- **Content** — the text injected into the prompt when the entry fires.
- **Position** — where the entry is inserted relative to other entries.
- **Toggles** — `enabled` (participate in activation), `constant` (always
  included), and `selective` (insert only at the configured position).

Matching is a case-insensitive substring match against the conversation
context. When an entry fires, its content is inserted into the prompt at
the entry's position, and the entry dialog shows an estimate of its size in
tokens so you can keep the budget predictable.

## Insertion Order

The pipeline assembles prompt blocks in a fixed order: main prompt,
lorebook before the character, persona, character, lorebook after the
character, dialogue examples, memory, chat history, post-history
instructions, and the current user input. Lorebook entries are ranked by
relevance alongside memory blocks, and constant entries are always present.
The effective order of activated entries follows their position within the
book, so a well-structured book produces a stable prompt.

## Managing Books

The Lorebooks panel in the navigation rail has three tabs: the list of
books, the book editor, and the entry list. The list shows each book's
name, description, load count, and a scope badge (Global or Character),
with filters for global books, a specific character's books, or all books.
Books are deleted to a trash state and can be restored, and search over
books is debounced for large libraries.

New books created from the character editor are immediately bound to that
character. See [Characters](characters) for the editor, and
[Memory & Recall](memory) for how memory blocks interact with lorebook
entries.
