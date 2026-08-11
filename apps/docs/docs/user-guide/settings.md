---
title: Settings
description: Global and per-chat settings, connection profiles, providers, and API keys in NeoTavern.
sidebar_position: 7
---

This page explains where settings live in NeoTavern and how to configure
providers, connection profiles, and API keys.

## Where Settings Live

NeoTavern has no separate settings page. Everything opens as a panel or
modal over the chat workspace, and closing it returns you to the exact same
chat and draft:

- **Settings** (from the navigation rail) groups app-wide options into
  tabs: **General** (language, text scale, startup screen, message style,
  avatar shape, accessibility), **Themes** (install and activate themes),
  and **Data** (migration, backups, cache maintenance, diagnostics).
- **AI Settings** is the context panel for generation. Its **Config** tab
  holds the request parameters for the active model: context size, response
  length, streaming, sampling, penalties, seed, and reasoning. The
  **API** tab manages connection profiles and keys, and **Advanced** builds
  custom chat and instruct templates from ChatML, Llama 3, or Alpaca.

Settings changes apply immediately where they are easily reversible.
Options that differ from their defaults are marked and can be reset
individually, and settings search covers names, descriptions, and keywords.

## Global vs. Per-Chat Settings

Global settings in **Settings** apply to the whole app: language, theme,
data management, and defaults. Per-chat behavior lives next to the chat:
generation parameters, the active provider and model, and the context
strategy are edited in the AI Settings panel while the chat stays open, and
drafts and scroll position are preserved. The persona is per-chat too —
each conversation can use a different persona while the app-wide active
persona remains the default.

## Providers and Connection Profiles

A connection profile bundles everything needed to talk to a provider:
the API type and source, base URL where applicable, the selected API key,
and the model. The **API** tab in AI Settings (and the Providers section)
lets you:

1. Choose the top-level API (Chat Completions or Text Completions).
2. Pick a source, which filters to the sources of that API and becomes the
   profile name.
3. Enter the base URL for OpenAI-compatible servers, usually ending in
   `/v1`.
4. Choose or type a model ID, optionally loading the model list first.
5. **Test Connection** to check availability and latency, then **Connect**
   to activate the profile.

## API Keys

Keys are stored locally in a key manager that holds several named keys per
provider with one active at a time. Secrets are verified before saving and
are never displayed in full after that — only a masked suffix remains
visible. Exports and diagnostics exclude secrets by default, and provider
errors are shown as localized messages with technical details and a trace
ID in a collapsible block.

See [Themes](themes), [Extensions](extensions), and
[Data & Backups](data-and-backups) for the rest of the app-wide settings.
