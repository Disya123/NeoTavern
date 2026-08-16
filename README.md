# NeoTavern

**Local-first AI chat and roleplay platform.** NeoTavern is the successor of the
SillyTavern 2 project: a fast, self-hosted chat frontend and backend that runs
entirely on your machine — no cloud, no account, no telemetry.

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-docs.neotavern.com-435fd8)](https://docs.neotavern.com)
[![Node](https://img.shields.io/badge/node-%3E%3D24-339933)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-9-f69220)](https://pnpm.io)
[![Rust](https://img.shields.io/badge/rust-runtime%20kernel-000000)](https://www.rust-lang.org)

## What is NeoTavern?

NeoTavern is a local-first AI chat platform built around one idea: your data and
your conversations stay on your computer. It ships as a desktop application
(Windows, macOS, Linux), a native Android app, and an installable Web Client
that talks to a local or remote backend. SillyTavern-era plugin compatibility
is preserved through a dedicated legacy layer.

One product, several hosts: the Desktop app runs fully local (public builds
temporarily bundle the tested legacy Node sidecar while the Rust Kernel is an
explicit Preview — nightly/internal builds run the Kernel with no HTTP server;
ADR-0038), the same Kernel runs headless on a VPS via `neotavern-headless`,
Android uses the same runtime and data format without Node.js — and all of
them share one authoritative implementation of persistent state: the Rust
Runtime Kernel.

## Architecture

```text
Public Contracts (TypeBox wire schemas → TS types + generated Rust DTO)
        │
        ├── UI / Application (React, Theme SDK, Plugin UI contributions)
        └── Runtime Kernel (Rust: SQLite ownership, migrations, recovery,
                            generation durability, backup/restore primitives)
                │
                └── Hosts: Desktop (Tauri + sidecar) · Android (JNI local host)
                           · Headless (neotavern-headless / remote-http) · Web (RemoteBackend)
```

- **One source of truth for cross-language contracts.** Product Wire Contracts
  are defined once as TypeBox schemas; TypeScript types are inferred and the
  Rust boundary DTOs are generated from the same bundle
  (`tools/contract-codegen`, deterministic, hash-pinned). No hand-written
  TypeScript/Rust DTO mirrors.
- **Runtime Kernel is the only writer.** SQLite is opened through the kernel's
  data-root lease; schema, migrations, recovery snapshots, generation workflow
  state and backup primitives have exactly one authoritative implementation
  across Desktop, Android and Headless.
- **Server is an adapter, not the core.** Local IPC, the HTTP/SSE adapter and
  the CLI all speak the same logical operation registry. Desktop Remote Access
  (Phase 9) is an optional service — when off, no listener exists.

## Features

- **Local-first by design.** SQLite storage with WAL, FTS5 full-text search,
  transactional migrations, and cursor pagination — your library stays on disk,
  in your control.
- **Product Wire Contracts.** Versioned TypeBox operation registry, deterministic
  JSON Schema bundle + manifest, generated Rust DTOs, golden/negative
  cross-language corpus, exact local contract handshake (`schemaHash`) before any
  product write.
- **Runtime Kernel (Rust).** Data-root lease, SQLite ownership and migrations,
  consistent recovery snapshot, immutable asset protocol with orphan GC,
  durable generation state (leases, revisions, interrupted recovery) — the same
  semantics on every native host.
- **One provider contract.** LLM, TTS, STT, and image providers plug into a
  single adapter interface with unified streaming events, error normalization,
  timeouts, and cancellation. Portable built-in adapters run locally on Desktop
  and Android.
- **Prompt pipeline.** Macros, character/persona data, lorebooks, memory, token
  counting, context shifting, plugin interceptors, and instruct formats
  (ChatML, Llama 3, Alpaca, Mistral, Command-R, custom) — in a defined order
  with per-hook timeouts and diagnostics.
- **Versioned Plugin SDK.** Backend plugins run in a separate, SES-hardened
  Node.js runtime (a Worker + Compartment per plugin, capability broker, no
  ambient authority); the frontend SDK registers UI, commands, settings,
  interceptors, and message renderers with guaranteed cleanup. UI contributions
  are declarative semantic slots (`chat.header.actions`, `chat.message.actions`,
  `character.editor.actions`, `settings.section`, `generation.controls`) that
  the host renders — no third-party markup or arbitrary JS in the main WebView.
- **Extension hardening.** App-level legacy-frontend gate (default off) stacked
  on per-plugin `legacy.trusted` consent, theme activation rollback with a
  last-working fallback, manifest `engines` enforcement, namespaced-state
  quotas, a write-only SecretStore, and explicit runtime availability probes on
  every host.
- **Theme SDK.** Three-layer theming (design tokens → component skin → shell
  layout) with a documented contract and responsive `density`/`motion`
  semantics, so themes can re-skin the entire app — from macOS-style to
  visual-novel — without touching chat logic.
- **Android without Node.** A JNI bridge into the same Runtime Kernel, local
  profile with data-root lease, RemoteBackend profiles, secure storage, and a
  bounded foreground-service + WorkManager background execution adapter for
  user-visible generation.
- **Backup and recovery.** Consistent SQLite snapshot + pinned immutable
  assets, staged restore with atomic activation, versioned Portable Export and
  recoverable import, read-only Recovery Mode, cross-platform fixtures.
- **Legacy compatibility.** `window.SillyTavern`, `eventSource`,
  `extension_settings`, jQuery islands, and an Express compatibility host keep
  documented SillyTavern-era extensions working — gated by explicit consent.
- **Accessible and localized.** English and Russian UI, i18next namespaces,
  RTL support, WCAG 2.2 AA baseline theme.
- **Modern stack.** Fastify 5 + TypeBox, React 19 + Vite 8, SQLite via
  better-sqlite3 + Drizzle, Rust Runtime Kernel, Tauri 2 desktop shell, pnpm
  workspaces.

## Quick start

### Desktop (recommended)

Download the latest portable build from the
[Releases](https://github.com/Disya123/NeoTavern/releases) page, unpack it, and
run `NeoTavern.exe`. No terminal, no Node.js, no setup — the backend is bundled.

### From source

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts the Fastify backend and the Vite dev server. The app opens at
the printed URL (the backend binds to `127.0.0.1` by default).

### Android (from source)

Requires the Rust toolchain (for the kernel + JNI bridge), Android SDK/NDK,
and a production web build (ТЗ §11.4 — assemble is fail-closed without
`apps/web/dist/index.html`):

```bash
pnpm --filter @neotavern/web build
cd apps/android
bash scripts/build-libs.sh
gradle :app:assembleDebug
```

The APK bundles the Runtime Kernel via JNI and the packaged web UI — no
Node.js runs on-device. See [docs/android](docs/android/README.md).

## Repository layout

```text
apps/
├── server          Fastify 5 legacy/migration backend (REST /api/v2, SSE)
├── web             React 19 SPA (Vite 8, installable Web Client)
├── desktop         Tauri 2 shell with a bundled Node.js sidecar
├── android         Android host (Gradle): JNI kernel + packaged web assets
├── docs            Docusaurus documentation site (EN / 简体中文 / 日本語)
└── plugin-runtime  Separate process running SES-hardened Workers per plugin

packages/
├── contracts       Product Wire Contracts (TypeBox) + generated artifacts
├── client-sdk      Typed RemoteBackend client (HTTP/SSE, auth, cancellation)
├── neobackend      Product-facing facade shared by local/remote backends
├── db              SQLite schema, migrations, repositories (Drizzle)
├── provider-sdk    LLM/TTS/STT/image provider adapter contract
├── plugin-sdk      Plugin manifest schema and frontend/backend SDKs
├── plugin-build    CLI: neotavern-plugin analyze/sign/build/verify
├── theme-sdk       Design tokens, component skin, shell layout contract
├── ui              Headless React primitives (Radix-based)
├── i18n            English/Russian UI resources
├── legacy-compat   Documented SillyTavern-era compatibility layer
├── shared          Shared utilities, errors, macros
└── gestures        Pointer-gesture primitives

crates/              Rust workspace (Runtime Kernel, generated contract DTOs)
├── runtime-kernel   Operation dispatch over the wire contract (std-only)
├── storage          SQLite ownership, data-root lease, migrations, snapshot
├── contracts-generated  Rust DTOs generated from the TypeBox bundle
├── built-in-providers   Portable local provider adapters
├── provider-sdk     Rust side of the provider contract boundary
└── adapters/        tauri-local · remote-http · android-jni · mobile-ffi ·
                     desktop-remote · cli · envelope

tools/
├── contract-codegen Deterministic schema bundle → manifest + Rust DTO generator
└── capability-matrix Capability × host status matrix (ARC-10) generator
```

## Development commands

| Command                 | Purpose                                                   |
| ----------------------- | --------------------------------------------------------- |
| `pnpm dev`              | Run backend + web dev servers                             |
| `pnpm build`            | Type-check and build all TS packages/apps                 |
| `pnpm typecheck`        | TypeScript strict type-check                              |
| `pnpm lint`             | ESLint (zero warnings)                                    |
| `pnpm test`             | Unit and integration tests                                |
| `pnpm test:e2e`         | Playwright end-to-end suite                               |
| `pnpm contracts:check`  | Contract codegen determinism (`--check`, clean-tree gate) |
| `pnpm contracts:diff`   | Semantic wire-contract diff                               |
| `pnpm crates:test`      | Rust workspace tests (cargo)                              |
| `pnpm benchmark`        | DB benchmark suite                                        |
| `pnpm docs:check`       | Validate required docs and internal links                 |
| `pnpm docs:build`       | Build the docs site                                       |
| `pnpm desktop:portable` | Build portable Windows bundle (no installer)              |
| `pnpm desktop:release`  | Build signed desktop installers (CI-owned)                |

Requires Node.js ≥ 24, pnpm 9, and (for `crates:test` / Android) the Rust
toolchain.

## Documentation

- [docs.neotavern.com](https://docs.neotavern.com) — user and developer docs
  (architecture, API reference, Plugin SDK, Theme SDK, prompt pipeline, data &
  migrations, desktop, Android).
- [CHANGELOG.md](CHANGELOG.md) — release history.
- [docs/adr](docs/adr) — architecture decision records.

## Support

If you want to support the project, you can donate on
[Boosty](https://boosty.to/neotavern/donate). To be clear: the link grants
nothing in return — no perks, no rewards, no early access. It is purely a way
to say thanks.

## License

NeoTavern is licensed under the [GNU Affero General Public License v3.0](LICENSE).
