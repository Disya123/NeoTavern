---
title: Extensions & Plugins
description: Installing, enabling, disabling, and uninstalling plugins in NeoTavern.
sidebar_position: 9
---

This page explains how plugins work in NeoTavern: where to get them, how
permissions and consent work, and how the app keeps untrusted code in
check.

## What a Plugin Is

A plugin adds behavior to NeoTavern — toolbar actions, message actions,
slash commands, prompt interceptors, custom panels, hotkeys, backend
routes, or integrations with external services. Plugins run against the
stable Plugin SDK, not against the app internals, and every feature they
register is removed again when the plugin is disabled.

The official catalog ships some plugins; third-party packages are
installed from a `.stplugin` ZIP or a public Git repository link
(GitHub or GitLab, HTTPS only). The server never runs Git or npm: a Git
link is downloaded as an archive and validated exactly like a ZIP.

## Installing a Plugin

Open the Plugins section and install a package:

1. Before installation, the app shows the author, version, source,
   compatibility, signature (when signed), and the full permission list.
2. You review and explicitly consent to the permissions. The package stays
   in a "requires consent" state until you confirm every requested
   permission.
3. Installation is atomic: on any error, the previous version stays
   installed and working.

If the package declares npm dependencies, they are resolved from the
registry over HTTPS, verified by checksum, and never executed — install
scripts and native binaries are rejected outright.

## Permissions

A permission in the manifest is a request for a capability, not automatic
access. Before a plugin can read chats, modify prompts, touch your files,
or reach the network, you must grant the matching permission, and the
consent screen describes what each one does. Two rules matter:

- **New permissions after an update require fresh consent.** An update can
  never extend a plugin's rights silently.
- Permissions can be revoked. Revocation takes effect on the plugin's next
  capability call.

## Managing Plugins

The manager shows each plugin's state: enabled, disabled, needs
permissions, incompatible, or error. From there you can:

- **Enable or disable** a plugin. Disabling removes its UI, hooks, timers,
  routes, and subscriptions without a restart, and the cleanup is enforced
  by the host.
- **Uninstall** it, which also clears its registrations.
- **Review compatibility** for legacy SillyTavern-era extensions, which
  show their compatibility level and known limitations.

An error in one plugin is isolated: the app offers to disable just that
plugin instead of breaking the whole interface.

## Plugin Safety

Untrusted backend plugins run in a separate restricted process, and
sandboxed plugin UI runs in an iframe with a controlled RPC channel. Theme
packages get no access to chats, keys, or files. Safe mode disables all
third-party plugins and themes and is reachable before they load, so any
plugin misbehavior can always be escaped. See
[Safe mode and recovery](themes) and the
[Plugin SDK](../developers/plugin-sdk/) documentation.
