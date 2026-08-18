# @neotavern/plugin-build — Build/publish pipeline (Plugin SDK vNext, Stage H)

CLI and library for preparing vNext plugin packages: `neotavern-plugin analyze` /
`neotavern-plugin build` / `neotavern-plugin sign` / `neotavern-plugin verify` /
`neotavern-plugin genkey`.

## Purpose

The canonical package remains SOURCE: manifest + JS/TS modules + vendored
pure-JS dependencies. Endo/SES compiled records are not a Plugin ABI. The
runtime (Plugin Runtime) builds the module graph from sources itself;
`plugin-build` is responsible for:

- static analysis of vNext readiness (Node builtins, platform payloads,
  install scripts, dynamic imports, WASM, npm dependencies);
- zero-build packaging of plain JS and TypeScript transpilation via the pinned
  `typescript` from the catalog (no platform toolchain);
- Ed25519 manifest signing with a `publisher.keyId` pin;
- warning about non-vendored `dependencies` — the runtime never runs
  `npm install`.

## Public API

- `analyzePackage(root)` → `AnalyzerReport` (`compatible`, `issues[]` with
  codes `UNSUPPORTED_NODE_BUILTIN` / `UNSUPPORTED_PLATFORM_PAYLOAD` /
  `UNSUPPORTED_INSTALL_SCRIPT` / `UNSUPPORTED_DYNAMIC_IMPORT` /
  `DYNAMIC_CODE` / `NPM_DEPENDENCIES` / `PACKAGE_INVALID`,
  `capabilities[]` — hints, `stats`).
- `buildPackage(root, { privateKeyPem?, outDir?, force? })` →
  `BuildArtifact` (`manifest`, `fileDigests`, `sourceDigest`,
  `moduleGraphDigest: null`); writes `dist/backend/artifact.json`.
  Hard gates (platform payloads, install scripts, invalid manifest) block the
  build; `--force` downgrades them to warnings.
- `signManifest(manifest, privateKeyPem)` → `SignedManifest`;
  `verifyManifestSignature(manifest, publicKeyPem?)` → `{ok}` | `{ok:false,
reason}` (`PACKAGE_SIGNATURE_INVALID` / `PUBLISHER_KEY_CHANGED`).
- `generateKeyPair()` → PEM pair + `keyId` (`ed25519:<hex>`).
- `transpileTypeScript(source, fileName)` — ESM TS transpilation.

## CLI

```text
neotavern-plugin analyze <dir> [--json]
neotavern-plugin build <dir> [--key <private.pem>] [--out <dir>] [--force]
neotavern-plugin sign <manifest.json> <private.pem>
neotavern-plugin verify <manifest.json> [--key <public.pem>]
neotavern-plugin genkey [--out <base>]
```

Exit codes: 0 ok, 1 analyze/build/verify failed, 2 usage error. `sign`/
`verify` transparently accept `artifact.json` too (unwrap of the manifest).

## Signing

`signManifest` sets `publisher.keyId` (SHA-256 fingerprint of the public key,
`ed25519:<hex>`) and signs the canonical JSON (sorted keys, no whitespace)
without the `signature` field. `verify` first checks the keyId against the key
(`PUBLISHER_KEY_CHANGED`), then verifies the signature. The manifest carries
`fileDigests` (sha256 of every package file) — the signature authenticates
them too; the runtime compares the actual files against disk when building the
module graph (source-first).

## Constraints

- The analyzer is conservative: unknown extensions with PE/ELF/Mach-O magic
  sniffing are flagged as platform payloads.
- `dependencies` from package.json without `vendor/<name>` — warning only:
  the marketplace/publish pipeline is responsible for vendoring.
- `moduleGraphDigest` is `null` in the artifact — the runtime computes it; it
  is a runtime cache key, not an ABI.

## Development

```bash
pnpm --filter @neotavern/plugin-build build   # tsc -b
pnpm --filter @neotavern/plugin-build exec vitest run   # tests
```

Dependencies: `@neotavern/plugin-sdk` (manifest validation + capability
catalog), `@neotavern/shared`, `typescript` (catalog). Tests:
`test/analyze.test.ts`, `test/signing.test.ts`, `test/build.test.ts`.
