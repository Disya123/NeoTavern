# @neotavern/desktop

Tauri 2 desktop shell for NeoTavern.

**Backend mode (honest staged default, ADR-0038):** which backend the shell
starts is decided by `desktop_mode()` in `src-tauri/src/lib.rs`. **Public
release builds default to the tested legacy Node sidecar** while the Rust
Kernel is an explicit Preview; nightly/internal and debug/dev builds default
to the Kernel. Explicit runtime overrides always win: `NEOTA_LEGACY_SERVER=1`
forces the sidecar, `NEOTA_KERNEL=1` forces the Kernel; **when both are set,
`NEOTA_KERNEL=1` wins** (conflict policy, ADR-0038 — the matrix is
unit-tested). The public default switches to the Kernel only after the
release gate (all mandatory Desktop capabilities `Packaged`, migration +
rollback verified on packaged artifacts, no silent fallbacks, no open P0).

**Kernel mode (`NEOTA_KERNEL=1`, nightly/debug default):** the Runtime Kernel
is embedded in the desktop process (`neotavern-tauri-local`), the window loads
the bundled web assets over `tauri://localhost`, and there is **no HTTP
server, no listening port and no server lifecycle** (ТЗ §11.1). The UI talks
to the kernel through `React → LocalBackend → Tauri IPC → Runtime Kernel`
(`kernel_dispatch` / `kernel_stream_start` / `kernel_stream_abort` commands,
registered only in kernel mode). The DiagnosticsPanel marks this backend as
**Kernel Preview** (ADR-0038).

**Sidecar mode (`NEOTA_LEGACY_SERVER=1`, public release default):** spawns the
self-contained Node.js 24 sidecar (`neotavern-server`) and opens the webview
only after the local API is ready. This is the temporary transition mode for
unmigrated routes (message edit/delete, chat create, import/export, plugin
runtime); it is removed as Phase 3/4 slices cut over. Only one mode runs at a
time, so a data root never has two writable owners.

## Public entry points

- `src-tauri/src/main.rs` — window and kernel/sidecar lifecycle;
- `src-tauri/tauri.conf.json` — bundle/installers/resources, `devUrl`;
- `crates/adapters/tauri-local` — kernel host, envelope dispatch, stream
  poller and abort commands (workspace crate, `tauri` feature);
- `crates/adapters/envelope` — shared wire envelope layer (CLI/HTTP/Tauri
  answer byte-identical envelopes, §6.3);
- `apps/web/src/api/tauriTransport.ts` — `LocalTransport` over Tauri IPC;
- `scripts/build-desktop-release.mjs` — ephemeral signed updater configuration;
- `.github/workflows/desktop-release.yml` — native Windows/macOS/Linux gates;
- `scripts/prepare-desktop.mjs` — builds web and sidecar for the target triple.

## Dependencies

- Tauri 2, `tauri-plugin-shell` and `tauri-plugin-updater`;
- Runtime Kernel + storage + shared envelope (workspace crates);
- built `apps/server` (legacy bridge only) and `apps/web`;
- `@yao-pkg/pkg` for the self-contained Node 24 binary (legacy bridge only).

## Commands

```bash
pnpm desktop:prepare
pnpm desktop:smoke
pnpm desktop:dev
pnpm desktop:build
pnpm desktop:portable
pnpm desktop:bundle:smoke
pnpm desktop:release
```

Building requires Rust stable MSVC, Windows C++ Build Tools and WebView2.
Users of a finished installer/portable build need none of these tools.
`src-tauri/tauri.bundle-only.conf.json` is used only to re-bundle already
prepared resources, for example when debugging the MSI.

`desktop:smoke` runs the prepared self-contained sidecar without a GUI and
verifies the real Node 24 executable, SQLite, Sharp PNG→WebP, the packaged SPA,
diagnostics and the absence of leftover processes. `desktop:portable`
additionally builds NSIS/MSI, creates the Windows portable ZIP and `.sha256`,
then runs a headless Tauri shell-smoke (`NEOTA_DESKTOP_SMOKE=1` — kernel mode
self-checks the packaged kernel: handshake + `meta.get` + `characters.list` +
`backups.list`, then exits deterministically). `desktop:bundle:smoke` runs the
`.app` or AppImage in headless smoke mode on the target runner.
`desktop:release` requires the endpoint, the public signing key and the
private release key, then produces the Tauri updater artifact and `.sig`.

The portable ZIP contains `portable.flag`; only in this variant is data created
in `data/` next to the app. Installed NSIS/MSI builds have no marker and use
the platform app-local-data directory. Moving a single exe without `resources/`
is not supported.

## Limitations

- Build the installer on the target OS/architecture because of native addons
  (`better-sqlite3`, `sharp` — legacy bridge only).
- In legacy mode the sidecar listens only on a random free port on `127.0.0.1`.
- User data is stored in the platform app-local-data directory, not inside the
  bundle. The portable build stores it in the local `data/` folder next to the
  app.
- Kernel mode serves only the frozen product-wire surface: unmigrated legacy
  routes fail with a typed `UnsupportedError` until the wire registry grows
  (`docs/architecture/operations-inventory.md` routing table).
