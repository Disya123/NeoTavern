# @neotavern/desktop

Tauri 2 desktop shell for NeoTavern.

**Backend mode (round 60a, ADR-0038):** the desktop shell runs the Rust Kernel,
always. There is no second backend and no mode switch: the Node/Fastify sidecar,
its `NEOTA_LEGACY_SERVER` override and the `NEOTA_KERNEL` opt-in were removed with
the legacy contour. `desktop_backend_mode` still answers `"kernel"` so the
DiagnosticsPanel never has to guess.

**Kernel plane:** the Runtime Kernel is embedded in the desktop process
(`neotavern-tauri-local`), the window loads the bundled web assets over
`tauri://localhost`, and there is **no HTTP server, no listening port and no
server lifecycle** (ТЗ §11.1). The UI talks to the kernel through
`React → LocalBackend → Tauri IPC → Runtime Kernel` (`kernel_dispatch` /
`kernel_stream_start` / `kernel_stream_abort`). Diagnostics no longer shows a
"Preview" marker: the kernel is the product.

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
