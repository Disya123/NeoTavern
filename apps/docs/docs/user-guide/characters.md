---
title: Characters
description: The character gallery, character cards, and importing or exporting cards in NeoTavern.
sidebar_position: 3
---

This page explains how to find, create, edit, and share characters in
NeoTavern. A character is a participant in your chats, backed by a
character card that stores everything the AI knows about them.

## The Character Gallery

The Characters section is your library browser. It supports a grid and a
compact list view, both virtualized so they stay fast with tens of
thousands of cards. Thumbnails are used for previews; the original images
load only when you open a card.

Search supports a simple query language: `tag:NSFW author:Name
"exact phrase" -tag:beta`. Tag and author filters combine with the search
terms, and results are ranked by relevance whenever you type a query.
Sorting includes alphabetical, newest, oldest, favorites, recently used,
more or fewer chats, more or less content, and random.

## Creating and Editing Characters

Open any card and choose Edit. The editor is split into clear groups:

- **Identity** — name, avatar, and tags.
- **Description** — who the character is.
- **First message** — the greeting, plus any alternate greetings.
- **Scenario** — the setting the roleplay starts from.
- **Examples** — dialogue examples that shape the character's style.
- **Lore** — lorebooks bound to this character.
- **Images** — a gallery of images, one of which is the primary avatar.
- **Advanced** — personality, creator notes, prompt overrides, character's
  note with depth and role, talkativeness, and creator metadata.

Only the name is required to create a character. Validation messages appear
next to the field and in a final error list, and required fields are labeled
with text, not just color.

## Character Cards

A character card is the portable representation of a character. Its fields
include name, description, personality, scenario, the first message
(greeting), alternate greetings, tags, and avatar. Cards also carry creator
notes, and unknown fields from imported cards are preserved rather than
dropped, so no metadata is lost when you round-trip a card through another
tool.

## Importing and Exporting Cards

- **Import** accepts PNG and JSON character cards (V1 and V2), and it
  works from the gallery, from a chat, or during first-run setup. Import is
  safe to repeat — running it twice never creates duplicates.
- **Export** writes the card as PNG or JSON, exactly as you choose, with a
  version snapshot of the current state.
- Avatars and gallery images upload as files; a replaced image is never
  removed until the new one saves successfully.

If a card in your library is damaged, NeoTavern shows a safe preview with
the reason and lets you export the original so you can repair it elsewhere.
