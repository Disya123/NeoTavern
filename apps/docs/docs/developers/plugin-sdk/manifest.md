---
title: Plugin Manifest
description: The plugin.json schema every .stplugin package must contain.
sidebar_position: 2
---

The plugin manifest (`plugin.json`) is the single source of truth for a plugin:
identity, entry points, requested permissions, and declared capabilities.

## Package Layout

A `.stplugin` package is a ZIP archive that contains `plugin.json` at the root,
the entry files it references, and any assets. The host validates the archive
before anything is installed: path traversal, symlinks, executable payloads,
and size limits are all rejected.

## Manifest Fields

```json
{
  "id": "author.plugin-name",
  "name": "Plugin Name",
  "version": "1.0.0",
  "apiVersion": 2,
  "engines": { "neotavern": "^0.1.0" },
  "frontend": "dist/frontend.js",
  "backend": "dist/backend.mjs",
  "styles": "dist/plugin.css",
  "permissions": ["chat.read", "ui.messageActions", "network:api.example.com"],
  "i18n": { "ru": "locales/ru.json", "de": "locales/de.json" }
}
```

The core fields are:

- **`id`** — reverse-DNS identifier, for example `author.plugin-name`. It is
  unique across all installed plugins and stable across updates.
- **`name`** — human-readable name shown in the Plugin Manager.
- **`version`** — semantic version (`major.minor.patch`). It feeds version
  comparisons and cache busting.
- **`apiVersion`** — the SDK API version the plugin targets. The current
  version is 3; version 2 remains the default until the new runtime lands
  in production.
- **`engines`** — compatibility constraints such as `neotavern: "^0.1.0"`.
  See [Engine Compatibility](#engine-compatibility) below.
- **`frontend`** — relative path to the browser ESM entry.
- **`backend`** — relative path to the Node.js ESM entry.
- **`styles`** — optional plugin stylesheet.
- **`i18n`** — locale code to relative path of translation JSON files.

## Engine Compatibility

The `engines` object declares which host versions the plugin is compatible
with. Every declared range is resolved against the current host version at
**install time and at activation time** (ТЗ §76). A mismatch rejects the
install with the stable `ENGINE_MISMATCH` error (`params: { engine, required,
host }`); an already-installed plugin whose update would be incompatible is
auto-disabled with the same diagnostic and keeps its previous version.

Supported range syntax (rev4 §A4): exact `x.y.z`, caret `^x.y.z`, comparator
lists like `>=2.4.0 <3`, major-only upper bounds like `<3`, and `*`. A major
bump is incompatible; minor changes are additive.

The four engine axes and the host version each is compared against:

| Engine      | Host version                            |
| ----------- | --------------------------------------- |
| `neotavern` | Application version (`/api/v2/version`) |
| `host`      | Plugin host handshake version (`2.0.0`) |
| `sdk`       | Plugin SDK API major, e.g. `3.0.0`      |
| `protocol`  | Kernel protocol version (`2.0.0`)       |

`engines` is optional — plugins without it are not affected. Example:

```json
{
  "engines": {
    "neotavern": "^0.1.0",
    "host": ">=2.0.0 <3",
    "sdk": "^3.0.0",
    "protocol": "^2.0.0"
  }
}
```

## Permissions

The `permissions` array is the legacy flat list from SDK v2. New manifests
should declare scoped capabilities instead through
`requiredCapabilities` and `optionalCapabilities`:

```json
{
  "requiredCapabilities": [
    { "name": "chat.read" },
    { "name": "network", "scope": "api.example.com" }
  ],
  "optionalCapabilities": [{ "name": "lorebook.read" }]
}
```

`requiredCapabilities` are capabilities the plugin cannot work without;
`optionalCapabilities` are ones it can degrade without. The user confirms
every requested capability at install time. Adding new permissions in an
update requires re-consent — see [Permissions](permissions.md).

## Legacy Entry Points

```json
{
  "legacy": {
    "frontend": "legacy/main-window.js",
    "backend": "legacy/server.mjs"
  }
}
```

The `legacy` block points at trusted compatibility entries for existing
SillyTavern extensions. Packages using either entry must request the
`legacy.trusted` permission, and the UI shows a stronger warning during
consent. Safe mode never loads legacy entry points. See
[Sandboxing](sandboxing.md) for how this differs from native plugins.

## OAuth Clients

Plugins that connect to an external service can declare public OAuth 2.0
clients using authorization-code flow with PKCE:

```json
{
  "authClients": [
    {
      "serviceId": "com.example.idp",
      "name": "Example IdP",
      "authorizationUrl": "https://idp.example.com/oauth/authorize",
      "tokenUrl": "https://idp.example.com/oauth/token",
      "clientId": "neotavern-author.plugin-name",
      "scopes": ["profile.read"]
    }
  ]
}
```

Only public clients are allowed: `clientSecret` is forbidden because plugin
code runs in a sandbox. Endpoints must be HTTPS, with a plain-HTTP loopback
exception for local identity providers during development. Changing a
descriptor requires reinstalling the package.

## Worker and Signing Fields

Advanced manifests can declare additional modules:

- **`workers`** — package-relative entry modules the plugin may spawn as
  isolated compute workers. Spawning an undeclared entry is rejected.
- **`publisher`** and **`signature`** — package signing. `keyId` is the
  `ed25519:<hex>` fingerprint of the signing public key, and `signature` is
  the base64 Ed25519 signature over the canonical manifest. These are set by
  the plugin build tool, never hand-written.

The `validateManifest` function in the SDK checks every field, and the
generated [Plugin SDK reference](../../api/plugin-sdk/) documents the exact
`PluginManifest` type.
