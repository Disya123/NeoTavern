---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0033-desktop-local-kernel-transport.md
---

# ADR-0033: Desktop Local Kernel Transport — Tauri IPC Cutover

Date: 2026-08-13. Status: Accepted (Phase 3).
Related documents: [Operations inventory](../architecture/operations-inventory.md),
[Desktop](../desktop/README.md), [Wire contracts](../architecture/wire-contracts.md),
[ADR-0029](0029-wire-contract-toolchain.md), [ADR-0030](0030-remote-http-adapter.md),
ТЗ §6.3, §6.5, §11.1, §15.1, §78 Фаза 3.

## Context

Phase 3 requires the Desktop local mode to run as
`React → LocalBackend → Tauri IPC → Runtime Kernel` with the HTTP server
fully off (§11.1). Before this ADR the desktop shell spawned the Node.js
Fastify sidecar and served the webview from `http://127.0.0.1:<port>` — the
server-first model ТЗ §1.3 rejects. The Runtime Kernel already owned the
durable surface (storage, generation, backup primitives, Phase 0–2), and
`packages/neobackend` already provided `LocalBackend` over a caller-supplied
`LocalTransport`, but no transport, no shell wiring and no envelope layer
existed for the Tauri boundary. The wire contract is frozen
(`WIRE_SCHEMA_HASH`), so the cutover surface is exactly the registry:
`meta.get`, characters CRUD, chats CRUD, messages CRUD, generation
workflows, providers/backups/lorebooks/presets lists.

## Decision

- **Shared envelope crate** `crates/adapters/envelope` (`neotavern-envelope`):
  the request/response envelope mapping (decode → protocol check → dispatch →
  validated response) moved out of `remote-http-adapter`; the CLI, the HTTP
  adapter and the new Tauri transport answer **byte-identical** response
  envelopes for the same operation (§6.3 — transports do not define their own
  DTOs). The HTTP status on `EnvelopeFailure` is informational for non-HTTP
  transports; wire code + params are the contract.
- **Tauri local adapter** `crates/adapters/tauri-local`
  (`neotavern-tauri-local`): `KernelHost` embeds one `Kernel` in the Tauri
  process. `KernelHost::open` enforces the exact local handshake (§6.5) from
  the embedded manifest (schema hash + FFI ABI version), so a stale WebView
  bundle or mismatched native library fails before any product write.
  Commands (behind a non-default `tauri` feature, so the workspace test
  graph stays free of the WRY tree): `kernel_dispatch` (unary envelope),
  `kernel_stream_start` (live stream: native worker polls the durable
  `generation.events` log, forwards committed `wire.event.envelope` values
  over a Tauri `Channel`, sends a `null` end-of-stream sentinel — transport
  framing, like the SSE `stream.closed` frame) and `kernel_stream_abort`
  (sets the per-stream `CancellationFlag`; the poller turns it into a
  durable `generation.cancel`, §63).
- **Desktop shell** `apps/desktop/src-tauri`: kernel mode is the default —
  the window loads bundled web assets via `WebviewUrl::App` (`tauri://
localhost`), no HTTP server/listener exists, and the legacy Node sidecar
  is spawned only with `NEOTA_LEGACY_SERVER=1` (transition bridge for
  unmigrated routes; only one mode runs at a time, so a data root never has
  two writable owners). `NEOTA_DESKTOP_SMOKE=1` in kernel mode self-checks
  the packaged kernel (handshake + `meta.get` + `characters.list` +
  `backups.list`) and exits deterministically.
- **TS transport** `apps/web/src/api/tauriTransport.ts`: `LocalTransport`
  over `invoke`, building the same `wire.request.envelope` the client-sdk
  HTTP transport uses; product errors arrive as error envelopes,
  transport failures throw typed `TransportError`s (the RemoteBackend
  split). `stream()` uses an eager open on an independent promise chain and
  a manual async iterator (no async-generator `return()` semantics to fight)
  so an early consumer leave still aborts the opened run. `backend.ts`
  switches to `LocalBackend` when the Tauri bridge is detected; a plain
  browser keeps `LegacyBackend`, and `legacyRaw()` fails with a typed
  `UnsupportedError` in kernel mode.
- **First vertical slice**: the DiagnosticsPanel kernel section — kernel
  metadata (`meta.get`) and backup count (`backups.list`) rendered through
  the `NeoBackend` facade, visible only in the desktop shell. The read
  surfaces (character/chat browse, generation page) remain legacy-shaped
  because the frozen wire registry carries no avatar URLs; chat/message
  write operations landed with the M2 golden slice (chats CRUD +
  `chats.messages.*`), so those slices move once the UI cutover is
  scheduled (documented in the routing table).

## Alternatives

- **Tauri commands in the shell crate instead of an adapter crate**:
  rejected — ТЗ §77 places transport adapters in `crates/adapters/`, and the
  adapter is unit-testable without the Tauri runtime (the `tauri` feature
  gates only the command surface).
- **Reusing `remote-http-adapter` for the envelope layer in the desktop**:
  rejected — that would drag `tiny_http` and the whole HTTP/auth stack into
  the local process, contradicting §11.1; hence the shared envelope crate.
- **Async-generator stream with a bounded wait**: rejected after a probe
  showed `return()` cannot preempt an async generator suspended on a
  promise; the manual async iterator is fully controllable.
- **Kernel + sidecar running simultaneously (dual store)**: rejected —
  two writable owners for one data root violates §22/§87.

## Consequences

- The desktop binary embeds the kernel; a kernel open failure aborts startup
  with a controlled error (no window against a dead kernel).
- Legacy features in kernel mode degrade with typed `UnsupportedError`s
  until the contract grows — the migration routing table tracks each slice.
- CI: the workspace test/clippy jobs compile `neotavern-tauri-local` without
  the `tauri` feature (fast, no system webview deps); the command surface is
  compiled and exercised by the desktop build/smoke pipeline.
- The smoke gate now proves the packaged kernel + exact handshake with the
  server fully off.
