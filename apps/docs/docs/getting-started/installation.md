---
title: Installation
description: How to install NeoTavern on Windows, macOS, and Linux.
sidebar_position: 2
---

This page explains how to install NeoTavern on Windows, macOS, and Linux.
Download the build for your platform from the
[GitHub releases page](https://github.com/Disya123/NeoTavern/releases).

## Install Targets

- **Windows installer.** A setup executable that installs the app and adds
  shortcuts. Recommended for most Windows users.
- **Portable Windows build.** A self-contained folder that runs without
  installing anything. It keeps all data inside its own directory, so you can
  carry it on a USB drive.
- **macOS package.** A standard `.app` bundle. Drag it into Applications and
  launch it from there.
- **Linux AppImage and archive.** The AppImage runs on most desktop
  distributions. The archive variant is a plain folder you can place anywhere
  and launch with a double click.

All four targets are functionally identical. Choose whichever fits how you
manage software on your machine.

## System Requirements

- A 64-bit desktop OS: Windows 10 or newer, macOS, or a mainstream Linux
  distribution.
- Enough memory and disk space for your library. The idle backend uses about
  180 MB of RAM on a reference machine, and the app reaches a ready UI in
  about four seconds on that same machine.
- No separate Node.js, Python, SQLite, or browser installation. Everything
  the app needs is bundled.

## What Is Bundled

The distribution embeds Node.js 24 LTS and SQLite, and the desktop shell
runs the local backend as an embedded sidecar process. That means:

- The first run never executes `npm install` and never requires a terminal.
- The backend binds to `127.0.0.1` only. LAN or remote access is never
  enabled silently; it requires an explicit opt-in.
- Closing the app window gracefully shuts the sidecar down, so no backend
  process is left behind.

## After Installation

The first launch creates your data directory, seeds a small starter library,
and opens the Home screen. See [Quick Start](quick-start) for the next steps.

If something goes wrong during install or first run, see
[Troubleshooting](troubleshooting).
