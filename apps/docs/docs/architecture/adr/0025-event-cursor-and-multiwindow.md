---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0025-event-cursor-and-multiwindow.md
---

# ADR-0025: Event cursor/replay and multi-window background singleton (rev4 stage 9, §J1/J3)

## Context

Two SDK holes after stage 8:

1. **§J1 — events without memory.** The `events.subscribe(event, cb)` subscription delivered only live events: a sandbox reset (crash, update, reconnect) silently lost everything that happened in the meantime, with no way to recover the missed events. There was no cursor, no replay window, no dedupe key, no backpressure — the plan requires at-least-once delivery, ordering within an aggregate, a cursor/replay window, an event ID, and a bounded queue.
2. **§J3 — multi-window.** The plugin activates in every tab; without a host model of "one background per installation", every consumer (listeners, polling, job triggers) would run in all windows — duplicating work and writing conflicting data. The plan requires a separation of installation runtime / UI instance per window / background singleton.

Alternatives:

1. **Server event log + replay over HTTP** — the most "honest" replay, but requires a persistence layer for events, migration, GC, and a new API; unsuitable for web-only events (part of the stream is local app events) without reworking SSE. Deferred: a bounded in-memory ring buffer on the host covers the reconnect cases within the window (128/name, 4096 total, 60 s TTL), and a server log remains future work.
2. **Worker/lock file on the server as the singleton** — the background is already server-side for jobs; but a web-side singleton (listeners, polling) requires local tab coordination — BroadcastChannel is cheaper and does not touch the server.
3. **Chosen:** host-side ring buffer + ack-based delivery (§J1); BroadcastChannel election with lease expiry (§J3). Both additive, both bounded, both with explicit degradation.

## Decision

### §J1 — cursor/replay

- Every app event is written to a bounded ring buffer **before** listeners are dispatched (`runtime.recordAppEvent` in `dispatchAppEvent`): per-name sequence, 128/name, 4096 total, 60 s TTL, global FIFO eviction.
- `events.subscribe {event, cursor?}`: without a cursor — live from the current position (legacy behavior preserved); with a cursor — replay from the buffer after the cursor, then live. A cursor outside the window → `EVENT_CURSOR_EXPIRED` (explicit degradation, invariant 8); a cursor from the future → `VALIDATION_FAILED`.
- Every `evt.emit` carries a `cursor` (`<event>:<seq>`) — a stable dedupe key; the host tracks delivered-but-not-acked (bounded `maxInFlight`, default 64) and pauses delivery until `events.ack` — backpressure without memory growth (the buffer is the bound, invariant 5).
- Sandbox side: `api.events.subscribe(event, options)` without a callback returns an async iterator (`api.events.stream`); the iterator acks the previous event on `next()` — at-least-once, in-flight ≈ 1 for a slow consumer; `signal`/`return()` close it.
- `api.events.on(event, cb)` — a local listener for host-generated envelopes (`window.background.changed`), without RPC and allowlist.

### §J3 — multi-window

- `WindowRoleManager` per (window, installationId): claim + heartbeat over `BroadcastChannel`, leader = min(windowId) among live claims (deterministic), 4 s lease with a 1 s heartbeat, release on stop and pagehide. Without BroadcastChannel → `standalone` (the window is itself primary).
- Kernel slice `windows.role` / `windows.isBackground` + push `window.background.changed`; the listener subscription lives in the session scope — frame teardown releases the claim and stops the manager when there are zero listeners (cleanup, invariant 6).
- New feature flags: `events.cursor = 1`, `windows.multiwindow = 1`.

## Consequences

- Reconnect/crash event recovery: resubscribing with the cursor of the last processed event replays what was missed within the window; outside the window — an explicit `EVENT_CURSOR_EXPIRED`, no silent loss.
- Background work runs in exactly one window; owner changes (primary death, tab closure) are picked up by the rest within the lease.
- Additive contracts: `events.subscribe` with options, `events.ack`, `api.events.on`, `api.events.stream`, `windows.*`, `EVENT_CURSOR_EXPIRED`.
- Examples: `plugins/rev4-events` (live → drop → replay via cursor), `plugins/rev4-multiwindow` (KV counter only at the primary, migrates on primary death).
- Cost: ~200 lines of host + sandbox + SDK code, 2 sample plugins, unit 25/25, e2e +2.

## Migration

No DDL and no breaking changes; the legacy `api.events.subscribe(event, cb)` works as before. Rollback — removal of the slice/manager; plugins without cursor/multiwindow semantics are unaffected.
