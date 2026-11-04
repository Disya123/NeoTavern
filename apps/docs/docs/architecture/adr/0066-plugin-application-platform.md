---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0066-plugin-application-platform.md
---

# ADR-0066 — Plugin platform: hybrid execution, server-owned lifecycle, SDK not integrations

- **Status:** accepted (design), round 81
- **Supersedes:** the "plugins are descriptors whose code already lives in the web bundle"
  assumption (rounds 75–77) and the iframe-only delivery in `apps/web/src/plugins/runtime.ts`
- **Related:** ADR-0059 (React primary pivot), ADR-0064 (kernel plugin executor),
  ADR-0065 (sandbox job dispatch)

## Decision

NeoTavern ships a **plugin platform**, not a set of integrations. The SDK stays
generic: it defines execution, IPC, permissions, UI surfaces and lifecycle, and
never grows an `VTuberAPI` or `OnnxPluginAPI`. Whatever a developer can build on
top of the public SDK — an ONNX pipeline, an autonomous agent, a Live2D/VRM
avatar, a completely different shell — is out of scope for the core.

Four layers, each with one job:

1. **Plugin SDK** — stable, language-neutral contracts: runtime entrypoints
   (JS/WASM/native), core API over Product Wire, UI surfaces, events, storage,
   system capabilities, IPC, lifecycle.
2. **Plugin Host** — starts, supervises and kills plugin runtimes. One OS process
   per native plugin, WASM in its own worker process, JS in a sandboxed realm.
3. **Plugin UI context** — isolated rendering surface (separate WebView/iframe
   origin), never the main React tree, with an always-available escape back to the
   stock UI.
4. **Kernel** — the only holder of SQLite, secrets and wire dispatch. No plugin
   code is ever loaded into the kernel process, and no plugin gets a database
   handle.

## Decisions in detail

### D1. Hybrid execution, chosen by the plugin, enforced by the host

| Plugin kind                             | Runtime                                     | Isolation                                   |
| --------------------------------------- | ------------------------------------------- | ------------------------------------------- |
| JS/TS extension                         | sandboxed realm in the host                 | opaque origin, no DOM access to the app     |
| WASM                                    | Wasmtime/WASI in a dedicated worker process | WASI capability set, no ambient authority   |
| Native (ONNX, llama.cpp, Python, agent) | one OS process per plugin                   | OS-level containment + granted capabilities |
| UI                                      | separate WebView/iframe origin              | no Tauri IPC, broker-only access            |

A native plugin is not automatically trusted: a separate process survives crashes
but does not contain malicious code. Native execution therefore requires an
explicit, per-capability consent at install time (GPU, filesystem roots, network
hosts, microphone, camera, shell replacement).

### D2. Execution affinity is declared, never inferred

The manifest declares which parts run on the host and which are client surfaces
(`runtime.host`, `runtime.ui`). The client never decides to run heavy work
locally, and there is **no silent fallback**: if the host lacks ONNX or a GPU, the
plugin reports a capability error instead of quietly computing on the phone.

### D3. Server-owned lifecycle

Agents, models and background work belong to the host that owns the data root.
Opening a second client attaches to the same instance; it never starts a second
agent. Client-side plugin code is limited to UI and thin RPC calls by default.

### D4. UI replacement is a first-class capability

`ui.shell.replace` lets a plugin own the whole window. The stock UI always keeps a
way back (a host-drawn control, not a plugin-drawn one), and a crashed or hung
plugin UI returns the user to NeoTavern.

### D5. Native packaging with verifiable contents

A package is a directory/ZIP with `manifest.json`, `ui/`, `wasm/`, `native/`
(per-platform binaries), `assets/`, and a `checksums` map. Signatures prove
origin and integrity, not safety: the install dialog states exactly that, and the
capability list is the real contract.

### D6. Platform constraints are part of the design

- **Android 10+** cannot execute arbitrary binaries from app-writable storage:
  Android gets WASM, pre-bundled compute providers (e.g. ONNX Runtime loading
  models as data), and remote workers.
- **Web** never launches native processes; it attaches to a host over the wire.
- **Desktop** runs the full host (process supervisor, native plugins) and may host
  the UI WebView with a broker-only bridge.

### D7. Supervisor, not hope

One supervisor owns every plugin process: start, health, resource budgets
(CPU, RSS, GPU memory where exposed), crash capture, bounded restart with backoff,
and terminal state after N failures. Crash reasons are recorded and surfaced in the
UI. Kernel, chats and other plugins are unaffected by a plugin's death.

### D8. SDK compatibility

The 0.1.0 SDK contracts (capability grants, storage, events, worker API) stay
compatible where the semantics survive. The execution mechanism changes; the
developer-facing API does not fork into "old" and "new" dialects.

### D9. Acceptance is behavioural, not structural

The platform counts as implemented only when four destructive tests pass on a
packaged artifact:

1. kill the ONNX/native plugin process mid-run — kernel keeps serving, other
   plugins stay alive, the plugin restarts per policy;
2. hang an agent (no heartbeat, no reply) — supervisor reaps it, no kernel stall;
3. crash the plugin UI — the stock shell returns and chat state is intact;
4. attempt an ungranted capability (filesystem outside its root, network host,
   microphone) — denied at the broker, with a stable error code.

Absolute containment is not claimed: a GPU driver fault or system OOM affects more
than the plugin.

## Phases

| Phase         | Deliverable                                                                                                                                                                          | Why first                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| P1 (round 81) | ADR + manifest schema for package layout and runtime declarations; contract sketch for `plugins.bundle.*`                                                                            | Nothing else can load code until the format is named |
| P2            | Kernel bundle staging: install a package into `data/plugin-bundles/<id>/<version>/`, checksums, bounded range reads over wire; UI loader replaces the dead `/api/v2/.../sandbox` URL | Unblocks every plugin kind                           |
| P3            | Supervisor skeleton: process spawn, health, budgets, restart policy, crash report — with a dummy native plugin                                                                       | Turns isolation from claim into mechanism            |
| P4            | UI contexts: panel, overlay, full-shell replacement with host escape hatch                                                                                                           | Enables VTuber-class products                        |
| P5            | Capability consent flow for native/GPU/mic/camera/filesystem, plus the four acceptance tests                                                                                         | Makes the platform trustworthy                       |

## Consequences

- The descriptor-only install from round 75 becomes the degenerate case of a
  package with no code; it stays supported.
- `security.plugin-package-trust` can only return to `Packaged` after P2 + P5: a
  packaged artifact must install a package, verify its checksums, deny an ungranted
  capability and survive a process kill.
- The web client on a remote host never "just works" for native plugins; it
  attaches to the host that runs them, which is the point of D2/D3.
