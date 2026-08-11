# Desktop and PWA

## Desktop (Tauri 2.x)

- The shell is Tauri 2; the Fastify backend runs as a bundled Node.js sidecar.
- Node.js and SQLite are included in the distribution; first launch needs no `npm install`.
- The user needs no terminal, Git, npm, or database setup.
- Targets: Windows installer + portable, macOS package, Linux AppImage/archive.
- Window close properly stops the sidecar; the backend does not linger after
  the app is closed.

> Status: Windows x64 pre-release verified locally. For macOS and Linux a
> mandatory native build/smoke gate is added in
> `.github/workflows/desktop-release.yml`: the bundle is launched with
> `NEOTA_DESKTOP_SMOKE=1`, waits for sidecar readiness, checks SQLite creation
> and the absence of orphan processes. Node.js, `better-sqlite3`, Sharp and
> production web assets are included in every platform package; the first
> launch does not run `npm install`.

`tauri.conf.json` uses `bundle.targets: "all"`, so `pnpm desktop:build`
selects the native formats of the current OS. Native addons and the
self-contained sidecar are always prepared on the same target runner;
transferring built assets between OSes is not supported.

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

## PWA

- responsive layout (desktop/tablet/phone);
- connects to the local backend on a PC/home server;
- offline app shell; API and generation require a reachable backend;
- the service worker caches only the app shell and static assets (not API/SSE/secrets);
- hashed assets are `immutable`, the HTML shell is `no-cache`.

The implementation lives in `apps/web/public/sw.js` and uses a versioned cache.
Navigation is network-first with an offline fallback, static assets are
cache-first, and all `/api/` requests are explicitly excluded. The manifest and
192/512 icons ship with the production frontend. The behavior is verified by
Playwright in offline mode and by a Cache Storage content audit.

When the PWA connects to a remote backend, access is closed behind a separate
login gate. The bootstrap token is exchanged for an HttpOnly/SameSite session
and is not stored in Web Storage; state-changing API requests use an in-memory
CSRF token. The production remote origin must be served over HTTPS. See
[ADR-0005](../adr/0005-remote-session-auth.md).

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
