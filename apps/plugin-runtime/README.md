# @neotavern/plugin-runtime

A separate Plugin Runtime process. The Main Host launches it as a child
process; inside the Runtime each active plugin is backed by one Worker
(`node:worker_threads`), and inside a Worker there is one SES Compartment
(ADR-0027, ADR-0028).

This is an **infrastructure component of Stage A/B/C** (prototype). The current
state implements:

- the Main Host ↔ Runtime protocol (framed binary IPC, `packages/contracts` §15);
- two-phase Worker bootstrap: `lockdown()` before any plugin code, vetted
  endowments, probe "no Node authority for the plugin";
- supervisor: spawn/terminate Workers, workerEpoch, two-phase termination;
- host client `PluginRuntimeClient` (spawn + handshake + commands + telemetry);
- secure module graph (Stage B, §6, §8.6, §8.9, §40.1.2):
  - `src/graph/moduleGraphBuilder.ts` — signed module graph (BFS, digest,
    resolvedImports, collection of static+dynamic imports, limits, warnings);
  - `src/graph/moduleGraphLoader.ts` — loading the graph into an SES Compartment
    (`resolveHook`/`importHook` serve the graph only, `noAggregateLoadErrors`,
    virtual `neotavern-plugin://` locations in stack traces);
  - `worker-bootstrap.mjs` — the `load-module-graph` bridge command.
- capability broker (Stage C, §10–§12, §26.2.1, §41):
  - `src/broker/capabilityBroker.ts` — the admission core: envelope validation,
    deadline (fail-fast + abort in-flight), service-cycle detection over the
    causal chain A→B→C (`SERVICE_CALL_CYCLE`), revocation overlay
    (`CAPABILITY_REVOKED`, abort in-flight, B14), policy decisions delegated to
    an injectable `BrokerPolicy` (in production — the Main Host broker's state,
    ADR-0027);
  - `src/broker/brokerGateway.ts` — bridge-message bridge: `rpc-request` →
    core → `rpc-response` back to the worker;
  - `src/broker/hostForwardingCore.ts` — relay core (part 9b, ADR-0027):
    an admitted envelope goes host-ward as an `RPC_REQUEST` frame, the
    worker-side promise settles from `RPC_RESPONSE`; admission stays
    protocol-level (shape, deadline, cycles, duplicate requestId, local revoke
    state, in-flight bound), the Main Host makes the decision; revoke
    (BROKER_REVOKE frame), deadline, worker-exit and shutdown abort in-flight
    calls;
  - `worker-bootstrap.mjs` — hardened endowment `bridge.invoke(method, args,
options)` (the plugin's only path to the Broker): builds a BrokerCallRequest
    with identity from workerData (pluginId/installationId/trustLevel),
    constrains method/args/deadline/causal chain, routes the response by
    requestId;
  - supervisor — `trustLevel` in spawn/workerData/record and the
    `onBridgeMessage` hook (the supervisor stays transport-pure, §16.1);
  - `runtime-main.ts` — in the production scheme connects everything:
    `onBridgeMessage` → gateway → forwarding core → `RPC_REQUEST` host-ward;
    handles `RPC_RESPONSE` (routing by requestId, drop on epoch mismatch) and
    `BROKER_REVOKE` → `gateway.revoke`;
  - signed module-graph transport (Stage A, §15.8): the `MODULE_GRAPH` frame
    (0x14, host → runtime) — `runtime-main` checks workerId/epoch and forwards
    the graph to the worker's control port as `load-module-graph`; the
    `BRIDGE_MESSAGE` frame (0x15, runtime → host) — app-level bridge messages
    of the worker (module-graph-loaded/error) that the gateway did not consume
    (`handleBridgeMessage` returns a consumed-bool); the host client gained
    `sendModuleGraph` and the `bridgeMessage` event;
- core SDK layer (Stage D part 1–9, §12 Application/Storage/Models, §18 events,
  §29 network, §31 Core DB):
  - `packages/contracts/src/sdkOps.ts` — contracts for the first operations:
    a method→capability catalog (single source of truth; `capability: null` =
    the §18 events core channel — no grant), TypeBox arg schemas, bounds
    (KV/settings 32 KB, events ring 128/name, 4096 total, TTL 60 s, waiters 64,
    replay limit 64; network URL 2 KB, headers 32 × 8 KB, body 32 KB,
    redirects 8; models.list cap 256; chats list cap 200, cursor 256 bytes;
    characters list cap 200, cursor 256 bytes; lorebook list cap 200, cursor
    256 bytes, entries cap 1000; database.core.query — SQL ≤ 4096 bytes,
    params ≤ 64, rows cap 1000, columns cap 64);
  - `worker-bootstrap.mjs` — typed `sdk` endowment (kv.get/set/delete/list,
    settings.get/set, events.replay, events.subscribe (live async-iterator,
    Stage F: push host→worker via `HOST_BRIDGE_MESSAGE`, bounded fallback to
    replay), events.unsubscribe, network.fetch, models.list,
    chats.list/read, characters.list/read, lorebook.list/read/entries,
    db.query) on top of the bridge: local input validation before the wire,
    validation errors as rejections, value size bounds;
  - `src/host/memoryHost.ts` — reference host-executor: in-memory per-plugin
    KV/settings stores, events ring buffer with cursor/replay (ADR-0025 §J1),
    network fetch with SSRF hardening (§29.1: scheme/IP policy, DNS rebinding,
    redirect re-check) + secret-bound requests (§29.1.5: opaque `secretId`,
    injected headers, bound origin, redirects without secret carry-over),
    models.list via injectable `modelsProvider`,
    chats.list/read via injectable `chatsList`/`chatsRead`,
    characters.list/read via injectable `charactersList`/`charactersRead`,
    lorebook.list/read/entries via injectable `lorebooksList`/
    `lorebookRead`/`lorebookEntries`,
    database.core.query via injectable `dbQuery` with a host-side SQL gate
    (§31: one read-only SELECT/WITH statement, write verbs →
    `POLICY_DENIED`, primitive cells, rows/columns cap),
    grants per §12, capability/method mismatch → `POLICY_DENIED`, unknown
    method → `PROTOCOL_UNSUPPORTED`, defense-in-depth args validation
    (`VALIDATION_FAILED`), bounded waiters (`SERVICE_UNAVAILABLE`), wait
    clamped to the broker deadline. In production it is replaced by the host
    policy `apps/server/src/plugin/vnextBroker.ts` (part 9, ADR-0027);
  - `src/host/networkPool.ts` — §29 transport: keep-alive pool on
    `http.Agent`/`https.Agent` (bounded per-origin, idle TTL), executor-level
    HTTP(S) proxy (absolute-form for http, CONNECT tunnel for https),
    `close()` releasing idle sockets, pool metrics. Verified-IP connects
    (ТЗ §SEC-03) honor the policy-approved set on EVERY path: direct connects
    use the approved IP (hostname only in Host/SNI) and verify the connected
    `remoteAddress`; proxy hops carry the verified IP in the absolute-form
    request-target (HTTP) and in the CONNECT authority (HTTPS, with TLS still
    validating the hostname);
  - `src/host/memoryHost.ts` — reference host executor. In-flight network
    byte budgets (ТЗ §SEC-04): while a fetch body is streamed its worst-case
    size is reserved against
    `NETWORK_MAX_INFLIGHT_BYTES_PER_PLUGIN` (16 MiB) and
    `NETWORK_MAX_INFLIGHT_BYTES_GLOBAL` (64 MiB); a request that would exceed
    either fails with the stable `NETWORK_INFLIGHT_LIMIT` before its body is
    read, and the reservation releases on success/error/cancel.

Deliberately NOT implemented at this stage (Stage D part 9c → G):

- activation of v3 backends by spawning the runtime from the plugin manager:
  the Main Host broker host (`apps/server/src/plugin/vnextBrokerHost.ts`,
  part 9c) is ready — `createPluginRuntimeTransport`/`attachVNextBrokerHost`
  adapt `PluginRuntimeClient`; the spawn/worker lifecycle itself is Stage A;
  subprocess e2e host-ward RPC (needs graph transport over frames — comes
  with graph loading in Stage A);
- live-delivery events subscribe/iterator (currently pull-based replay; full
  streaming is Stage F);
- keep-alive/pooling + proxy (executor-level `proxyUrl`) + secret injection
  (§29) — implemented in Stage F part 15 (`src/host/networkPool.ts`,
  `MemoryHostOptions.networkSecrets` / `proxyUrl`); remaining —
  `network.local`/`network.private`/`network.metadata` scope capabilities
  (§29.1.1);
- producer-side streaming reads of large bodies from executors (currently the
  §17 stream chunks an already-encoded body; buffering at the endpoints
  remains);
- full SDK over the bridge (files/network/process/jobs/secrets, Stage E);
- Plugin Runtime restart after a crash (Stage A, §20.13).

## Public entry points

- `src/runtime-main.ts` — entry point of the Runtime process (bin
  `neotavern-plugin-runtime`).
- `src/index.ts` — exports the supervisor, the host client, the broker cores
  (`createCapabilityBrokerCore`, `createHostForwardingCore`,
  `createBrokerGateway`, `assertBrokerCallShape`, `toBrokerError`,
  `BrokerCallError`, `BrokerErrorCode`) and the reference host
  executor (`createMemoryHostExecutor`).
- `worker-bootstrap.mjs` — trusted Worker bootstrap (runs only as
  `new Worker(...)`; not imported from TypeScript).
- `consoleSink.mjs` — bootstrap TCB code: bounded formatter (§9.1.2), ring and
  credit machine (§9.1.1); imported only from `worker-bootstrap.mjs`.

## Protocol

The wire format (hot header, frame types, codec, ErrorEnvelope) is defined in
`@neotavern/contracts` (`pluginRuntime.ts`) and is the single source of truth.
Channel topology (§15.9): fd0/fd1 = control, fd3/fd4 = data, fd2 = stderr
diagnostics. Data channels work since Stage F: the runtime has its own bounded
outbox and bulk-parser on fd3/fd4 (cap 256 MiB), the client has fd3 (writes)
and fd4 (reads, the `dataFrame` event, opaque). Data-channel consumers are the
frames `MODULE_GRAPH_DATA` (0x17, part 11), `RPC_RESPONSE_DATA` (0x18, part 12),
`RPC_REQUEST_DATA` (0x19, part 13) and `RPC_RESPONSE_STREAM` (0x1a, part 14):
module graphs, broker-call results and their arguments that do not fit the
control path travel over the data channel; routing (control vs data) lives in
`PluginRuntimeClient.sendModuleGraph`/`sendRpcResponse` and in
`invokeBrokerCall` (worker), the only decode points are the worker (graph,
response) and the host client (request args) respectively (§15.1). The reverse
direction (fd 4, runtime → host) is a working producer: serialized outbox with
drain backpressure (≤ 8 queued frames, otherwise the call fails with
backpressure); on Windows data sockets open one-way
(`readable:false, writable:true` — a pending read on the named-pipe handle
blocks writes to the same socket).

### §17 credit streams (part 14)

An encoded response body larger than one chunk (256 KiB) travels in
`RPC_RESPONSE_STREAM` frames (≤ 256 KiB): each payload is
`header JSON + NUL + raw chunk` (`{ requestId, seq, final }`; NUL is safe,
JSON text contains no raw NULs). The runtime forwards the payload opaque; the
worker is the only assembly and decode point (§15.1), the accumulator is
bounded at 16 MiB. Credit flow: initial window = 1 chunk; after each consumed
chunk the worker sends `{ kind: 'rpc-stream-credit', requestId, bytes }`
(via the BRIDGE_MESSAGE 0x15 path; the host client intercepts it and does not
re-emit it as app-level); the producer does not create the next chunk without
a free window. The host-side stream registry is bounded (16); overflow is a
broker error. Host side — `src/host/responseStreamer.ts` (unit-testable credit
machine), diagnostics —
`PluginRuntimeClient.responseStreamFrameCount/ByteCount`. Bodies are still
buffered at the endpoints (producer-side streaming reads from executors are a
separate follow-up).

### §9.1.1 console channel (part 17)

A single `console.log()` does NOT create a separate transport message. The
Worker contains a `BoundedConsoleSink` (`consoleSink.mjs`, TCB code does not
run before lockdown): bounded formatter (§9.1.2: depth/keys/items/string/
record/stack bounds; getters are not invoked; proxy/getter failures →
placeholder) + fixed 64 KiB ring (coalesces identical records; overflow →
`droppedCount`; no secondary queue behind the ring). Batch flush (threshold
4 KiB, interval 100 ms, forced on terminate) encodes the payload in the
worker ONCE and sends `LOG_BATCH` (0x1b, ≤16 KiB / ≤256 records); the runtime
forwards the payload opaque, the host decodes once (§15.1). Credits: 8
initial, acks (`LOG_BATCH_ACK` 0x1c) replenish up to 64; without a credit the
worker does not accumulate payload (the ring remains the only buffer). When
`droppedCount > 0` the host MUST emit the synthetic record
`[NT] N plugin log records suppressed` (rule 9) and always ack. Fatal
diagnostics (`FATAL_DIAGNOSTIC` 0x1d) go over a separate non-preemptible path:
`uncaughtException`/`unhandledRejection` → bounded envelope + stderr line;
until `module-graph-loaded/-error` is sent, the worker lives on to report and
then `exit(1)` (§26.1.3/§26.1.4); the runtime keeps the last envelope and
attaches it to `WORKER_TERMINATED`. Host router: `VNextRuntimeService` options
`logSink`/`fatalSink`; `pluginId` attribution, levels
`debug|log|info|warn|error|trace`; the legacy `kind:'log'` bridge variant is
kept in the schema, but the new sink does not emit it.

### §22 Emergency resource boundary (part 19)

Node Worker `resourceLimits` is only an emergency ceiling, not a quota (§21).
`src/emergencyLimits.ts` computes the ceiling at each spawn from the actual
headroom: `free memory × 0.75 − runtime RSS − live workers × 256 MiB`, clamped
to [256 MiB, 4 GiB]; the manifest hint (`memoryHintMiB`, §38) raises the
ceiling toward the declared need; the admin override (`maxHeapOverrideMiB`,
§39) wins over everything; young gen = old/4 in [64, 512]. Priority:
per-spawn caps → supervisor static config → headroom. The fields
`memoryHintMiB`/`maxHeapOverrideMiB` travel in WORKER_SPAWN (additively); the
trusted bootstrap reports the actual `worker_threads.resourceLimits` in
hardened-ready → `emergencyLimits` in WORKER_READY and
`VNextWorkerInfo.emergencyLimits` (diagnostics §40).

### §6.5/§6.6 SES Compatibility Corpus (part 20, B25)

`src/corpus/` — versioned corpus of real pure-JS packages, each imported at a
real production boundary (Worker + `lockdown(moderate)` + one Compartment).
`corpus-manifest.json` pins the expectations (`expect: pass|fail`,
`expectedError`, reason); `loadCorpusPackage.ts` — the first step of
dependency-vendoring (§7.2): the package and its transitive bare dependencies
are vendored into `node_modules/<pkg>/...`, bare imports are rewritten to
relative paths (archive boundaries §8.7). The gate (`corpus.test.ts`) is
mandatory on every Node/SES/@endo upgrade (§6.6).

### §8.1 Persistent module-map cache (part 21)

`src/graph/moduleMapCache.ts` — disk cache of built module graphs.
`packageSourceDigest` (sha256 over the package's sorted files) + the
Node/SES/@endo-module-source/@neotavern-plugin-runtime versions form the key:
any component upgrade invalidates the cache, the canonical source is the only
source of truth (compiled records are not a Plugin ABI). The write is atomic
(temp + rename), a corrupt/unknown entry is a miss (the cache is deleted and
self-heals, §20). Host: `createVNextRuntimeService({ moduleMapCacheDir })` —
buildGraph checks the cache first; server wire: `data/cache/plugin-module-maps`.

### §30 Files API (part 22, Stage E)

`files.read` / `files.write` / `files.stat` / `files.list` / `files.rename`
/ `files.remove` under the `files.plugin` capability. All operations are
confined to the plugin-owned data directory: `filesRoot(pluginId)`
(production: `join(pluginsRoot, pluginId, 'data')`), absolute paths / drive
letters / backslashes / `..` segments are rejected by the SDK and the host,
symlink escape is closed by a repeated `realpath` check, writes are atomic
(temp + rename), reads bounded at 4 MiB, list without symlink entries. SDK:
`sdk.files.*`.

### §29 Socket API (part 23, Stage E)

`network.websocket` / `network.tcp` / `network.listen` / `network.udp` through
the Broker (capability per family). `src/host/socketHandles.ts` — trusted
sockets host-side: the plugin holds only an opaque handle id; bounded message
ring per handle (§17: 128 messages, 64 KiB/message, 8 MiB buffer,
evict-oldest); receive/accept with bounded wait; destination policy — the same
§29.1 SSRF check as for http (loopback requires `network.local`, etc.); §SEC-03
verified-IP connects: tcpConnect/udpSend AND the WebSocket client (RFC 6455
framing implemented in `socketHandles.ts` — undici's WebSocket does not expose
the connected socket, so the client owns the socket end to end and connects to
the policy-approved address, verifies `remoteAddress` after connect and
performs the HTTP Upgrade itself; hostname survives only in Host/SNI);
bind policy §29.1.4 — default loopback, `0.0.0.0`/`::` are forbidden,
non-loopback binds require `network.listen.public`; revoking a network
capability closes the plugin's handles (§10.2). SDK:
`sdk.network.websocket/tcp/listen/udp`.

### §13/§32 Process API (part 24, Stage E)

`process.spawn` / `process.output` / `process.signal` / `process.wait` /
`process.close` through the Broker. `src/host/processHandles.ts` — trusted
children host-side: always `shell:false` + `detached:false` + sanitized env
(§32.1); scoped mode — executable and cwd per host policy (`processScope`),
mismatch → `PROCESS_SCOPE_DENIED`; unrestricted mode — only with the
`system.unrestricted` grant, otherwise `SYSTEM_UNRESTRICTED_REQUIRED` (§32.2);
bounded output ring (§32.4); timeout → SIGKILL; `kill()` — immediate children
only (descendant containment is not guaranteed, §32.3); revoking a process
capability kills the children (§10.2). SDK: `sdk.process.*` (bare executable
refused).

### §19/§27 Jobs API (part 25, Stage E)

`jobs.register` / `jobs.cancel` / `jobs.list` through the Broker. Host-side
scheduler in `src/host/memoryHost.ts`: timers live in the trusted host, the
Worker holds no resident interval (§19); `jobPushSink(pluginId, envelope)` —
injectable sink delivering `{ kind: 'job-run', envelope }` to the job's
owner; `JOBS_MAX_PER_PLUGIN` (8), `JOBS_MIN_INTERVAL_MS` (100), payload
≤ 64 KiB; revoking `jobs.background` cancels the plugin's timers (§10.2). The
broker host (`vnextBrokerHost.ts`) keeps a `jobWorkers` map — registered on a
successful `jobs.register` RPC, cleaned in `workerTerminated`, pushes to a
dead Worker are dropped. SDK: `sdk.jobs.register/cancel/list` +
`sdk.jobs.onRun(callback)` (the callback is bound via the `onRun` token in
`register`, dispatched over the `job-run` bridge).

### §34 Services API (part 26, Stage E)

`services.provide` / `services.connect` / `services.respond` through the
Broker. Host-side registry name@version → provider plugin in
`src/host/memoryHost.ts`; connect checks the §26.2.1 causal chain (provider
already on the path → `SERVICE_CALL_CYCLE` before the push), pending calls are
bounded (64) and deadline-bounded (`OPERATION_DEADLINE`, the abort reason is
propagated); push via `serviceCallSink(pluginId, envelope)` → broker host
(`vnextBrokerHost.ts`, `workerByPlugin` map) → `service-call` bridge →
provider handler → `services.respond` settles the caller; a foreign respond
is an idempotent { ok:false }; revoking a services capability drops the
registrations and settles in-flight calls (§10.2). SDK:
`sdk.services.provide(options, handler)` + `sdk.services.connect(...)`; the
chain is passed as received, the host appends the caller id on push. No direct
JS references between Compartments.

### §33 Secrets API (part 27, Stage E)

`secrets.use` / `secrets.manageOwn` / `secrets.reveal` through the Broker.
The executor (`src/host/memoryHost.ts`) calls the injectable `secretsProvider`
(host side); the token never leaves the Main Host — `use` returns an opaque
`sec-…` handle bound to the origin of the connect, the handle works as a
`network.fetch` secretId (§29.1.5: Authorization injection host-side, foreign
origin → NETWORK_SECRET_ORIGIN_MISMATCH, foreign plugin →
NETWORK_SECRET_NOT_FOUND); `reveal` — only `trusted` + grant (§11.3),
otherwise TRUST_REQUIRED. Host: `createHostSecretsProvider(ctx)` in
`vnextBrokerHost.ts` on the OAuth repository (authConnections, ADR-0016),
bound origin from the manifest `authClients.authorizationUrl` or the
injectable `secretOriginResolver`; revoking a secrets capability closes the
handles (§10.2). SDK: `sdk.secrets.use/manageOwn/reveal` + fail-fast
validation.

## Dependencies

- `ses` — lockdown/Compartment (version-pinned).
- `@neotavern/contracts` — the protocol, module-graph schemas
  (`pluginModule.ts`) and the capability broker (`capabilityBroker.ts`).
- `@endo/module-source` — `ModuleSource` (compiling modules with virtual
  `neotavern-plugin://` locations).
- `@babel/parser` — collecting dynamic-import specifiers at the builder stage
  (ModuleSource does not expose dynamic imports).

## §9.1 Compatibility profile

Besides the vetted endowments (console/Text/URL/Abort/queueMicrotask/bridge/
sdk) the Compartment receives standard SES intrinsics. Documented
limitations:

- `Float32Array`/`Float64Array` are absent from global: SES excludes them from
  compartments (NaN side-channel, `ses/src/permits.js`). Plugins need
  `Uint8Array`/`DataView` for float data (B05/B26).
- Top-level await is not supported (see "Limitations").
- `SharedArrayBuffer` and raw `WebAssembly` are not endowed (§9.1.8/§14).

## Benchmarks (§47, Stage I, M6)

```bash
node apps/plugin-runtime/bench/bench-vnext.mjs            # B01–B31, gates §46
node apps/plugin-runtime/bench/bench-vnext.mjs --heavy    # + B05/B07/B10 (>1 GiB)
node apps/plugin-runtime/bench/bench-vnext.mjs --json out.json
```

The harness runs the measurable scenarios B01–B05/B07/B08/B10/B19–B22/B26–B31
against the public dist API and checks them against the §46 SLO gates;
scenarios already covered by dedicated regression tests (B06, B09, B11–B18,
B23–B25, B32, B43–B47) are mapped to the corresponding test files and checked
for existence. Gates are overridden via `BENCH_GATE_*`. The numbers are
regression gates, not quotas (§21/§46).

## Limitations

- Worker env is minimal (no `NODE_OPTIONS`, secrets, `SHARE_ENV`).
- `execArgv: []`, `eval: false`, workerData — small identifiers only
  (§5.5, §15.8).
- A Worker is never reused between plugins (§5.7).
- In production Worker/`--inspect`/`--require`/`--import` are forbidden
  (§5.6); the Main Host MUST strip `NODE_OPTIONS` when spawning the Runtime.
- The SES Compartment does not support top-level await: import-time broker
  calls settle after `import()`; `module-graph-loaded` is deferred until they
  finish (bounded by `BROKER_IMPORT_CALL_DRAIN_MS = 5000`, §10 path in the
  prototype).

## Development

```bash
pnpm install
pnpm --filter @neotavern/plugin-runtime build
pnpm --filter @neotavern/plugin-runtime typecheck
pnpm test -- plugin-runtime   # vitest: codec + spawn integration
```

## Stage integration

Connecting the Runtime to `apps/server` (spawning from the plugin manager,
RPC routing, events) is the Stage A step. Individual contracts are not moved
into `apps/server` until the Runtime stabilizes at the protocol level.
