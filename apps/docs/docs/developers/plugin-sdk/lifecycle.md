---
title: Plugin Lifecycle
description: How plugins move from install to consent, activation, and teardown.
sidebar_position: 6
---

A plugin moves through a defined lifecycle: install, consent, activation,
active, and finally teardown. Every transition is host-enforced.

## Install

Installing happens through the Plugin Manager. You can install a bounded
`.stplugin` ZIP archive or a public repository link (`github.com` or
`gitlab.com`, HTTPS only). The host never invokes the git binary; it downloads
a repository archive and runs it through exactly the same validation as a
ZIP: path traversal, symlinks, executable payloads, sizes, manifest fields,
entry points, and permissions. Installation is atomic and rolls back on any
error.

If the package ships a `package.json` with dependencies, the built-in
resolver fetches them from the npm registry without executing install
scripts. Bundle your dependencies instead when possible; the resolver exists
for heavy WASM libraries that cannot reasonably be bundled.

## Consent

After validation the plugin enters a `needs-consent` state. It stays there
until the user confirms every requested permission (and reviews the npm
dependency list when one exists). No entry point runs during this phase.
See [Permissions](permissions.md) for the full model.

## Activation

Activation is a two-phase operation:

1. Backend and legacy registrations start first.
2. The frontend entry loads and receives its API.

If activation fails partway, the host rolls back the partial registrations
and records a load failure. A failed activation never leaves half-registered
surfaces behind.

## Active Runtime

While active, every registration the plugin makes — UI surfaces, routes,
event subscriptions, i18n resources, notifications, providers, tokenizers,
context strategies, and post-processors — is collected by the runtime. The
plugin can also manage its own resources in `deactivate()`.

## Teardown

Disable, safe mode, deletion, a crash, or application shutdown all trigger
host-enforced cleanup. The runtime disposes collected registrations in
reverse order, and the guarantees are strict: after a plugin is disabled,
nothing remains.

- No event handlers or subscriptions.
- No timers.
- No DOM nodes.
- No mounted routes.
- No background requests.
- No registered providers, tokenizers, or strategies.

An error thrown by the plugin's own `deactivate()` does not cancel the
required cleanup — the host still disposes everything it tracks. Teardown is
idempotent: calling it twice has no effect.

## Update

Updating replaces the package atomically and keeps the current activation
state, with one exception: if the new manifest adds permissions, the runtime
is disabled immediately and stays disabled until the user consents to the
new permissions. Rolling back to a previous version is done by installing
that version again; user data in plugin storage survives both directions.

## Crash Handling

A backend plugin runs in its own process. If that process crashes, the host
removes all registrations for the plugin and reports the failure. A crashed
plugin cannot leave orphan routes or event subscriptions, because they are
owned by the host, not the process.

For the security model that makes these guarantees possible, see
[Sandboxing](sandboxing.md). For the manifest fields that drive the
lifecycle, see [Manifest](manifest.md).
