---
title: Plugin Permissions
description: How permissions are declared and granted, and when an update requires re-consent.
sidebar_position: 3
---

Permissions are the mechanism that lets users decide what a plugin may do,
from reading chat history to making network requests.

## The Permission Model

A permission is a string that names a capability. Declaring one in the
manifest is a request, not automatic access: the user must confirm every
requested permission before the plugin becomes active, and the host enforces
the grant at every point of use.

The built-in set is a stable, versioned contract:

| Permission           | What it grants                                                |
| -------------------- | ------------------------------------------------------------- |
| `chat.read`          | Read chat messages and their metadata                         |
| `chat.write`         | Create or modify chat messages                                |
| `characters.read`    | Read characters and character cards                           |
| `characters.write`   | Create or modify characters                                   |
| `lorebook.read`      | Read lorebook entries                                         |
| `lorebook.write`     | Create or modify lorebook entries                             |
| `prompt.inspect`     | Inspect the assembled prompt                                  |
| `prompt.modify`      | Modify the prompt or post-process generation output           |
| `providers.register` | Register provider adapters and tokenizers                     |
| `ui.toolbar`         | Add toolbar actions                                           |
| `ui.sidebar`         | Add sidebar panels                                            |
| `ui.messageActions`  | Add message actions                                           |
| `ui.shell`           | Add content to shell slots                                    |
| `clipboard.read`     | Read the clipboard                                            |
| `clipboard.write`    | Write to the clipboard                                        |
| `notifications`      | Show notifications                                            |
| `server.routes`      | Mount backend routes                                          |
| `legacy.trusted`     | Run documented SillyTavern legacy code in the trusted context |

## Scoped Permissions

Some permissions carry a scope, written as `kind:scope`:

- **`network:<hostname>`** — permission to fetch from a specific host, for
  example `network:api.example.com`. Requests to hosts that are not granted
  are rejected.
- **`network:*`** — a wildcard that allows fetching from any host. The host
  treats it as full network access and the consent UI shows it with an
  enhanced warning. Prefer listing concrete hosts; publishing plugins that
  request the wildcard is discouraged.
- **`files:plugin`** — read and write inside the plugin's own data directory.
- **`files:user-selected`** — access to files the user explicitly selected.

`hasPermission` checks a granted set against a required permission, and
`parsePermission` splits a `kind:scope` string into its parts. The
`validatePermissions` function rejects malformed strings such as empty,
duplicate, or unknown permissions.

## How Grants Are Enforced

Declaring a permission is not enough; the host applies the grant at the
enforcement point:

- UI registrations check `ui.*` permissions before mounting.
- Routes check `server.routes`.
- The permission-checked `fetch` checks `network:<host>`.
- The virtual filesystem checks `files:*`.
- Provider and context APIs check `providers.register` and `prompt.modify`.

The capability kernel (`kernel` namespace of `@neotavern/plugin-sdk`) is the shared
layer that checks grants in both the web host and the server, so the browser
and the backend always see the same effective rights. Grants are stored with
a monotonic revision, delivered to the sandbox during the bootstrap handshake,
and revocable at runtime. In-flight operations complete with a
`CAPABILITY_REVOKED` error and open handles are closed by the host.

## Consent and Re-Consent on Update

Installation shows the full list of requested permissions. The plugin stays in
a `needs-consent` state until you confirm every permission, and the UI shows
the dependency list when the package ships npm dependencies.

Updating a plugin is a new install for the permission check: the host computes
the difference between the previous and the new manifest with
`diffPermissions`. If the update adds permissions:

- the plugin's runtime is disabled immediately;
- the user is asked to consent to the new permissions;
- the plugin stays disabled until consent is given.

Removing permissions never requires consent. The general rule: the set of
granted permissions never grows without an explicit user decision. For the
full list of permission constants and helpers, see the generated
[Plugin SDK reference](../../api/plugin-sdk/).
