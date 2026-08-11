# NeoTavern

**Local-first AI chat and roleplay platform.** NeoTavern is the successor of the
SillyTavern 2 project: a fast, self-hosted chat frontend and backend that runs
entirely on your machine — no cloud, no account, no telemetry.

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-docs.neotavern.com-435fd8)](https://docs.neotavern.com)
[![Node](https://img.shields.io/badge/node-%3E%3D24-339933)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-9-f69220)](https://pnpm.io)

## What is NeoTavern?

NeoTavern is a local-first AI chat platform built around one idea: your data and
your conversations stay on your computer. It ships as a desktop application
(Windows, macOS, Linux) and as an installable PWA that talks to a local backend,
and it keeps the documented SillyTavern-era plugin compatibility through a
dedicated legacy layer.

## Features

- **Local-first by design.** SQLite storage with WAL, FTS5 full-text search,
  transactional migrations, and cursor pagination — your library stays on disk,
  in your control.
- **One provider contract.** LLM, TTS, STT, and image providers plug into a
  single adapter interface with unified streaming events, error normalization,
  timeouts, and cancellation.
- **Prompt pipeline.** Macros, character/persona data, lorebooks, memory, token
  counting, context shifting, plugin interceptors, and instruct formats
  (ChatML, Llama 3, Alpaca, Mistral, Command-R, custom) — in a defined order
  with per-hook timeouts and diagnostics.
- **Versioned Plugin SDK.** Backend plugins run in a separate, SES-hardened
  Node.js runtime (a Worker + Compartment per plugin, capability broker, no
  ambient authority); the frontend SDK registers UI, commands, settings,
  interceptors, and message renderers with guaranteed cleanup.
- **Theme SDK.** Three-layer theming (design tokens → component skin → shell
  layout) with a documented contract, so themes can re-skin the entire app —
  from macOS-style to visual-novel — without touching chat logic.
- **Legacy compatibility.** `window.SillyTavern`, `eventSource`,
  `extension_settings`, jQuery islands, and an Express compatibility host keep
  documented SillyTavern-era extensions working.
- **Accessible and localized.** English and Russian UI, i18next namespaces,
  RTL support, WCAG 2.2 AA baseline theme.
- **Modern stack.** Fastify 5 + TypeBox, React 19 + Vite 8, SQLite via
  better-sqlite3 + Drizzle, Tauri 2 desktop shell, pnpm workspaces.

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

## Repository layout

```text
apps/
├── server          Fastify 5 backend (REST /api/v2, SSE streaming)
├── web             React 19 SPA (Vite 8, PWA)
├── desktop         Tauri 2 shell with a bundled Node.js sidecar
├── docs            Docusaurus documentation site (9 locales)
└── plugin-runtime  SES-hardened runtime for backend plugins

packages/
├── contracts       Shared API types and schemas (TypeBox)
├── db              SQLite schema, migrations, repositories (Drizzle)
├── provider-sdk    LLM/TTS/STT/image provider adapter contract
├── plugin-sdk      Plugin manifest schema and frontend/backend SDKs
├── plugin-build    CLI: neotavern-plugin analyze/sign/build/verify
├── theme-sdk       Design tokens, component skin, shell layout contract
├── ui              Headless React primitives (Radix-based)
├── i18n            English/Russian UI resources
├── legacy-compat   Documented SillyTavern-era compatibility layer
├── shared          Shared utilities and macros
└── gestures        Pointer-gesture primitives
```

## Development commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run backend + web dev servers |
| `pnpm build` | Type-check and build all packages |
| `pnpm typecheck` | TypeScript strict type-check |
| `pnpm lint` | ESLint (zero warnings) |
| `pnpm test` | Unit and integration tests |
| `pnpm test:e2e` | Playwright end-to-end suite |
| `pnpm docs:check` | Validate required docs and internal links |
| `pnpm docs:site:build` | Build the Docusaurus site |
| `pnpm desktop:release` | Build signed desktop installers (CI-owned) |

Requires Node.js ≥ 24 and pnpm 9.

## Documentation

- [docs.neotavern.com](https://docs.neotavern.com) — user and developer docs
  (architecture, API reference, Plugin SDK, Theme SDK, prompt pipeline, data &
  migrations, desktop).
- [CHANGELOG.md](CHANGELOG.md) — release history.
- [docs/adr](docs/adr) — architecture decision records.

## Support

If you want to support the project, you can donate on
[Boosty](https://boosty.to/neotavern/donate). To be clear: the link grants
nothing in return — no perks, no rewards, no early access. It is purely a way
to say thanks.

## License

NeoTavern is licensed under the [GNU Affero General Public License v3.0](LICENSE).
