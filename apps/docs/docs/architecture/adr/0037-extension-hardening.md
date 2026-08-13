---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0037-extension-hardening.md
---

# ADR-0037: Extension hardening — declarative slots, legacy-frontend gate, theme fallback, engines enforcement, namespaced quotas + secrets

Date: 2026-08-13. Status: Accepted (Phase 10).
Related documents: [Plugin SDK](../plugin-sdk/README.md),
[Theme SDK](../theme-sdk/README.md), [Architecture](../architecture/README.md),
[ADR-0027](0027-plugin-node-universal-runtime.md), [ADR-0036](0036-android-background-execution.md),
ТЗ §10, §47–§54, §60–§61, §70, §76, §83, §86–§92.

## Context

Phases 3/4/5/9 built the host boundaries (desktop kernel IPC, headless
remote adapter, Android JNI host, desktop remote service) but extensions
still crossed them in ways ТЗ §10 forbids. The Phase 10 recon
(`agent://Phase10Recon`) found the extension surface already far along —
rev4 plugins run in SES/Compartment worker threads behind a capability
broker (ADR-0027), safe mode exists (`?safe=1` / `NEOTA_SAFE_MODE` /
`POST /api/v2/plugins/safe-mode`), manifests and packages are validated,
grants are persisted with CAS revision and revocation — yet these gaps
remained:

1. **No declarative semantic UI slots.** The five ТЗ slot ids
   (`chat.header.actions`, `chat.message.actions`,
   `character.editor.actions`, `settings.section`, `generation.controls`)
   existed only in the ТЗ; plugin UI contributions were imperative
   registrars with no slot/priority/permission model and no host-side
   escaping guarantee.
2. **Arbitrary third-party JS could still reach the main document.**
   Legacy SillyTavern frontend entrypoints (`/api/v2/plugins/:id/legacy.js`)
   are injected as `<script>` into the main window behind the per-plugin
   admin-only `legacy.trusted` consent — but nothing app-level gated that
   path, and `window.SillyTavern` globals are installed unconditionally.
3. **No theme fallback.** Activation was a DB flip; a broken active theme
   degraded to an **empty** boot, losing the previously working theme.
   No previous-major/activation-rollback guarantee (§83).
4. **No engine-range enforcement.** Manifest `engines` ranges were
   syntax-validated only; an incompatible plugin update was neither
   rejected nor auto-disabled (§76 exit gate "incompatible update
   откатывается/отключается").
5. **Namespaced state had no kv quota** (only blob caps), **no migration
   policy hooks**, **no place in backups/export**, and **no plugin
   SecretStore** — plugin secrets would have ended up in namespaced
   state and thus in backups, violating §54.
6. **No explicit extension-runtime availability** on hosts (Android
   `backgroundExecutionAvailable` existed from Phase 8; desktop kernel
   mode had no plugin surface reporting; §60/§92 require explicit
   unavailable).

## Decision

- **(a) Declarative semantic UI slots (ТЗ §53).** `SLOT_IDS` is a frozen
  set of the five ТЗ ids in `@neotavern/plugin-sdk`. A slot contribution
  is **plain data**: `{slot, title ≤80 chars no control chars, priority
(default 100, lower first), permission?, action {command|event}, when?}`.
  The sandbox channel serializes only serializable fields (`when` is a
  function and never crosses the boundary; the host re-runs its own gates).
  The web host re-validates every contribution at the untrusted boundary
  (`SlotRegistry`), filters by the granted `ui.slots` permission plus the
  contribution's optional v2 permission, skips `when() === false` (a
  throwing gate hides the contribution, never breaks the UI), sorts by
  priority (stable), and renders plain buttons via `SlotHost` — the plugin
  never provides markup, layout or React. Zero contributions or all denied
  → nothing renders (implicit fallback, no layout change). Slot ids beyond
  the five are rejected at SDK and host level.
- **(b) Legacy frontend gate (ТЗ §10/§87/§18).** New app-level setting
  `extensions.legacyFrontend` (boolean, default **false**, flat dotted
  settings key like `theme.settings.*`). A legacy frontend `<script>` is
  injected only when BOTH the app-level setting is on AND the plugin holds
  the admin-only `legacy.trusted` consent. The gate-off path logs exactly
  one warning per session and unloads already-injected scripts when the
  setting flips off. `window.SillyTavern`/`window.eventSource`/… remain
  installed as the documented legacy contract (§18) but are inert markers
  without legacy scripts. rev4 plugins continue to run exclusively in the
  sandboxed iframe (`allow-scripts`, Permissions-Policy `'none'`, own CSP).
- **(c) Theme activation rollback + boot fallback (ТЗ §48/§83).**
  Activation re-validates the target manifest and its `extends` graph
  **before** any state change; the currently working theme (id + stored
  settings) is snapshotted under `theme.lastWorking` and the flip happens
  only after. Boot resolves active → last-working → empty boot; safe mode
  always boots empty; an explicit reset drops the fallback so it is not
  resurrected. Themes gain an optional validated `responsive {density,
motion}` block applied as `data-theme-density`/`data-theme-motion`
  (defaults `comfortable`/`standard`); a failed web apply reverts to the
  last applied theme via a `THEME_APPLY_FAILED` event.
- **(d) Engines enforcement (ТЗ §76).** Manifest `engines` ranges resolve
  against four host axes — `neotavern` (app version), `host` (host
  handshake 2.0.0), `sdk` (`CURRENT_API_VERSION`), `protocol`
  (`PROTOCOL_VERSION`) — via the existing range checker. Install and
  activation reject mismatches with `ENGINE_MISMATCH` (422, params
  `{engine, required, host}`). An **incompatible update** of an enabled
  plugin deactivates its backends, marks the diagnostic, emits
  `plugin.disabled` and **keeps the previous version installed** — the
  plugin is disabled, not deleted (§76 rollback).
- **(e) Namespaced state quotas (ТЗ §54).** `PUT /state` enforces the SDK
  storage budget (`kvBytes` 1 MiB, `kvKeys` 4096 from
  `DEFAULT_PLUGIN_LIMITS.storage`) → 413 `STATE_QUOTA_EXCEEDED`
  `{limitBytes, limitKeys, keys, bytes}`. Existing rows are untouched;
  the quota applies per write.
- **(f) Plugin SecretStore (ТЗ §54).** New `plugin_secrets` table
  (migration 0022, STRICT, PK `(plugin_id, scope, key)`). Routes under
  `/api/v2/plugins/:id/secrets`: PUT is **write-only** (value never
  echoed), GET lists keys + masked previews, DELETE removes, `POST
/:key/reveal` returns plaintext only with the `secrets.reveal` grant
  AND the host exposure gate (`NEOTA_ALLOW_SECRETS_EXPOSURE`, default
  off) — mirroring the provider secrets pattern exactly. Capabilities:
  management = `secrets.manageOwn`. Secrets never enter state, backups,
  exports, logs or diagnostics (redaction tests).
- **(g) Plugin namespaces in backups (ТЗ §54).** Backups gain an
  **additive optional** sidecar `<id>.plugin-namespaces.json`
  (`{format, formatVersion:1, pluginNamespaces:[{pluginId, state:[…]}]}`)
  carrying namespaced **state only** (never secrets). Restore applies it
  with **conflict-skip** (existing rows win; the backup never clobbers).
  The reader is unknown-section-tolerant; the SQLite snapshot remains the
  primary artifact and sidecar failures do not fail the backup.
- **(h) Explicit runtime availability (ТЗ §60/§61/§92).** Android bridge
  gains `extensionsAvailability()` → frozen JSON
  `{"themes":true,"plugins":"declarative-only","nodeRuntime":false,
"arbitraryJsInWebView":false}` (declarative-only contribution policy,
  §51). Web gains `useExtensionAvailability()`: `nodeRuntime` is
  `unavailable` in desktop kernel mode (no plugin host by design) and
  `available` in server mode; the Plugins page shows the state. A CSP
  contract test pins the kernel-mode WebView CSP
  (`script-src 'self'` only — no `unsafe-eval`/`unsafe-inline`/remote
  origins; `object-src 'none'`; `frame-ancestors 'self'`).

## Alternatives considered

- **Move legacy frontend execution into the sandboxed iframe.** Rejected:
  SillyTavern legacy plugins fundamentally manipulate the main document
  through `window.SillyTavern` globals (documented contract §18); a
  sandboxed iframe cannot preserve that contract. The app-level gate +
  admin-only per-plugin consent is the honest boundary: the path is off
  by default and doubly consented.
- **Bump the backup container format.** Rejected: the existing backup is a
  SQLite-file artifact; a sidecar keeps the change additive and
  unknown-section-tolerant without breaking existing backups/restores.
- **Store plugin secrets in namespaced state with redaction on export.**
  Rejected: redaction of arbitrary JSON is error-prone; a dedicated
  write-only table + gated reveal is the same pattern the provider
  secrets already use.
- **Expose host capability strings to plugins.** Rejected: §17 forbids a
  generic capability registry; availability is per-feature typed probes.

## Consequences

- Real plugins can contribute to the five slots end-to-end (SDK → sandbox
  channel → host registry → `SlotHost`), with the permission/priority
  model enforced host-side and zero layout change when nothing renders.
- The main WebView no longer executes legacy third-party JS unless the
  user explicitly enables the app-level legacy gate AND the admin consents
  per plugin; the CSP contract test guards the kernel-mode window.
- A broken theme can no longer take the app to an empty boot when a
  previous working theme exists; activation is rollback-safe and
  re-validated.
- Incompatible plugins can no longer silently update into a broken state;
  they are rejected or auto-disabled with the previous version intact.
- Plugin namespaced state is quota-bounded, versioned, backup-included
  (secrets excluded) and secret-isolated via the scoped SecretStore.
- Hosts report extension availability explicitly; Android documents and
  enforces declarative-only contributions until an isolated runtime exists.
- Follow-up (deferred, §51/§52): a future portable plugin runtime and the
  migration-policy hooks for per-plugin `schema_version` are separate ADRs;
  the current phase pins the boundary, not the runtime.
