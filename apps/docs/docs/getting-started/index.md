---
title: What Is NeoTavern
description: An introduction to NeoTavern, a local-first AI chat and roleplay platform.
sidebar_position: 1
---

NeoTavern is a local-first AI chat and roleplay platform that runs on your own
computer. You create or import characters, talk to them through any AI model
you connect, and keep every message, character card, and setting on your
machine.

## Local-First by Design

- Your data lives in a local data directory on your computer. There is no
  account, no mandatory cloud sync, and no telemetry by default.
- You can browse your library, edit characters, and review settings while
  offline. Only generation needs a reachable provider.
- Before anything is sent to an external AI service for the first time, the
  app shows you exactly which provider will receive the request.

## How It Runs

- The desktop app is available for Windows, macOS, and Linux. It bundles
  Node.js and SQLite, so you never install a runtime yourself.
- The app starts its own local backend, an embedded Node.js sidecar that
  listens on `127.0.0.1:8000` by default and shuts down with the window.
- A responsive PWA lets phones and tablets connect to a backend running on
  your PC or home server.

## What You Need

- A supported 64-bit desktop OS. No terminal, Git, or package manager is
  required at any point.
- A provider to generate replies: a local model server or a remote API with
  your key. The built-in Echo provider lets you verify the whole flow
  offline, without any external service.
- Optional but useful: an existing SillyTavern data backup to migrate your
  characters, chats, lorebooks, and personas.

## Where to Go Next

- [Installation](getting-started/installation) — download and set up the app on your OS.
- [Quick Start](getting-started/quick-start) — connect a provider and send your first
  message.
- [Upgrading](getting-started/upgrading) — how updates work and why your data stays safe.
- [Troubleshooting](getting-started/troubleshooting) — fixes for common install and run
  problems.
- [User Guide](../user-guide/) — in-depth pages on chatting, characters,
  lorebooks, memory, themes, and plugins.
- [FAQ](../faq) — short answers to frequent questions.
