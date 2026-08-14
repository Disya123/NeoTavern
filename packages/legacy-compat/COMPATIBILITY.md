# Legacy Compatibility Authority Mapping (ARC-11)

Part of [ADR-0039](docs/adr/0039-legacy-compatibility-authority-boundary.md).
This manifest is the per-legacy-API authority map required by ТЗ §14.2 and
ADR-0039: every public legacy surface is translated or restricted, never
granted more authority than the corresponding native capability.

**Invariant (ARC-11, enforced by `apps/server/test/legacyAuthority.spec.ts`):**

> A legacy call must never reach canonical SQL, the SecretStore, kernel
> internals, another plugin's data, or a hidden `legacy.superuser`-style
> capability — even under a high-risk consent.

**Unconditional prohibitions (ТЗ §14.2.2 — user consent cannot lift them):**

- canonical `database.sqlite` / `app.db`, WAL/SHM and any storage connection;
- `SecretStore` and its backing files/vault APIs;
- kernel internals, repositories and in-process memory;
- another plugin's data;
- any hidden `legacy.superuser`-style capability;
- bypassing Product Wire to mutate product data.

Compatibility tiers (ТЗ §14.2.1): **Native compatible** — translated into
ordinary Product Wire/capability calls (fully supported); **Sandbox
compatible** — isolated, sees only the broker, scoped VFS and granted
capabilities (supported with limitations); **Architecturally incompatible** —
raw canonical SQL, kernel internals, unrestricted secrets, hidden superuser or
a single-writer violation (unsupported by design).

## Legacy API map

### 1. `window.SillyTavern.getContext()` — frontend

| Field                        | Value                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Supported contract           | `getContext()` → characters, active chat/character, `sendChatMessage()`, request headers, extension settings               |
| Mapping to native capability | `chat.send` (Product Wire `chats` operations) for `sendChatMessage()`; settings via `extension_settings` (entry 3)         |
| Host availability            | Desktop, Headless/Web Client (browser shell)                                                                               |
| Sandbox / isolation          | Main-window unmanaged island — requires the `legacy.trusted` manifest permission + explicit consent; disabled in safe mode |
| Compatibility test           | `packages/legacy-compat/test/globals.test.ts`, `packages/legacy-compat/test/registry.test.ts`                              |
| Security / resource limits   | No direct API (`/api/v2`) fetch helpers; no SQL; no secret access; settings writes go through the namespaced route         |
| Support / versioning         | `ST Compatibility API v1`; breaking changes require a migration guide + compatibility test                                 |

### 2. `window.eventSource` / `window.event_types` — frontend event bus

| Field                        | Value                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Supported contract           | `eventSource.on/off/emit`, `event_types` constants                                                         |
| Mapping to native capability | Legacy event bus bridged to the SDK event channel; core events (`chat.created`, …) are delivered read-only |
| Host availability            | Desktop, Headless/Web Client                                                                               |
| Sandbox / isolation          | Main-window legacy surface (`legacy.trusted` gate)                                                         |
| Compatibility test           | `packages/legacy-compat/test/legacy.test.ts`                                                               |
| Security / resource limits   | Event payloads only; no product mutation surface                                                           |
| Support / versioning         | `ST Compatibility API v1`                                                                                  |

### 3. `window.extension_settings` — frontend, backed by `/api/v2/legacy/extension-settings`

| Field                        | Value                                                                                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supported contract           | Per-plugin settings object, persisted across reloads                                                                                                                                                                   |
| Mapping to native capability | `storage.user`-scoped plugin state, namespaced by the installed plugin id (`plugin_storage`, key `legacy.extension-settings`)                                                                                          |
| Host availability            | Desktop, Headless/Web Client                                                                                                                                                                                           |
| Sandbox / isolation          | Namespace enforced server-side: the route only accepts an **installed** plugin id (`PLUGIN_NOT_FOUND` otherwise) and stores rows keyed by `(plugin_id, key)` — one plugin can never read or clobber another's settings |
| Compatibility test           | `apps/server/test/legacy-host.spec.ts`, `apps/server/test/legacyAuthority.spec.ts`                                                                                                                                     |
| Security / resource limits   | ≤ 1 MiB per namespace (`FILE_TOO_LARGE`); JSON-valued; never carries secrets                                                                                                                                           |
| Support / versioning         | `ST Compatibility API v1`                                                                                                                                                                                              |

### 4. `window.$` / `window.jQuery` — jQuery for legacy islands

| Field                        | Value                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| Supported contract           | jQuery scoped to the legacy island DOM (settings, actions, toolbar, drawer, modal)                   |
| Mapping to native capability | DOM islands are host-managed containers; jQuery is a pure DOM utility with no API/SQL/secrets access |
| Host availability            | Desktop, Headless/Web Client                                                                         |
| Sandbox / isolation          | Unmanaged island — `legacy.trusted` + consent; safe mode disables                                    |
| Compatibility test           | `packages/legacy-compat/test/registry.test.ts`                                                       |
| Security / resource limits   | No network, filesystem or process access beyond the browser page itself                              |
| Support / versioning         | `ST Compatibility API v1`                                                                            |

### 5. Legacy DOM islands (`legacy.chat.actions`, `legacy.toolbar`, drawer, modal)

| Field                        | Value                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| Supported contract           | Append/remove content in host-managed island containers                                  |
| Mapping to native capability | This is the documented **legacy frontend unmanaged island** high-risk grant (ТЗ §14.2.3) |
| Host availability            | Desktop, Headless/Web Client                                                             |
| Sandbox / isolation          | Unmanaged by definition — `legacy.trusted` + explicit consent, disabled in safe mode     |
| Compatibility test           | `packages/legacy-compat/test/registry.test.ts`, frontend E2E                             |
| Security / resource limits   | The island never receives canonical SQL, SecretStore or product-data mutation surfaces   |
| Support / versioning         | `ST Compatibility API v1`                                                                |

### 6. Express server host — `/api/plugins/{id}/...` (`legacy.backend`)

| Field                        | Value                                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supported contract           | `info` / `init(router)` / `exit()` on an Express router; routes served under the plugin's own mount prefix                                                                                                                                        |
| Mapping to native capability | The mount is the only reachable surface; routes map to `server.routes`-style plugin routes                                                                                                                                                        |
| Host availability            | Desktop, Headless (server process)                                                                                                                                                                                                                |
| Sandbox / isolation          | In-process legacy module — requires `legacy.trusted` manifest permission + explicit consent (the documented legacy backend exception); disabled in safe mode                                                                                      |
| Compatibility test           | `apps/server/test/legacy-host.spec.ts`, `apps/server/test/legacyAuthority.spec.ts`                                                                                                                                                                |
| Security / resource limits   | Route URLs are confined to `/api/plugins/{id}/...` (core `/api/v2` can never be shadowed); 30 s handler timeout; sync/async failures are contained as error envelopes; handlers get no database, SecretStore or Product Wire access from the host |
| Support / versioning         | `ST Compatibility API v1`                                                                                                                                                                                                                         |

### 7. Legacy filesystem API — `/data/extensions/<plugin-id>/...` → scoped VFS

| Field                        | Value                                                                                                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supported contract           | Plugin-relative file paths (`cache.json`, …)                                                                                                                                                                                                                                           |
| Mapping to native capability | `files.plugin` capability → scoped VFS root `<data-root>/plugins/<plugin-id>/data/` (host adapter detail; the physical layout is not part of the public contract)                                                                                                                      |
| Host availability            | Desktop, Headless (server process), Web Client (via backend)                                                                                                                                                                                                                           |
| Sandbox / isolation          | Namespace isolation: the root is a strict descendant of `<data-root>/plugins/`; canonical DB (`app.db` / `database.sqlite`), WAL/SHM, `secrets.enc`, other plugins' roots and user home are **outside** the namespace                                                                  |
| Compatibility test           | `apps/plugin-runtime/src/host/memoryHost.test.ts` (executor level: traversal, symlink escape, size bound, cross-plugin isolation, grant gating); `apps/server/test/legacyAuthority.spec.ts` (server wiring level)                                                                      |
| Security / resource limits   | Lexical containment + real-path (symlink) containment; `../` and backslash escapes rejected (`VALIDATION_FAILED`); per-file size bound (`FILE_TOO_LARGE`); atomic writes (temp + rename); `files.list` filters symlinks; `files.plugin` grant required (`CAPABILITY_DENIED` otherwise) |
| Support / versioning         | `ST Compatibility API v1`                                                                                                                                                                                                                                                              |

## Architecturally incompatible (unsupported by design)

Extensions requiring raw canonical SQL, unrestricted processes, unrestricted
secret access, a hidden superuser capability or a Product Wire bypass are
**unsupported** (ТЗ §14.2.1). This is a deliberate architectural limitation of
NeoTavern's trust boundaries, not a Kernel defect. Adding such a path to the
legacy layer is forbidden; a needed capability must be added to the public
Plugin SDK through an ADR/security review.

## Support matrix per release

Each release publishes the exact `fully supported`, `supported with
limitations` and `unsupported` legacy contracts/plugins. The list above is the
current baseline; changes to any entry require updating this manifest, its
enforcement tests and the ADR-0039 conformance suite in the same change.
