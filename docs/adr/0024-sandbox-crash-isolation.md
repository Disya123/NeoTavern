# ADR-0024: Crash isolation for sandbox frames (rev4 stage 8, §M3)

## Context

A plugin in a sandbox iframe could die or hang silently: the session port closed, but the host could not tell "the plugin left" from "the plugin is alive but broken". The user saw a vanished toolbar with no explanation, and the plugin had no chance of recovery. Required (rev4 §M3):

- detection of a dead/hung iframe (heartbeat, hung detection);
- restart budget and crash-loop disable;
- host-controlled kill switch;
- cleanup of streams/workers/jobs/handles on failure;
- preserved diagnostics (the failure counter is visible to the plugin).

Alternatives:

1. **Heartbeat ping only, on a timer** — works in site-isolated Chromium (the sandbox is in a separate process, the main page stays alive). But in the shared-process model, a main-thread spin inside the iframe freezes the main page too: the host's timers never fire at all — the ping detects nothing. (Confirmed by an e2e probe: `while(true){}` in the sandbox froze the whole tab, timers died.)
2. **UI dialog only, on an error event** — catches `activate()`/mount exceptions, but not process death and not hangs.
3. **Two signals: session port closure + heartbeat** (chosen) — port closure is detected without timers (EventTarget `close`), the heartbeat covers hangs in site-isolated environments; budget and crash-loop disable are shared by both paths.

## Decision

1. **Signal 1 — port closure**: `KernelSession.onPeerClose(listener)` (new SDK API): the MessagePort close event fires on sandbox process death and on document self-navigation. The runtime (`startKernelSession`) subscribes it to `handleFrameCrash(frame)`. Self-navigation is additionally routed through the crash path from `resetFrameSession` (the document that replaced the sandbox is not a plugin).
2. **Signal 2 — heartbeat**: `kernel.ping` handler in the sandbox bootstrap; the host pings every live frame (10 s interval, 3 s deadline, `crashPolicy` on the runtime instance — tests shrink it). A missed ping → crash path. Pings skip frames in graceful removal.
3. **Restart budget**: per-plugin failure history in a 10-minute window; `maxRestarts = 3` — failures 1–3 restart the frame (`finalizeFrameRemovalNow(frame, frame.plugin)`), the (N+1)-th is a crash loop: the frame is not created and the plugin is disabled server-side (`POST /plugins/:id/disable`, which revokes grants and emits `plugin.disabled`).
4. **Kill switch / user interface**: the `neotavern-plugin-crash` event with `{pluginId, pluginName, error, restartBudgetLeft, disabled}`; PluginRuntimeUi renders a host-owned notification (`pluginId: 'host'` — survives the teardown of the failed frame, which only clears plugin-owned notifications). Disabling is also available from the Plugins panel.
5. **Cleanup**: the crash path goes through the same finalize as graceful teardown — session dispose closes streams/workers/jobs/handles, clearOverlays removes the chrome, pending invokes are rejected.
6. **Diagnostics**: `DiagnosticsSnapshot.crash` (optional) `{count, lastAt, restartBudgetLeft}` — only the plugin's own data.

## Consequences

- A dead sandbox (process, navigation) is recovered automatically under the budget; a crash loop leads to explicit disabling with a user notification rather than silent disappearance.
- The heartbeat is honestly documented: in the shared-process model a spin is not detected by timers — port close remains the primary signal.
- New SDK contract: `KernelSession.onPeerClose` (additive, optional); `DiagnosticsSnapshot.crash` (additive).
- Tests: unit — ping-deadline restart, healthy ping without failure, crash-loop disable with an endpoint call, port-close restart, diagnostics, graceful removal is not touched by the crash path; e2e — the `rev4-crash.boom` command navigates the sandbox away → "restarted" toast → the command re-registers.
- Cost: ~90 lines of runtime + sandbox handler + SDK method + event/toasts.

## Migration

No DDL and no breaking changes: `onPeerClose` and `crash` are additive; plugins without crash semantics are unaffected. Rollback — removal of the subscription, the heartbeat, and the crash paths; old plugins work as before.
