# Desktop and Web Client

## Desktop (Tauri 2.x)

### Backend mode selection (honest staged default)

The Runtime Kernel (`crates/runtime-kernel`) is the canonical backend; the
legacy Fastify backend runs only as the bundled Node.js sidecar while
unmigrated features still need it. Which backend the shell starts is decided
by `desktop_mode()` in `apps/desktop/src-tauri/src/lib.rs` (ADR-0038 "Honest
Desktop default", AGENTS.md §21):

| Build channel                                                              | Default mode   |
| -------------------------------------------------------------------------- | -------------- |
| Public release (`NEOTA_DESKTOP_CHANNEL=release`, set by `desktop:release`) | Legacy sidecar |
| Nightly/internal (`NEOTA_DESKTOP_CHANNEL=nightly`)                         | Kernel         |
| Debug/dev builds (`cfg!(debug_assertions)`)                                | Kernel         |

Explicit runtime overrides always win: `NEOTA_LEGACY_SERVER=1` forces the
sidecar; `NEOTA_KERNEL=1` forces the Kernel (Preview opt-in). **Conflict
policy (ADR-0038):** when both overrides are set, `NEOTA_KERNEL=1` wins —
the Kernel is the canonical plane and the direction of travel — and the shell
prints a warning to stderr. The full mode matrix is unit-tested in
`apps/desktop/src-tauri/src/lib.rs` (`resolve_desktop_mode`). The public
default switches to the Kernel only after the release gate: all mandatory
Desktop capabilities are `Packaged` in the capability matrix, migration and
rollback are verified on packaged artifacts, no silent fallbacks exist and no
P0 defects are open.

The DiagnosticsPanel marks the Kernel as an explicit **Kernel Preview** (with
a note on the release gate) whenever the Kernel is the active backend —
release builds on the sidecar show no kernel marking.

### Phase 3 local kernel mode

- The Runtime Kernel (`crates/runtime-kernel`) is embedded in the Tauri
  process; the window loads the bundled web assets over `tauri://localhost`.
- The UI talks to the kernel through Tauri IPC commands
  (`kernel_dispatch`, `kernel_stream_start`, `kernel_stream_abort` from
  `crates/adapters/tauri-local`): `React → LocalBackend → Tauri IPC →
Runtime Kernel → SQLite` (ТЗ §11.1/§15.1).
- **No HTTP server, no listening port, no network auth, no server lifecycle**
  when Remote Access is off.
- Contract handshake: `KernelHost::open` requires the exact embedded
  `schemaHash` and FFI ABI version (§6.5); a stale WebView bundle or native
  library is caught before any product write.
- Starter pack: kernel mode sets `NEOTA_SEED_STARTER=1` before open so the
  writer thread seeds Hazel + Vesper once per data root (see
  [Starter character pack](../data/README.md#starter-character-pack)).
- Streaming: the kernel's durable `generation.events` log is polled by a
  native worker and forwarded to the webview over a Tauri `Channel`; aborting
  the stream dispatches `generation.cancel` (durable, §63). The poller closes
  the consumer stream when the run's session ends — terminal OR durably
  `waiting_for_tool` (§8.3); a waiting run is followed via
  `generation.events` / `generation.get`.
- Tools: `KernelHost::register_tool` (the host seam for `Kernel::register_tool`,
  Этап 2.7) validates the `wire.tool.spec` by deserialization; tool execution
  stays kernel-side orchestrated (wait → host effect → `generation.tool.result`).
- **Packaged golden slice** (Этап 2.9): `NEOTA_DESKTOP_SMOKE=1` runs the full
  user flow headless on the packaged shell — handshake, character → chat →
  user message, `generation.start` (deterministic fake) → durable assistant
  message, then a complete tool round trip (register → `waiting_for_tool` →
  `generation.tools.list` → `generation.tool.result` → completed, a second
  assistant message). No HTTP, no sidecar, no UI: the packaged host's own
  self-check, exits 0 only when every step and assertion holds.

### Legacy sidecar mode

- The Fastify backend runs as a bundled Node.js sidecar (`neotavern-server`).
- Node.js and SQLite are included in the distribution; first launch needs no `npm install`.
- The user needs no terminal, Git, npm, or database setup.
- Targets: Windows installer + portable, macOS package, Linux AppImage/archive.
- Window close properly stops the sidecar; the backend does not linger after
  the app is closed.

> Status: Windows x64 pre-release verified locally. For macOS and Linux a
> mandatory native build/smoke gate is added in
> `.github/workflows/desktop-release.yml`: the bundle is launched with
> `NEOTA_DESKTOP_SMOKE=1`, waits for sidecar readiness (sidecar mode) or runs
> the kernel self-check (kernel mode: handshake + `meta.get` +
> `characters.list` + `backups.list` + the golden slice above), checks SQLite
> creation and the absence of orphan processes. Node.js, `better-sqlite3`,
> Sharp and production web assets are included in every sidecar-mode package;
> the first launch does not run `npm install`.

`tauri.conf.json` uses `bundle.targets: "all"`, so `pnpm desktop:build`
selects the native formats of the current OS. Native addons and the
self-contained sidecar are always prepared on the same target runner;
transferring built assets between OSes is not supported.

### Remote Access (Phase 9, optional)

Remote Access lets another device or browser reach the **same embedded
Runtime Kernel** over HTTP (envelope-over-HTTP, ADR-0030/ADR-0035). It is
**off by default — no listener exists until you enable it**.

- **Enabling.** In the desktop shell open Settings → Remote Access and
  switch the service on (this surface exists only inside the desktop shell;
  a plain browser cannot control it). The default binds `127.0.0.1` with an
  OS-assigned ephemeral port — use it from the same machine. The running
  address is shown in the panel.
- **Pairing.** Click _Pair_ — the service issues a scoped credential
  `(id, token)` and the token is shown **once**. Copy it to the remote
  client (curl `Authorization: Bearer <token>`, or the app's remote
  profile). Credentials are held in memory (SHA-256 verifier only) and are
  revocable.
- **Revoking.** _Revoke_ invalidates a credential immediately — active
  streams re-check per frame batch and abort. The panel's audit log shows
  start/stop and pair/revoke events (no token material).
- **Restart note.** In-memory credentials do not survive an app restart —
  re-pair after restart. Durable, host-owned credential persistence is a
  documented follow-up; secrets never enter the product database.
- **Security posture.** Loopback by default; a non-loopback bind requires
  **both** `trusted_proxy: true` (a TLS-terminating proxy in front) and auth
  enabled — otherwise the service refuses to start
  (`REMOTE_INSECURE_BIND` / `REMOTE_PUBLIC_BIND_REQUIRES_AUTH`). CORS is
  deny-by-default: browser clients must be listed in `allowed_origins`
  (exact match). Tokens are never logged or stored in plaintext; the auth
  gate runs before the request body is read; token-bucket rate limiting and
  a bounded stream cap protect the kernel.
- **Config file.** Settings are saved host-owned at
  `app_config_dir/remote-access.json` (Tauri 2 `app.path().app_config_dir()`,
  created on demand, atomic write) — never inside the product data root, so
  snapshots/backups/exports stay free of remote-access configuration.
  Changing configuration while the service is running requires stopping it
  first.
- **What is NOT included.** The service is plain HTTP — for non-loopback
  use TLS is terminated at your trusted proxy; the app does not manage
  certificates. Credentials are not durable across restarts (re-pair). The
  enable/pair/revoke UI exists only inside the desktop shell.
- **Relationship to the legacy server remote mode.** The legacy Fastify
  sidecar's `NEOTA_REMOTE_ACCESS` mode (session + CSRF, ADR-0005) is a
  separate, process-level remote path for the unmigrated sidecar — not this
  service. Desktop Remote Access runs **in-process** on the same kernel as
  local IPC (one writer, §22). See
  [ADR-0035](../adr/0035-desktop-remote-access.md).

### Windows build and checks

```bash
pnpm desktop:prepare
pnpm desktop:smoke
pnpm desktop:build
pnpm desktop:portable
```

`desktop:prepare` builds server/web, copies target-specific native addons, and
creates the sidecar with the Tauri target-triple suffix. `desktop:smoke`
verifies the prepared executable, SQLite, Sharp, SPA, diagnostics, and process
shutdown. `desktop:portable` builds NSIS/MSI, the portable ZIP with a sibling
`.sha256`, and runs a headless Tauri shell-smoke.

Windows x64 additionally checks NSIS, MSI, portable ZIP/checksum, and the
portable shell lifecycle. The macOS `.app`/DMG and Linux AppImage are built and
pass `desktop:smoke` + `desktop:bundle:smoke` only on the corresponding
runners; transferring native artifacts between OSes does not count as a check.

Portable layout:

```text
NeoTavern.exe
neotavern-server.exe
portable.flag
resources/
README.txt
```

`portable.flag` switches the data root to the local `data/` folder. Without
the marker the installer uses the platform app-local-data. The shell normalizes
Windows resource paths without the `\\?\` verbatim prefix before passing them
to the packaged Node. An unexpected backend exit terminates the shell with an
error; a clean exit is marked separately and leaves no orphan sidecar.

## Headless host

The Headless server is a **transport adapter over the Kernel**, not a second
application core. `crates/adapters/remote-http` remains the library
(envelope-over-HTTP, ADR-0030). `crates/adapters/headless`
(`neotavern-headless`) is the composition root that operators actually run:

```text
neotavern-headless --root <data-root>
```

- **Loopback by default** (`127.0.0.1:8080`). A non-loopback bind is a
  startup error unless `--remote-exposure` (`NEOTA_REMOTE_EXPOSURE=1`) opts
  in; a public bind still requires `--auth` (`NEOTA_HEADLESS_AUTH=1`) —
  fail-closed before any listener exists (ТЗ §10 / §11.3.1).
- **Secret policy is explicit.** Default backend is read-only `env`
  (`NEOTA_SECRET_*`). `--secret-backend session|unavailable` selects the
  session-only or fail-closed stores. There is never a plaintext fallback
  (SEC-01). File/`secrets.enc` passphrase unlock on a daemon is a later
  slice.
- **Stdout** is a single `listening <ip:port>` line. The process waits for
  stdin EOF, then drains in-flight HTTP. Ctrl+C kills the process; durable
  generation runs recover on the next open.
- **TLS** is an operator/proxy concern in front of remote exposure
  (ADR-0030). This host speaks plaintext HTTP on the bound socket.
- Pairing tokens are printed once on stderr and never stored or logged as
  values (SHA-256 verifier only, same store as Desktop Remote Access).

The Web Client remains a remote-only client of this host (or of Desktop
Remote Access): without a connection it shows the offline/connection screen
and must not perform product mutations (ARC-12 / ADR-0043). Remote-flow E2E
against this binary is a later M6 slice.

See [the crate README](../../crates/adapters/headless/README.md).

## Android APK client

The canonical Android host is **not** a Tauri WebView pointed at a remote
Fastify server. It is the JNI local host in [`apps/android/`](../../apps/android):
the WebView loads **bundled** `apps/web` assets (`assets/web/index.html`) and
talks to the in-process Runtime Kernel over `window.__neotavernMobile`
([ADR-0034](../adr/0034-android-local-host-jni-transport.md)). There is no
Node.js and no listening HTTP port on the device.

See [Android](../android/README.md) and `apps/android/README.md`.

The previous Tauri Android / `mobile-connect` remote-connect APK path
(`pnpm desktop:android:*`, `tauri.android.conf.json`) is **removed** — it
conflicted with the JNI host (ТЗ §20 Этап 5 item 8). `#[cfg(mobile)]` stubs
in `apps/desktop/src-tauri/src/lib.rs` remain as compile-time no-ops if
someone invokes `tauri android` anyway; that is not a supported product.

Build the canonical APK (assemble is fail-closed without a web build):

```bash
pnpm --filter @neotavern/web build
cd apps/android
bash scripts/build-libs.sh
gradle :app:assembleDebug
```

CI (`android-build`) builds the web client, assembles the debug APK, and
refuses the job if the ZIP lacks `assets/web/index.html` (ТЗ §18.3).

## Web Client

- responsive layout (desktop/tablet/phone);
- connects to the local backend on a PC/home server (remote-only client, ARC-12);
- cached app shell; API and generation require a reachable backend — there is
  no standalone offline runtime and no browser-hosted Kernel;
- the service worker caches only the app shell and static assets (not API/SSE/secrets);
- hashed assets are `immutable`, the HTML shell is `no-cache`.

The implementation lives in `apps/web/public/sw.js` and uses a versioned cache.
Navigation is network-first with an offline fallback, static assets are
cache-first, and all `/api/` requests are explicitly excluded. The manifest and
192/512 icons ship with the production frontend. The behavior is verified by
Playwright in offline mode and by a Cache Storage content audit.

When the Web Client connects to a remote backend, access is closed behind a
separate login gate. The bootstrap token is exchanged for an HttpOnly/SameSite
session and is not stored in Web Storage; state-changing API requests use an
in-memory CSRF token. The production remote origin must be served over HTTPS.
See [ADR-0005](../adr/0005-remote-session-auth.md).

If the backend is unreachable during an offline reload, the login gate only
allows showing the cached shell with an explicit offline indicator. This does
not create a local authenticated session: API, SSE, and user responses are
still not cached and remain unavailable until the backend recovers.

## Updates

The core uses `tauri-plugin-updater`. The release build compiles the trusted
`NEOTA_UPDATE_ENDPOINT` and `NEOTA_UPDATE_PUBLIC_KEY`, and
`scripts/build-desktop-release.mjs` creates a temporary Tauri configuration
only for the duration of building signed artifacts and requires
`TAURI_SIGNING_PRIVATE_KEY`. The configuration and private key are not kept in
the source tree. Unsecured HTTP endpoints and empty keys are rejected. Shell
commands:

- `check_core_update` → `{ configured, currentVersion, availableVersion }`;
- `install_core_update` re-verifies the manifest and the minisign signature,
  installs the platform artifact, and restarts the shell;
- a build without endpoint/key stays functional but returns
  `configured: false` and cannot install a core update.

`pnpm desktop:release` produces signed platform artifacts. CI requires the
release secrets, runs the sidecar and shell smoke on Windows, macOS, and
Linux, and publishes only the produced bundle artifacts. The Tauri installer
replaces the core separately from the user data root; the migration runner
creates a backup before pending schema migrations. Core rollback is done by
publishing the previous verified code as a new signed release artifact —
unsigned downgrades are not allowed.

Plugins and themes update independently: the server validates the package,
unpacks it into a temporary directory, atomically swaps the installation
directory, and restores the previous version on an error before commit. User
files are not part of any executable update artifact.
