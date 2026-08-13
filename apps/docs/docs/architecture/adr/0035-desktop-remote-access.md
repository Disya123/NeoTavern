---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0035-desktop-remote-access.md
---

# ADR-0035: Desktop Remote Access — host service over the shared Runtime Kernel

Date: 2026-08-13. Status: Accepted (Phase 9).
Related documents: [Desktop](../desktop/README.md),
[Architecture](../architecture/README.md), [Wire contracts](../architecture/wire-contracts.md),
[Version axes](../architecture/version-axes.md),
[ADR-0029](0029-wire-contract-toolchain.md), [ADR-0030](0030-remote-http-adapter.md),
[ADR-0033](0033-desktop-local-kernel-transport.md), [ADR-0034](0034-android-local-host-jni-transport.md),
ТЗ §10, §11.2, §18.4, §78 Фаза 9.

## Context

ТЗ §11.2 requires the Desktop to expose an optional Remote Access service
over the **same** Runtime Kernel instance that already serves local IPC
(Phase 3 kernel mode, ADR-0033); §10 fixes the remote-access security rules
(loopback default, explicit remote opt-in, non-loopback only behind a
TLS-terminating trusted proxy with auth); §18.4 requires pairing/revocation
UX. Phase 4 delivered the headless surface (`crates/adapters/remote-http`,
ADR-0030) and the hardening is complete: pairing issues revocable scoped
credentials (SHA-256 verifier only, token-bucket rate limiting, `max_streams`
caps, per-frame-batch credential re-check), the auth gate runs before the
body is read, CORS is deny-by-default via `allowed_origins`, and every gate
decision lands in a bounded secret-free audit ring. What Phase 4 did not
deliver is a **host**: nobody owns the configuration file, the lifecycle or
the command surface that lets the desktop shell switch the service on, pair
and revoke.

Before this ADR the desktop exposes the kernel only over in-process Tauri
IPC (`kernel_dispatch` / `kernel_stream_start` / `kernel_stream_abort`);
there is no way to start a remote listener from the shell. The Phase 4
adapter is a library — `RemoteAdapter::start(Arc<Mutex<Kernel>>, config)` —
so the desktop needs a thin host service that owns the configuration, the
adapter instance and the command surface while staying strictly on the
frozen wire registry: no new product operations, no contract change.

## Decision

- **A new host service crate `neotavern-desktop-remote`**
  (`crates/adapters/desktop-remote`) wraps the Phase 4 remote-http adapter on
  the **same `Arc<Mutex<Kernel>>`** the shell already owns — one writer
  coordinator for local IPC and remote clients (§22), no second process, no
  separate data-root access. `RemoteAccessService` holds interior `Mutex`
  state (config, adapter handle, status) and exposes
  `new`/`config`/`set_config`/`persist`/`status`/`start`/`stop`/`pair`/
  `revoke`.
- **Off by default — no listener.** The service is never started at boot; a
  listener exists only after the user explicitly enables Remote Access in
  the Settings panel (§10: remote access is an explicit opt-in). `status`
  reports `running: false` until then.
- **Loopback default + ephemeral port.** The default config binds
  `127.0.0.1` on port `0` (OS-assigned ephemeral port). A non-loopback bind
  is a pre-bind validation error unless BOTH `trusted_proxy: true` (a
  TLS-terminating boundary in front of the service) and `auth_enabled: true`
  are set — mapped to `InsecureBind` / `PublicBindRequiresAuth` exactly like
  the adapter, so the service fails closed before any socket is opened.
- **Pairing with revocable in-memory credentials.** `pair` asks the adapter
  for `(id, token)`; the service stores only the SHA-256 verifier in the
  adapter's in-memory store, the token is shown once to the user and never
  logged or persisted in plaintext. `revoke(id)` invalidates immediately
  (live streams re-check per frame batch). Credentials are **not durable
  across restarts**: re-pairing after an app restart is required. Durable
  credential persistence is deferred and documented as a known limitation
  (see Consequences) — secrets never enter the product database.
- **CORS deny-by-default.** Browser remote clients must be listed in
  `allowed_origins` (exact match); anything else is rejected before dispatch
  (403 `ORIGIN_NOT_ALLOWED`). Non-browser clients (curl, SDKs) are unaffected.
- **Bounded audit.** The service exposes the adapter's bounded audit ring
  (start/stop, pair/revoke, gate decisions) without token material for the
  Settings UI.
- **`kernel_remote_*` Tauri commands — host service, not product wire.** The
  desktop shell registers `kernel_remote_status`, `kernel_remote_config`,
  `kernel_remote_start`, `kernel_remote_stop`, `kernel_remote_pair`,
  `kernel_remote_revoke` in `neotavern-tauri-local` behind the `remote`
  feature. These are **host-service controls**, not product wire operations:
  the frozen registry and `schemaHash` (ADR-0029) are unchanged — no codegen
  impact, no contract/registry change. Errors follow the established
  `Result<T, String>` convention with stable machine-readable codes
  (`REMOTE_INSECURE_BIND`, `REMOTE_PUBLIC_BIND_REQUIRES_AUTH`,
  `REMOTE_AUTH_DISABLED`, `REMOTE_NOT_RUNNING`, `REMOTE_MUST_STOP_FIRST`,
  `REMOTE_START_FAILED`, `REMOTE_IO`, `REMOTE_INTERNAL`) that the UI maps to
  i18n text.
- **Host-owned config file.** The service persists `remote-access.json`
  under the platform `app_config_dir` (Tauri 2 `app.path().app_config_dir()`,
  `create_dir_all` on demand) — host-owned configuration, **not** product
  data: it never enters the SQLite data root, snapshots, backups or exports.
  Writes are atomic (temp file + rename). `set_config` while the service is
  running answers `MustStopFirst` — configuration changes require a
  stop/start cycle.
- **Feature-gated and tested in CI.** The `remote` feature on
  `neotavern-tauri-local` wires the service into the shell; CI compiles and
  lints it explicitly (`cargo test -p neotavern-tauri-local --features remote`
  + clippy) because the default workspace build does not enable the feature.

## Alternatives

- **Persist credentials in the kernel DB.** Storing pairing verifiers (or
  worse, tokens) in the product SQLite data root would put secrets into
  snapshots, backups and exports — exactly what §10 forbids. Rejected:
  credentials live in the adapter's in-memory verifier store; durable
  credential storage, when it lands, must be a host-owned secret store
  (platform-keychain class of solution), never the product DB.
- **New product wire operations `remote.*`.** Extending the frozen registry
  (ADR-0029) with `remote.start` / `remote.pair` / … would change the schema
  hash, force codegen churn across all transports, and grant remote clients
  a surface that is host configuration rather than product semantics.
  Rejected: the host service is controlled only via Tauri IPC from the
  desktop shell; the wire registry stays frozen.
- **Reuse the legacy Node sidecar remote mode.** The Fastify server's
  `NEOTA_REMOTE_ACCESS` path runs in a **separate process** and would become
  a second writer on the data root, breaking the single-writer invariant
  (§22) and re-introducing the legacy session/CSRF stack (ADR-0005).
  Rejected: the desktop Remote Access service runs in-process on the same
  `Arc<Mutex<Kernel>>` as local IPC. The legacy remote mode remains
  available only for the legacy sidecar (unmigrated routes).

## Consequences

- **Non-loopback requires a TLS-terminating proxy.** The service itself is
  plain HTTP; a public bind must be fronted by a trusted proxy that
  terminates TLS (declared via `trusted_proxy: true`). Configuring and
  operating that proxy is out of scope for the app.
- **Browser remote clients need an origin allowlist.** Any browser-based
  remote client must be added to `allowed_origins` (exact match); clients on
  other origins are denied by default.
- **Re-pair after every app restart.** In-memory verifiers do not survive a
  restart; pairing credentials must be re-issued. Documented in the Settings
  UI and the desktop README. Durable, host-owned credential persistence is a
  deferred follow-up.
- **Remote UI is gated to the desktop shell.** The Remote Access settings
  surface exists in the web Settings panel only when running inside the
  Tauri shell (`isTauriRuntime()`); a plain browser session cannot start,
  stop or pair the desktop service.
- **No contract/registry impact.** All remote operations are the frozen wire
  operations through `remote-http`; the `kernel_remote_*` commands are host
  controls only.
