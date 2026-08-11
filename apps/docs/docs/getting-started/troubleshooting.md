---
title: Troubleshooting
description: Fixes for common NeoTavern installation and startup problems.
sidebar_position: 5
---

This page answers common install and run problems as a Q&A. If your issue is
not listed, collect the relevant log lines and open an issue on the
[GitHub repository](https://github.com/Disya123/NeoTavern).

## Why Does the App Say the Port Is Already in Use?

The local backend listens on `127.0.0.1:8000` by default. If another program
occupies that port, the sidecar cannot start. Close the conflicting program,
or launch the server with a different port by setting `NEOTA_PORT` in the
environment. The error message in the app includes the port number and the
details you need to resolve the conflict.

## The Backend Sidecar Does Not Start

The desktop app runs its backend as an embedded Node.js sidecar. If it fails
to start, the app window shows a connection error. Check the following:

- Another NeoTavern instance may already be running and holding the port.
- The data directory may not be writable at its current location.
- An antivirus or firewall may be blocking the embedded Node runtime.

Restart the app after addressing the cause. If the app enters a crash loop,
it offers a safe-mode launch that disables third-party plugins and themes
before they load — use it to recover.

## The Database Is Locked

NeoTavern uses SQLite with WAL mode and a busy timeout, so brief concurrent
access is expected and handled. A persistent "database is locked" error
usually means a second app instance opened the same data directory, or a
backup or import operation is still running. Close duplicate instances and
wait for long operations to finish before retrying.

## How Do I Clear Caches?

Caches live under `data/cache/` and are fully regenerable: thumbnails,
tokenizer data, and plugin dependency downloads. Clearing a cache never
deletes your originals, which are stored separately under `data/files/`.
Use the maintenance controls in Settings → Data to clear caches and to
rebuild the full-text search index. Both actions confirm the count and size
of what will be removed before doing anything.

## Where Do Logs Live?

Logs are written to `data/logs/server.log`, rotated at 10 MB. The log file
is redacted: secrets, API keys, and user message content are never logged.
Console output is kept alongside the file. When reporting a bug, include the
relevant log lines and the trace ID shown in the error details.

## How Do I Get Back to a Working Interface?

Use safe mode: it is reachable before third-party themes and plugins load
and disables them. After a broken theme or plugin, safe mode restores the
built-in interface without editing files by hand. See
[Themes](../user-guide/themes) and
[Extensions](../user-guide/extensions) for details.

## Why Is the Send Button Disabled?

The button is disabled only when there is a concrete reason, which is
explained next to it — most often no active provider or no character
selected. Connect a provider in AI Settings or pick a character, and the
button becomes available. See [Quick Start](quick-start).
