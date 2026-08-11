# @neotavern/desktop

Tauri 2 desktop shell for NeoTavern. Runs the Fastify backend as a
self-contained Node.js 24 sidecar and opens the webview only after the local
API is ready.

## Public entry points

- `src-tauri/src/main.rs` — sidecar and window lifecycle;
- `src-tauri/tauri.conf.json` — bundle/installers/resources;
- `scripts/build-desktop-release.mjs` — ephemeral signed updater configuration;
- `.github/workflows/desktop-release.yml` — native Windows/macOS/Linux gates;
- `scripts/prepare-desktop.mjs` — builds web and sidecar for the target triple.

## Dependencies

- Tauri 2, `tauri-plugin-shell` and `tauri-plugin-updater`;
- built `apps/server` and `apps/web`;
- `@yao-pkg/pkg` for the self-contained Node 24 binary.

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
then runs a headless Tauri shell-smoke.
`desktop:bundle:smoke` runs the `.app` or AppImage in headless smoke mode on
the target runner. `desktop:release` requires the endpoint, the public signing
key and the private release key, then produces the Tauri updater artifact and
`.sig`.

The portable ZIP contains `portable.flag`; only in this variant is data created
in `data/` next to the app. Installed NSIS/MSI builds have no marker and use
the platform app-local-data directory. Moving a single exe without `resources/`
and `neotavern-server.exe` is not supported.

## Limitations

- Build the installer on the target OS/architecture because of native addons
  (`better-sqlite3`, `sharp`).
- The sidecar listens only on a random free port on `127.0.0.1`.
- User data is stored in the platform app-local-data directory, not inside the
  bundle. The portable build stores it in the local `data/` folder next to the
  app.
- Generated `binaries/`, `resources/` and `target/` are not a source of truth
  and are recreated by `pnpm desktop:prepare`.
- The Windows bundle uses the plain numeric version `0.1.0`. Since `0.1.0` is a
  plain semver, both NSIS and MSI/WiX handle it without issues.
- NSIS, MSI and the portable ZIP are verified on Windows x64. The macOS package
  and the Linux AppImage are built only on their respective runners; the
  workflow runs the sidecar and native bundle smoke before publishing the
  artifact.
- The core updater is disabled in builds without the compile-time
  `NEOTA_UPDATE_ENDPOINT` and `NEOTA_UPDATE_PUBLIC_KEY`; the private signing
  key never ships inside the bundle.
