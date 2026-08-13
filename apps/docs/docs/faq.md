---
title: FAQ
description: Common questions about data, offline use, plugins, updates, and migration
sidebar_position: 2
---

This page answers the questions users ask most often about NeoTavern.

## Where Is My Data Stored?

All your data — chats, characters, personas, groups, lorebooks, memory, and
settings — lives in a data directory on your machine. The directory holds the
SQLite database and the file store with character cards, images, and other
assets. See [Data & Storage](./developers/data/) and
[Data and Backups](./user-guide/data-and-backups) for the exact layout and how
to move it.

## Does NeoTavern Work Offline?

Yes. NeoTavern is local-first and offline-capable: point it at a local model
endpoint and you can chat with no internet connection at all. Cloud providers
obviously need the network, and the app tells you when a connection is missing.

## Is My Data Sent to the Cloud?

No. Your chats and files stay on your machine. The only network traffic is the
requests you explicitly configure — the providers you connect for generation,
speech, and images — and the app sends no telemetry by default.

## Do I Need an API Key?

Only for the cloud providers you choose to connect. Local models need no key at
all; you configure each provider in Settings, and the key stays in your
connection profile.

## Are Plugins Safe?

Plugins run under a permission model and are sandboxed: backend plugins execute
in a restricted process, and plugin UI is isolated from the main app. You grant
permissions at install time, and Safe mode starts the app without plugins and
themes if something goes wrong. See [Extensions](./user-guide/extensions) and
the [Plugin SDK](./developers/plugin-sdk/).

## Can I Use My Existing Characters?

Yes. NeoTavern imports standard character cards, including PNG cards with
embedded JSON, so characters from other chat apps and from the community
character gallery work out of the box. See [Characters](./user-guide/characters).

## Can I Migrate My SillyTavern-Era Plugins?

Plugins written against the older SillyTavern environment can run through the
legacy compatibility layer, which provides the familiar `window.SillyTavern`,
`window.eventSource`, and `window.$` globals plus an Express-compatible HTTP
host. It is a compatibility path, not a rewrite target: new plugins should use
the [Plugin SDK](./developers/plugin-sdk/). See
[Legacy Compatibility](./developers/legacy-compat).

## How Do Updates Work?

Updates install in place and preserve your data directory. The changelog lists
what changed in each release; read it before updating to catch breaking changes.

## What Are the System Requirements?

NeoTavern runs on Windows (installer or portable build), macOS (package), and
Linux (AppImage or archive). The desktop app bundles its own Node.js runtime, so
you do not need to install anything else. A current 64-bit operating system and
a few hundred megabytes of free RAM for the backend are enough for typical use.

## Is There a Web or Mobile Version?

The desktop app is built on Tauri and ships with an installable Web Client: the
web UI can be installed as a remote client with a cached app shell (API and
generation still require a reachable backend). See
[Desktop](./developers/desktop/).

## How Do I Back Up My Data?

Export chats to files, export your whole library, or copy the data directory
while the app is stopped. Backups are plain, portable files; restore by
importing them or putting them back in place. See
[Data and Backups](./user-guide/data-and-backups) and
[Backups](./developers/data/backups).

## What Is Safe Mode?

Safe mode starts NeoTavern without plugins and themes so you can diagnose
problems caused by third-party code. Use it when the app fails to start after
installing a plugin or theme. See
[Troubleshooting](./getting-started/troubleshooting).

## How Do I Report a Bug or Request a Feature?

Open an issue on the [GitHub repository](https://github.com/Disya123/NeoTavern)
with the version, your OS, and steps to reproduce. Feature requests are welcome
there too.

## Where Can I Find the Changelog?

The changelog lives in the repository at
[CHANGELOG.md](https://github.com/Disya123/NeoTavern/blob/main/CHANGELOG.md).
