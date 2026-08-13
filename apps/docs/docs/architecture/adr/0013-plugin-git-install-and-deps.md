---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0013-plugin-git-install-and-deps.md
---

# ADR-0013: Plugin installation via Git link and built-in npm dependency installer

## Context

The user wants to install plugins by pasting a Git repository link into the
Plugin Manager: the server downloads the plugin, automatically installs its
npm dependencies, and the plugin works. At the same time, AGENTS.md §4/§21
forbid mandatory external processes: the distribution must not require
installed `git` or `npm`, and installation must not require a terminal.

The second part of the problem is heavy WASM/ML libraries (ONNX Runtime,
Transformers.js etc.) that are impractical to bundle: they weigh tens of
megabytes and are updated independently of the plugin. They need a legitimate
path into the `node_modules` of a backend plugin without executing
install scripts.

## Decision

### Source: repository HTTPS archive (no git binary)

- `parseGitRepoUrl` accepts only `https://` links from `github.com` /
  `gitlab.com` (plus a `www.` prefix), optionally `.git`, a trailing slash
  and `/tree/{ref}`; other hosts, schemes and URL forms are rejected
  (`PLUGIN_SOURCE_UNSUPPORTED` / `PLUGIN_SOURCE_INVALID`).
- The archive is downloaded from a host-specific endpoint: GitHub
  `codeload.github.com/{owner}/{repo}/tar.gz/{ref|HEAD}`, GitLab
  `/-/archive/{ref}/{repo}-{ref}.tar.gz` (GitLab cannot handle HEAD — an
  explicit ref is required). Every redirect (≤5) is checked for HTTPS; the
  limit is 25 MB, gzip magic is checked before unpacking.
- The archive then goes through exactly the same path as a ZIP:
  `extractTarGzArchive` (symlink/hardlink/device ban, path traversal, limits,
  atomic writes), `findPackageRoot` → `readManifest` → `validatePackage` →
  atomic replacement with rollback. The source is recorded in
  `plugin_registry.source` (migration 0015).

### Dependencies: built-in installer (no npm, no install scripts)

- Only `dependencies` from the package's `package.json` are read; git/file/
  workspace/URL specifications are rejected before the network
  (`PLUGIN_DEPS_UNSUPPORTED`).
- A custom semver resolver (`^ ~ >= <= > < = * x ||`, hyphen, prerelease
  gating) without external dependencies; BFS over transitive dependencies
  with hoisting into a **flat** `node_modules` inside the package.
- Tarballs are fetched from the registry over HTTPS, verified against
  `dist.integrity` (sha512/sha256), cached in `data/cache/plugin-deps/` with
  a limit.
- Install scripts are never executed, bin links are not created; after
  unpacking, `node_modules` is scanned for native/executable files →
  `PLUGIN_DEPS_FORBIDDEN_FILE` and rollback of the whole installation.
- A version conflict at flat hoisting → `PLUGIN_DEPS_CONFLICT`; the result
  is recorded in `node_modules/.neotavern-deps.json` and in
  `plugin_registry.dependencies`; the UI shows the package list before
  activation.

### Loader

Bare imports from `node_modules` are allowed for a backend plugin only when
the `.neotavern-deps.json` marker exists (env `NEOTA_PLUGIN_ALLOW_BARE_IMPORTS=1`,
set by the host). The existing "resolve only inside the package root" check
remains the barrier; `node:*`, `data:`, `http(s):` are always blocked.

## Alternatives

1. **Call `git clone`.** Rejected: requires installed git (violates §4/§21),
   arbitrary hooks/filters, harder to limit and roll back.
2. **Call `npm install`.** Rejected: requires the user's npm/Node
   environment, **executes install scripts** (the main supply-chain vector),
   writes to the global cache, non-deterministic over time.
3. **Prebuilt bundle only (no dependencies at all).** Rejected as the sole
   path: heavy WASM/ML libraries make the bundle impractical. But bundling
   remains the **recommended** path — see the Plugin SDK documentation
   (warning at the start of the "Plugin dependencies" section).
4. **Nested node_modules (npm-compatible resolution).** Deferred: sharply
   complicates the installer and loader; flat hoisting covers the target
   scenario (one heavy library + its pure-JS wrapper), and a version
   conflict is explicitly reported with a bundling recommendation.

## Supply-chain mitigations (reduce risk, do not zero it out)

An arbitrary npm package is arbitrary code inside the plugin sandbox. Adopted
measures: HTTPS only (registry, tarballs, every archive redirect); integrity
verification; native binaries and executable files forbidden (twice: scan at
install + `process.dlopen` zeroed in the worker); install scripts forbidden;
Node Permission Model on the worker (fs-read only of the package root);
explicit user consent with the list of installed packages before activation.

## Consequences

- New endpoint `POST /api/v2/plugins/install-git`, configuration
  `NEOTA_PLUGIN_GIT_INSTALL`, `NEOTA_PLUGIN_REGISTRY`,
  `NEOTA_PLUGIN_DEPS_MAX_PACKAGES`, `NEOTA_PLUGIN_DEPS_MAX_BYTES`; migration
  0015 (`source`, `dependencies`), new error codes `PLUGIN_SOURCE_*` /
  `PLUGIN_DEPS_*` with en/ru localization.
- v1 limitations (documented in the Plugin SDK README): dependencies with
  `node:*` builtins are not loaded; GitLab requires an explicit ref; version
  conflicts at flat hoisting are not resolved automatically.
- Further steps (separate ADRs): builtin allowlist for dependencies, nested
  resolution, frontend dependency installation.
