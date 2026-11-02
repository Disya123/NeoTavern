# ADR-0060: App events on the canonical plane are a durable cursor, not an SSE relay

Date: 2026-11-09. Status: **Accepted**.
Related: [ADR-0038](0038-canonical-rust-kernel-core.md) (canonical Rust Kernel),
[ADR-0043](0043-web-client-remote-only.md) (remote Web Client rules),
[ADR-0059](0059-react-primary-pivot.md) (React contour is the product UI),
[wire-contracts](../architecture/wire-contracts.md),
[etap4 registry](../architecture/etap4-ui-cutover-registry.md) (cluster 18).

## Context

The legacy contour relays application events to browsers over one SSE
endpoint, `GET /api/v2/events`. Its producer is an in-memory event bus inside
the Fastify sidecar: the relay forwards a whitelist of names
(`chat.created`, `chat.message.*`, `generation.finished|error`, `plugin.*`,
`chat.message.block.changed`) and two subscribers consume them — the shell
subscriber that invalidates TanStack Query caches, and the plugin runtime that
relays events into sandboxed plugin frames.

That design assumes the process that mutates data is the process that holds
the subscription. On the canonical plane it is not true:

- the Kernel is the **single writer**, and every client (desktop WebView,
  Android WebView, remote Web Client, a second desktop tab) is a separate
  subscriber over a different transport (Tauri IPC, JNI, HTTP);
- an in-memory broadcast only reaches clients that happened to be connected at
  the moment of the mutation, so a reconnect, a backgrounded mobile client or
  a reloaded tab silently misses state changes — precisely the staleness the
  channel exists to prevent;
- there is no host-native HTTP surface on the local transports, so a
  kernel-side SSE endpoint would only work for the remote Web Client and would
  need a second, different mechanism for desktop and Android.

The cluster-15 message-block slice already documented the consequence: block
changes were visible to the client that made them and on the next load, but
never pushed, because "the kernel event plane is cluster 18".

## Decision

1. **The canonical event plane is a durable, append-only log.** Migration v26
   (`026_app_events`) adds the STRICT table `app_events(sequence INTEGER
PRIMARY KEY AUTOINCREMENT, event, payload_json, created_at)`. Every
   client-relevant mutation appends its event **inside the same transaction as
   the data change**, so no client can observe an event without its data
   change, and no data change can commit without its event.
2. **The wire exposes a cursor, not a socket.** Operation `events.poll`
   (`app.read`, idempotent, safe) takes an exclusive `afterSequence` and
   returns a page of `wire.app-event` items plus `hasMore` (a backlog larger
   than one page) and `truncated` (the cursor aged out of retention). Clients
   echo the last `sequence` they saw; `-1` means "everything still retained".
3. **Payloads are id-only.** An event carries the ids a subscriber needs to
   choose caches (`chatId`, `messageId`, `runId`, `pluginId`, `status`) and
   never message text, prompts, secrets or provider errors. The subscriber
   re-reads whatever it needs through the normal read operations.
4. **Retention is bounded and pruning is part of the writer.** The log keeps
   2048 rows; the writer prunes older rows in the same transaction. A caller
   whose cursor fell out of the window gets `truncated: true` and is expected
   to reset its caches instead of assuming a complete stream.
5. **Push is a host concern, not a contract.** A host may poll, bridge the
   cursor to SSE, or forward it into the plugin sandbox. The shipped React
   contour polls (`startAppEventPolling`, default 2 s, immediate drain while
   `hasMore`, exponential backoff on failure without losing the cursor).
   Building a host-native push transport is a separate, optional optimization.

## Alternatives considered

- **In-memory broadcast channel in the Kernel** (mirror of the legacy bus).
  Rejected: it cannot deliver events across a reconnect or to a client that
  was not connected, and it duplicates durable state that already exists.
- **Kernel-hosted SSE endpoint.** Rejected for now: desktop and Android
  transports are not HTTP, so it would only serve the remote Web Client while
  adding a second mechanism and a new lifecycle (connections, heartbeats,
  cancellation) to the Kernel process.
- **Long-polling on the wire.** Rejected: it buys latency the 2 s poll already
  provides for cache invalidation, at the cost of holding a Kernel dispatch
  slot and defining cancellation semantics for a read.
- **Reusing `generation.events`.** Rejected: that log is per-run and owned by
  the generation pipeline; app events are cross-domain and have their own
  cursor space.

## Consequences

- Delivery is **at-least-once** and resumable; duplicates are harmless because
  every consumer action is an idempotent cache invalidation.
- Invalidation latency is bounded by the poll interval (2 s by default) and by
  the drain loop for backlogs. Streaming generation output keeps its own
  dedicated stream and is not affected.
- The event set is deliberately narrower than the legacy whitelist:
  `chat.created`, `chat.message.created|updated|deleted`,
  `chat.message.block.changed`, `generation.finished|error`,
  `plugin.installed|activated|disabled|deleted`. `chat.opened`,
  `character.selected` and `generation.delta` are not published — the first two
  are UI-local selections, the third belongs to the run stream.
- A cancelled run publishes `generation.finished` with
  `status: "cancelled"`, so subscribers invalidate the same caches they would
  for a completed run.
- Cross-client `chat.message.block.changed` sync is now real: the plugin
  bridge's existing `runtime.onAppEvent` handler is fed by the same log (this
  closes the boundary cluster 15 documented).
- The log is one small row per mutation; growth is bounded by retention, and
  the table is covered by the regular backup/restore path.
