---
title: Quick Start
description: Connect a provider, pick a character, and send your first message in NeoTavern.
sidebar_position: 3
---

This page walks you from a fresh install to your first generated message in
about five minutes. You need an active provider; everything else is optional.

## 1. Launch the App

Open NeoTavern. The Home screen opens directly, and the first run shows a
non-blocking checklist where you pick your language and text scale. You can
ignore the checklist and come back to it later — nothing here blocks the
character gallery, imports, or local settings.

## 2. Connect a Provider

Generation needs a provider: a local model server on your machine or a
remote API. Open the AI Settings panel or the Providers section:

1. Choose an API type (for example, Chat Completions) and a source, which
   defines the provider.
2. Enter your API key. Keys are stored locally, never shown in full after
   saving, and never included in exports by default.
3. Optionally load the model list for that provider and pick a model.
4. Use **Test Connection** to verify availability and latency, then
   **Connect** to activate the profile.

No provider yet? Select the built-in **Echo** provider to test the full
pipeline offline. Echo replies with a canned echo and needs no key or
network access.

While no provider is active, the Send button is disabled and the app shows
why next to it. Provider errors never lock you out of your local library.

## 3. Pick or Create a Character

Open the Characters section from the navigation rail:

- Browse the gallery and open a card to start chatting.
- Import a character card (PNG or JSON) from disk.
- Create a new character from scratch — only a name is required.

See [Characters](../user-guide/characters) for the full details.

## 4. Send Your First Message

With a character selected, the chat canvas opens with the character's
greeting as the first assistant message. Type below and press `Enter` to
send. The chat is created on the backend only after you send a first
non-empty message, so browsing never leaves empty chats behind.

The reply streams in as it is generated. You can stop it at any time or
scroll back through the history while it streams. See
[Chatting](../user-guide/chat) for everything the chat view can do.

## Next Steps

- [Troubleshooting](troubleshooting) if the backend does not start or a
  port is already in use.
- [Settings](../user-guide/settings) to tune generation parameters and
  connection profiles.
- [Data & Backups](../user-guide/data-and-backups) to import an existing
  SillyTavern backup or create your own.
