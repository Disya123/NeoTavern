/**
 * Core SDK operation contracts (ТЗ Plugin SDK vNext v3.2 §12 catalog,
 * Stage D prototype).
 *
 * The first capability operations on the new runtime are typed here: args
 * schemas, per-operation capability mapping (single source of truth for the
 * worker-side SDK, the runtime gateway and the host executor) and value
 * bounds. Each operation crosses the worker boundary as a `BrokerCallRequest`
 * (§10.1) whose `capability.name` comes from this catalog; the host executor
 * dispatches on `method` and enforces the same schemas.
 *
 * Value payloads still ride the control path in this prototype; Stage F
 * (streaming audit) moves them to transferable buffers (§55), so the value
 * bounds here match the current broker args cap.
 */
import { Type, type Static } from '@sinclair/typebox';
import { IdSchema } from './common.js';
import { CharacterSchema, CharacterSummarySchema } from './character.js';
import { ChatSchema, ChatSummarySchema } from './chat.js';
import { LorebookEntrySchema, LorebookSchema } from './lorebook.js';
import { ModelInfoSchema } from './provider.js';

/** Max byte length of one KV key. */
export const SDK_MAX_KV_KEY_BYTES = 512;
/** Max serialized byte length of one KV value (data-pipe transport since
 * Stage F part 13: large values ride RPC_REQUEST_DATA frames, §15.9). */
export const SDK_MAX_KV_VALUE_BYTES = 8 * 1024 * 1024;
/** Max byte length of a settings path. */
export const SDK_MAX_SETTINGS_PATH_BYTES = 256;
/** Max serialized byte length of one settings value (data-pipe transport
 * since Stage F part 13). */
export const SDK_MAX_SETTINGS_VALUE_BYTES = 8 * 1024 * 1024;

// Events channel bounds (§18, ADR-0025 §J1, ТЗ §41). The event ring is
// bounded algorithmic storage on the host, not a plugin resource quota.
/** Max buffered events per event name. */
export const EVENTS_PER_NAME = 128;
/** Max buffered events across all names (FIFO global eviction). */
export const EVENTS_TOTAL = 4096;
/** TTL of a buffered event; older entries are swept lazily. */
export const EVENTS_TTL_MS = 60_000;
/** Max concurrent replay waiters (bounded waiter records, §18). */
export const EVENTS_MAX_WAITERS = 64;
/** Max events returned by one replay call. */
export const EVENTS_MAX_REPLAY_LIMIT = 64;
/** Max wait inside one replay call (the broker deadline still applies). */
export const EVENTS_MAX_WAIT_MS = 5_000;
/** Max byte length of an event name. */
export const EVENTS_MAX_NAME_BYTES = 128;
/** Max live subscriptions per plugin (bounded registrations, §18; excess
 * fails with SERVICE_UNAVAILABLE like the waiter cap). */
export const EVENTS_MAX_SUBSCRIPTIONS_PER_PLUGIN = 8;

// Network fetch bounds (§29). Responses larger than the control path travel
// the data pipe as RPC_RESPONSE_DATA frames (Stage F part 12, §15.9); the
// body is still buffered whole in the host executor — true chunked streaming
// arrives with §17 credit streams.
/** Max byte length of a request URL. */
export const NETWORK_MAX_URL_BYTES = 2048;

// Files API bounds (§30, Stage E). All file operations are scoped to the
// plugin-owned data directory (`files.plugin` capability); paths are
// relative, `..` segments and absolute paths are rejected both in the SDK
// and in the host executor. Large files are read/written as whole bounded
// strings on the control path in this prototype; §17 streaming arrives with
// the Stage F data pipes.
/** Max byte length of a plugin-relative file path. */
export const FILES_MAX_PATH_BYTES = 1024;
/** Max byte length of one file read/write payload. */
export const FILES_MAX_CONTENT_BYTES = 4 * 1024 * 1024;
/** Max entries returned by one `files.list` call. */
export const FILES_MAX_LIST = 1000;

// Socket API bounds (§29 Stage E: websocket / tcp / listen / udp). All
// socket buffers are bounded algorithmic storage on the host (§17): a fixed
// message ring per handle with a byte budget; excess messages drop the
// oldest. Handles are bound to the owning plugin and closed on revoke or
// executor shutdown.
/** Max live socket/listen handles per plugin. */
export const NETWORK_MAX_SOCKET_HANDLES = 32;
/** Max messages buffered per handle. */
export const NETWORK_MAX_SOCKET_MESSAGES = 128;
/** Max byte length of one socket message (send or receive). */
export const NETWORK_MAX_SOCKET_MESSAGE_BYTES = 64 * 1024;
/** Max total buffered bytes per handle (ring eviction budget). */
export const NETWORK_MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
/** Max messages returned by one receive call. */
export const NETWORK_MAX_SOCKET_RECEIVE = 64;
/** Max wait inside one receive/accept call (broker deadline still applies). */
export const NETWORK_SOCKET_WAIT_MS = 5_000;
/** Max byte length of a socket handle id. */
export const NETWORK_MAX_SOCKET_ID_BYTES = 64;
/** Max byte length of a hostname in socket calls. */
export const NETWORK_MAX_SOCKET_HOST_BYTES = 255;
/** Max number of websocket subprotocols. */
export const NETWORK_MAX_WS_PROTOCOLS = 8;

// Process API bounds (§13/§32 Stage E). Spawn is always shell-free and
// detached-free; scoped mode (§32.1) confines executable + cwd, unrestricted
// mode (§32.2) requires the separate `system.unrestricted` capability.
// Output streams are bounded rings (§32.4) — a flood never grows in RAM.
/** Max byte length of an executable path (absolute). */
export const PROCESS_MAX_EXECUTABLE_BYTES = 1024;
/** Max number of spawn arguments. */
export const PROCESS_MAX_ARGS = 64;
/** Max byte length of one argument. */
export const PROCESS_MAX_ARG_BYTES = 1024;
/** Max number of environment entries a plugin may pass. */
export const PROCESS_MAX_ENV = 64;
/** Max byte length of an environment key. */
export const PROCESS_MAX_ENV_KEY_BYTES = 128;
/** Max byte length of an environment value. */
export const PROCESS_MAX_ENV_VALUE_BYTES = 4096;
/** Max byte length of a working directory. */
export const PROCESS_MAX_CWD_BYTES = 1024;
/** Max wall-clock timeout for one process (0 = no timeout). */
export const PROCESS_MAX_TIMEOUT_MS = 3_600_000;
/** Max live processes per plugin. */
export const PROCESS_MAX_HANDLES = 16;
/** Max output chunks returned by one output call. */
export const PROCESS_MAX_OUTPUT_CHUNKS = 64;
/** Max byte length of one output chunk. */
export const PROCESS_MAX_CHUNK_BYTES = 64 * 1024;
/** Max total buffered output bytes per process (ring eviction, §32.4). */
export const PROCESS_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
/** Max wait inside one output/wait call (broker deadline still applies). */
export const PROCESS_WAIT_MS = 5_000;

// Jobs bounds (§19/§27 Stage E). Jobs live in the Host scheduler: the
// plugin registers a schedule and the host fires `job-run` pushes to the
// owning worker (§19: job due → deliver → worker handles it). No cron
// parser in the prototype: interval (repeating) and at (one-shot delay).
/** Max byte length of a job name. */
export const JOBS_MAX_NAME_BYTES = 128;

// Services bounds (§34 Stage E). Cross-plugin calls are brokered: the host
// resolves name@version to the provider plugin and pushes a `service-call`
// bridge message to its worker; the provider answers with `services.respond`
// and the host settles the caller's `services.connect`. Payloads ride the
// control path, so they stay well below the §15.11 frame bound (64 KiB).
/** Max byte length of a service name. */
export const SERVICES_MAX_NAME_BYTES = 128;
/** Max byte length of a service version string. */
export const SERVICES_MAX_VERSION_BYTES = 64;
/** Max number of declared methods per service. */
export const SERVICES_MAX_METHODS = 32;
/** Max byte length of one method name. */
export const SERVICES_MAX_METHOD_BYTES = 128;
/** Max JSON byte length of a service call args or result payload. */
export const SERVICES_MAX_PAYLOAD_BYTES = 16 * 1024;
/** Max in-flight service calls per plugin (deadline-bounded, §34 deadlines). */
export const SERVICES_MAX_PENDING = 64;

// Secrets bounds (§33 Stage E). Connections live in Main Host (OAuth repo);
// `secrets.use` mints an opaque handle bound to the connection's origin
// (§29.1.5), `secrets.manageOwn` lists the plugin's own redacted
// connections, `secrets.reveal` returns the raw token and requires the
// trusted level (§11.3). Handles are bounded registrations, not quotas.
/** Max byte length of a connection id. */
export const SECRETS_MAX_CONNECTION_ID_BYTES = 64;
/** Max byte length of an opaque secret handle. */
export const SECRETS_MAX_HANDLE_BYTES = 128;
/** Max live secret handles per plugin. */
export const SECRETS_MAX_LIVE = 16;
/** Max connections returned by one manageOwn list. */
export const SECRETS_MAX_LIST = 100;
/** Max serialized byte length of a job payload. */
export const JOBS_MAX_PAYLOAD_BYTES = 64 * 1024;
/** Max registered jobs per plugin (bounded registrations, §19). */
export const JOBS_MAX_PER_PLUGIN = 8;
/** Minimum repeating interval (ms). */
export const JOBS_MIN_INTERVAL_MS = 100;
/** Max repeating interval (ms; setTimeout int32 bound). */
export const JOBS_MAX_INTERVAL_MS = 2_147_483_647;
/** Max one-shot delay (ms). */
export const JOBS_MAX_AT_MS = 2_147_483_647;
/** Max number of request headers. */
export const NETWORK_MAX_HEADERS = 32;
/** Max byte length of a header name. */
export const NETWORK_MAX_HEADER_NAME_BYTES = 128;
/** Max byte length of a header value. */
export const NETWORK_MAX_HEADER_VALUE_BYTES = 8 * 1024;
/** Max byte length of a request/response body (data-pipe transport). */
export const NETWORK_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Max redirect hops followed by the host executor (§29.1.3). */
export const NETWORK_MAX_REDIRECTS = 8;
/**
 * §SEC-04 in-flight byte budgets. While a fetch body is being streamed
 * (`readBoundedText`) its bytes are held host-side; the sum of ALL bodies
 * currently in flight across a single plugin must stay under the per-plugin
 * budget, and the sum across every plugin under the global budget. Exceeding
 * either is a stable `NETWORK_INFLIGHT_LIMIT` error thrown BEFORE the excess
 * body is read (the response is destroyed, never partially buffered).
 * `NETWORK_MAX_BODY_BYTES` is the reservation per in-flight body (the worst
 * case for a single body); the budgets below cap how many such bodies may be
 * streamed concurrently before one finishes.
 */
export const NETWORK_MAX_INFLIGHT_BYTES_PER_PLUGIN = 16 * 1024 * 1024;
export const NETWORK_MAX_INFLIGHT_BYTES_GLOBAL = 64 * 1024 * 1024;
/**
 * §29.1.1 scope capabilities: `network.http` alone permits only public
 * Internet addresses. Loopback, RFC1918/link-local, cloud metadata and other
 * non-public destinations require these ADDITIONAL capabilities (granted to
 * the plugin alongside `network.http`):
 */
export const NETWORK_SCOPE_LOCAL = 'network.local';
export const NETWORK_SCOPE_PRIVATE = 'network.private';
export const NETWORK_SCOPE_METADATA = 'network.metadata';
/** The stable scope capability names a plugin may hold (§29.1.1). */
export const NETWORK_SCOPE_CAPABILITIES: readonly string[] = [
  NETWORK_SCOPE_LOCAL,
  NETWORK_SCOPE_PRIVATE,
  NETWORK_SCOPE_METADATA,
];

/**
 * Effective network reach of one plugin at one moment (§29.1.1). Computed
 * host-side from the plugin's grants; the destination policy allows a
 * non-public address only when the matching scope flag is set.
 */
export interface NetworkScope {
  /** Loopback (`127/8`, `::1`, `0.0.0.0/8`) and local schemes. */
  local: boolean;
  /** RFC1918, link-local, ULA, multicast/reserved ranges. */
  private: boolean;
  /** Cloud metadata/link-local endpoints (`169.254.169.254`, `169.254.170.2`). */
  metadata: boolean;
}

/** Default scope for `network.http` without any scope capability. */
export const DEFAULT_NETWORK_SCOPE: Readonly<NetworkScope> = Object.freeze({
  local: false,
  private: false,
  metadata: false,
});
/**
 * Max byte length of an opaque secret handle (`args.secretId`, §29.1.5).
 * The plugin never sends secret values — only a handle the host executor
 * resolves against its own secret registry and injects at request time.
 */
export const NETWORK_MAX_SECRET_ID_BYTES = 128;
/** §29 keep-alive/pooling: max concurrent sockets per origin (direct). */
export const NETWORK_POOL_MAX_SOCKETS_PER_ORIGIN = 6;
/** §29 keep-alive/pooling: max idle keep-alive sockets kept per origin. */
export const NETWORK_POOL_MAX_FREE_SOCKETS = 4;
/** §29 keep-alive/pooling: idle keep-alive socket TTL. */
export const NETWORK_POOL_KEEP_ALIVE_MS = 60_000;
/** §29 keep-alive/pooling: socket connect timeout for pooled fetches. */
export const NETWORK_POOL_CONNECT_TIMEOUT_MS = 10_000;

export const SdkNetworkFetchArgsSchema = Type.Object(
  {
    url: Type.String({ minLength: 1, maxLength: NETWORK_MAX_URL_BYTES }),
    method: Type.Optional(
      Type.Union([
        Type.Literal('GET'),
        Type.Literal('POST'),
        Type.Literal('PUT'),
        Type.Literal('PATCH'),
        Type.Literal('DELETE'),
        Type.Literal('HEAD'),
      ]),
    ),
    headers: Type.Optional(
      Type.Record(
        Type.String({ minLength: 1, maxLength: NETWORK_MAX_HEADER_NAME_BYTES }),
        Type.String({ maxLength: NETWORK_MAX_HEADER_VALUE_BYTES }),
      ),
    ),
    body: Type.Optional(
      Type.Union([Type.String({ maxLength: NETWORK_MAX_BODY_BYTES }), Type.Null()]),
    ),
    redirect: Type.Optional(Type.Union([Type.Literal('follow'), Type.Literal('manual')])),
    /**
     * Opaque secret handle (§29.1.5 secret-bound requests): the host executor
     * injects the secret's headers at request time and refuses destinations
     * outside the secret's bound origin; redirects never carry the secret to
     * another origin. The plugin never sees the secret value.
     */
    secretId: Type.Optional(Type.String({ minLength: 1, maxLength: NETWORK_MAX_SECRET_ID_BYTES })),
  },
  { additionalProperties: false },
);
export type SdkNetworkFetchArgs = Static<typeof SdkNetworkFetchArgsSchema>;

export const SdkNetworkFetchResultSchema = Type.Object(
  {
    status: Type.Integer({ minimum: 100, maximum: 599 }),
    statusText: Type.String(),
    headers: Type.Record(Type.String(), Type.String()),
    body: Type.String(),
    /** Final URL after followed redirects. */
    url: Type.String(),
    /** Redirect chain (intermediate locations), empty when none. */
    redirects: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type SdkNetworkFetchResult = Static<typeof SdkNetworkFetchResultSchema>;

// ---- §30 Files API (Stage E).
// Plugin-relative path arguments: relative POSIX-style paths inside the
// plugin-owned data directory. The SDK and the host executor both reject
// absolute paths, drive letters and `..` segments; the host additionally
// verifies the resolved path stays inside the plugin root and re-checks the
// real path so symlinks cannot escape it.

export const SdkFilesPathArgsSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: FILES_MAX_PATH_BYTES }),
  },
  { additionalProperties: false },
);
export type SdkFilesPathArgs = Static<typeof SdkFilesPathArgsSchema>;

export const SdkFilesWriteArgsSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: FILES_MAX_PATH_BYTES }),
    content: Type.String({ maxLength: FILES_MAX_CONTENT_BYTES }),
  },
  { additionalProperties: false },
);
export type SdkFilesWriteArgs = Static<typeof SdkFilesWriteArgsSchema>;

export const SdkFilesRenameArgsSchema = Type.Object(
  {
    from: Type.String({ minLength: 1, maxLength: FILES_MAX_PATH_BYTES }),
    to: Type.String({ minLength: 1, maxLength: FILES_MAX_PATH_BYTES }),
  },
  { additionalProperties: false },
);
export type SdkFilesRenameArgs = Static<typeof SdkFilesRenameArgsSchema>;

export const SdkFilesListResultSchema = Type.Object(
  {
    entries: Type.Array(Type.String(), { maxItems: FILES_MAX_LIST }),
  },
  { additionalProperties: false },
);
export type SdkFilesListResult = Static<typeof SdkFilesListResultSchema>;

export const SdkFilesStatResultSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal('file'), Type.Literal('directory')]),
    size: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type SdkFilesStatResult = Static<typeof SdkFilesStatResultSchema>;

// ---- §29 Socket API (Stage E): websocket / tcp / listen / udp.
// Handle-based: open/connect returns an opaque id; send/receive/close operate
// on it. Receive drains a bounded host-side message ring (bounded algorithmic
// storage, §17); `closed` marks a finished stream. Listen servers accept
// connections whose ids work with the tcp.* methods. All destinations and
// bind addresses pass the §29.1 SSRF scope policy; a bind host that is not
// loopback requires the `network.listen.public` capability (§29.1.4).

export const SdkNetworkSocketIdArgsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: NETWORK_MAX_SOCKET_ID_BYTES }),
  },
  { additionalProperties: false },
);
export type SdkNetworkSocketIdArgs = Static<typeof SdkNetworkSocketIdArgsSchema>;

export const SdkNetworkWebsocketOpenArgsSchema = Type.Object(
  {
    url: Type.String({ minLength: 1, maxLength: NETWORK_MAX_URL_BYTES }),
    protocols: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
        maxItems: NETWORK_MAX_WS_PROTOCOLS,
      }),
    ),
  },
  { additionalProperties: false },
);
export type SdkNetworkWebsocketOpenArgs = Static<typeof SdkNetworkWebsocketOpenArgsSchema>;

export const SdkNetworkWebsocketOpenResultSchema = Type.Object(
  {
    id: Type.String(),
  },
  { additionalProperties: false },
);
export type SdkNetworkWebsocketOpenResult = Static<typeof SdkNetworkWebsocketOpenResultSchema>;

export const SdkNetworkSocketSendArgsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: NETWORK_MAX_SOCKET_ID_BYTES }),
    data: Type.String({ maxLength: NETWORK_MAX_SOCKET_MESSAGE_BYTES }),
  },
  { additionalProperties: false },
);
export type SdkNetworkSocketSendArgs = Static<typeof SdkNetworkSocketSendArgsSchema>;

export const SdkNetworkSocketReceiveArgsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: NETWORK_MAX_SOCKET_ID_BYTES }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: NETWORK_MAX_SOCKET_RECEIVE })),
    waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: NETWORK_SOCKET_WAIT_MS })),
  },
  { additionalProperties: false },
);
export type SdkNetworkSocketReceiveArgs = Static<typeof SdkNetworkSocketReceiveArgsSchema>;

export const SdkNetworkSocketMessagesResultSchema = Type.Object(
  {
    messages: Type.Array(Type.String(), { maxItems: NETWORK_MAX_SOCKET_RECEIVE }),
    /** True when the stream ended (peer closed / error); the handle is gone. */
    closed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type SdkNetworkSocketMessagesResult = Static<typeof SdkNetworkSocketMessagesResultSchema>;

export const SdkNetworkSocketDataResultSchema = Type.Object(
  {
    data: Type.Union([Type.String(), Type.Null()]),
    closed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type SdkNetworkSocketDataResult = Static<typeof SdkNetworkSocketDataResultSchema>;

export const SdkNetworkTcpConnectArgsSchema = Type.Object(
  {
    host: Type.String({ minLength: 1, maxLength: NETWORK_MAX_SOCKET_HOST_BYTES }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    tls: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type SdkNetworkTcpConnectArgs = Static<typeof SdkNetworkTcpConnectArgsSchema>;

export const SdkNetworkListenOpenArgsSchema = Type.Object(
  {
    host: Type.Optional(Type.String({ minLength: 1, maxLength: NETWORK_MAX_SOCKET_HOST_BYTES })),
    port: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535 })),
  },
  { additionalProperties: false },
);
export type SdkNetworkListenOpenArgs = Static<typeof SdkNetworkListenOpenArgsSchema>;

export const SdkNetworkListenOpenResultSchema = Type.Object(
  {
    id: Type.String(),
    port: Type.Integer({ minimum: 0, maximum: 65535 }),
  },
  { additionalProperties: false },
);
export type SdkNetworkListenOpenResult = Static<typeof SdkNetworkListenOpenResultSchema>;

export const SdkNetworkListenAcceptArgsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: NETWORK_MAX_SOCKET_ID_BYTES }),
    waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: NETWORK_SOCKET_WAIT_MS })),
  },
  { additionalProperties: false },
);
export type SdkNetworkListenAcceptArgs = Static<typeof SdkNetworkListenAcceptArgsSchema>;

export const SdkNetworkListenAcceptResultSchema = Type.Object(
  {
    connectionId: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type SdkNetworkListenAcceptResult = Static<typeof SdkNetworkListenAcceptResultSchema>;

export const SdkNetworkUdpOpenArgsSchema = Type.Object(
  {
    bindHost: Type.Optional(
      Type.String({ minLength: 1, maxLength: NETWORK_MAX_SOCKET_HOST_BYTES }),
    ),
    bindPort: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535 })),
  },
  { additionalProperties: false },
);
export type SdkNetworkUdpOpenArgs = Static<typeof SdkNetworkUdpOpenArgsSchema>;

export const SdkNetworkUdpSendArgsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: NETWORK_MAX_SOCKET_ID_BYTES }),
    data: Type.String({ maxLength: NETWORK_MAX_SOCKET_MESSAGE_BYTES }),
    host: Type.String({ minLength: 1, maxLength: NETWORK_MAX_SOCKET_HOST_BYTES }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
  },
  { additionalProperties: false },
);
export type SdkNetworkUdpSendArgs = Static<typeof SdkNetworkUdpSendArgsSchema>;

export const SdkNetworkUdpReceiveResultSchema = Type.Object(
  {
    data: Type.Union([Type.String(), Type.Null()]),
    host: Type.Union([Type.String(), Type.Null()]),
    port: Type.Union([Type.Integer({ minimum: 0, maximum: 65535 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type SdkNetworkUdpReceiveResult = Static<typeof SdkNetworkUdpReceiveResultSchema>;

// ---- §13/§32 Process API (Stage E): scoped / unrestricted spawn.
// `process.spawn` admits the call with the `process.spawn` capability; the
// executor then enforces the mode: unrestricted only when the plugin holds
// `system.unrestricted` (§32.2), otherwise scoped (§32.1) — executable and
// cwd must match the host policy, `shell=false` and `detached=false` always.

export const SdkProcessSpawnArgsSchema = Type.Object(
  {
    executable: Type.String({ minLength: 1, maxLength: PROCESS_MAX_EXECUTABLE_BYTES }),
    args: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: PROCESS_MAX_ARG_BYTES }), {
        maxItems: PROCESS_MAX_ARGS,
      }),
    ),
    cwd: Type.Optional(Type.String({ minLength: 1, maxLength: PROCESS_MAX_CWD_BYTES })),
    env: Type.Optional(
      Type.Record(
        Type.String({ minLength: 1, maxLength: PROCESS_MAX_ENV_KEY_BYTES }),
        Type.String({ maxLength: PROCESS_MAX_ENV_VALUE_BYTES }),
      ),
    ),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: PROCESS_MAX_TIMEOUT_MS })),
    stdout: Type.Optional(Type.Union([Type.Literal('capture'), Type.Literal('ignore')])),
    stderr: Type.Optional(Type.Union([Type.Literal('capture'), Type.Literal('ignore')])),
  },
  { additionalProperties: false },
);
export type SdkProcessSpawnArgs = Static<typeof SdkProcessSpawnArgsSchema>;

export const SdkProcessSpawnResultSchema = Type.Object(
  {
    id: Type.String(),
  },
  { additionalProperties: false },
);
export type SdkProcessSpawnResult = Static<typeof SdkProcessSpawnResultSchema>;

export const SdkProcessIdArgsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: NETWORK_MAX_SOCKET_ID_BYTES }),
  },
  { additionalProperties: false },
);
export type SdkProcessIdArgs = Static<typeof SdkProcessIdArgsSchema>;

export const SdkProcessOutputArgsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: NETWORK_MAX_SOCKET_ID_BYTES }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: PROCESS_MAX_OUTPUT_CHUNKS })),
    waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: PROCESS_WAIT_MS })),
  },
  { additionalProperties: false },
);
export type SdkProcessOutputArgs = Static<typeof SdkProcessOutputArgsSchema>;

export const SdkProcessOutputResultSchema = Type.Object(
  {
    stdout: Type.Array(Type.String(), { maxItems: PROCESS_MAX_OUTPUT_CHUNKS }),
    stderr: Type.Array(Type.String(), { maxItems: PROCESS_MAX_OUTPUT_CHUNKS }),
    exited: Type.Boolean(),
    exitCode: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type SdkProcessOutputResult = Static<typeof SdkProcessOutputResultSchema>;

export const SdkProcessWaitResultSchema = Type.Object(
  {
    exited: Type.Boolean(),
    exitCode: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type SdkProcessWaitResult = Static<typeof SdkProcessWaitResultSchema>;

export const SdkProcessSignalArgsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: NETWORK_MAX_SOCKET_ID_BYTES }),
    signal: Type.Union([Type.Literal('SIGTERM'), Type.Literal('SIGKILL'), Type.Literal('SIGINT')]),
  },
  { additionalProperties: false },
);
export type SdkProcessSignalArgs = Static<typeof SdkProcessSignalArgsSchema>;

// ---- §19/§27 Jobs API (Stage E): host-side scheduler ----
// `sdk.jobs.register` schedules a repeating (`intervalMs`) or one-shot
// (`atMs`) job in the Host scheduler; on fire the host pushes a `job-run`
// bridge message to the owning worker, which dispatches to the plugin's
// `sdk.jobs.onRun` callbacks (§19). Jobs are bounded registrations, not
// resource quotas.

export const SdkJobsRegisterArgsSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: JOBS_MAX_NAME_BYTES }),
    intervalMs: Type.Optional(
      Type.Integer({ minimum: JOBS_MIN_INTERVAL_MS, maximum: JOBS_MAX_INTERVAL_MS }),
    ),
    atMs: Type.Optional(Type.Integer({ minimum: 0, maximum: JOBS_MAX_AT_MS })),
    payload: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export type SdkJobsRegisterArgs = Static<typeof SdkJobsRegisterArgsSchema>;

export const SdkJobsRegisterResultSchema = Type.Object(
  {
    jobId: Type.String(),
  },
  { additionalProperties: false },
);
export type SdkJobsRegisterResult = Static<typeof SdkJobsRegisterResultSchema>;

export const SdkJobsCancelArgsSchema = Type.Object(
  {
    jobId: Type.String({ minLength: 1, maxLength: NETWORK_MAX_SOCKET_ID_BYTES }),
  },
  { additionalProperties: false },
);
export type SdkJobsCancelArgs = Static<typeof SdkJobsCancelArgsSchema>;

export const SdkJobsListArgsSchema = Type.Object({}, { additionalProperties: false });
export type SdkJobsListArgs = Static<typeof SdkJobsListArgsSchema>;

export const SdkJobsListResultSchema = Type.Object(
  {
    jobs: Type.Array(
      Type.Object(
        {
          jobId: Type.String(),
          name: Type.String(),
          intervalMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
          nextRunAt: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: JOBS_MAX_PER_PLUGIN },
    ),
  },
  { additionalProperties: false },
);
export type SdkJobsListResult = Static<typeof SdkJobsListResultSchema>;

/** Host → worker `job-run` push envelope (§19). */
export interface SdkJobRunEnvelope {
  jobId: string;
  name: string;
  payload: unknown;
  scheduledAt: number;
}

// ---- §34 Services API (Stage E): brokered cross-plugin calls ----
// A provider plugin declares `{ name, version, methods }` via
// `services.provide`; a caller invokes a method through `services.connect`.
// The host routes the call to the provider's worker (bridge `service-call`)
// and settles the caller with the provider's `services.respond`. Causal
// chains (§26.2.1) make A→B→A fail fast with SERVICE_CALL_CYCLE instead of
// deadlocking. No direct JavaScript references between Compartments.

export const SdkServicesProvideArgsSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: SERVICES_MAX_NAME_BYTES }),
    version: Type.String({ minLength: 1, maxLength: SERVICES_MAX_VERSION_BYTES }),
    methods: Type.Array(Type.String({ minLength: 1, maxLength: SERVICES_MAX_METHOD_BYTES }), {
      minItems: 1,
      maxItems: SERVICES_MAX_METHODS,
    }),
  },
  { additionalProperties: false },
);
export type SdkServicesProvideArgs = Static<typeof SdkServicesProvideArgsSchema>;

export const SdkServicesProvideResultSchema = Type.Object(
  {
    serviceId: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export type SdkServicesProvideResult = Static<typeof SdkServicesProvideResultSchema>;

export const SdkServicesConnectArgsSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: SERVICES_MAX_NAME_BYTES }),
    version: Type.String({ minLength: 1, maxLength: SERVICES_MAX_VERSION_BYTES }),
    method: Type.String({ minLength: 1, maxLength: SERVICES_MAX_METHOD_BYTES }),
    args: Type.Optional(Type.Unknown()),
    // Per-call wall-clock budget; the broker deadline (§10.1) still applies.
    deadlineMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 300_000 })),
  },
  { additionalProperties: false },
);
export type SdkServicesConnectArgs = Static<typeof SdkServicesConnectArgsSchema>;

export const SdkServicesConnectResultSchema = Type.Object(
  {
    result: Type.Unknown(),
  },
  { additionalProperties: false },
);
export type SdkServicesConnectResult = Static<typeof SdkServicesConnectResultSchema>;

export const SdkServicesRespondArgsSchema = Type.Object(
  {
    callId: Type.String({ minLength: 1, maxLength: 128 }),
    ok: Type.Boolean(),
    result: Type.Optional(Type.Unknown()),
    error: Type.Optional(
      Type.Object(
        {
          code: Type.String({ minLength: 1, maxLength: 64 }),
          message: Type.String({ maxLength: 2000 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type SdkServicesRespondArgs = Static<typeof SdkServicesRespondArgsSchema>;

export const SdkServicesRespondResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type SdkServicesRespondResult = Static<typeof SdkServicesRespondResultSchema>;

/** Host → worker `service-call` push envelope (§34). */
export interface SdkServiceCallEnvelope {
  callId: string;
  serviceId: string;
  /** Causal chain: caller ids on the path (A→B→…), §26.2.1. */
  chain: string[];
  method: string;
  args: unknown;
}

// ---- §33 Secrets API (Stage E): Main Host keeps the tokens ----
// `secrets.use` validates the stored connection and mints an opaque handle
// bound to the service origin; the plugin passes the handle to
// `network.fetch` (secretId), the host injects the Authorization header and
// refuses any destination outside the bound origin (§29.1.5). The token
// value never crosses to the worker except under the explicit trusted-only
// `secrets.reveal`.

export const SdkSecretsUseArgsSchema = Type.Object(
  {
    connectionId: Type.String({
      minLength: 1,
      maxLength: SECRETS_MAX_CONNECTION_ID_BYTES,
    }),
  },
  { additionalProperties: false },
);
export type SdkSecretsUseArgs = Static<typeof SdkSecretsUseArgsSchema>;

export const SdkSecretsUseResultSchema = Type.Object(
  {
    handle: Type.String({ minLength: 1, maxLength: SECRETS_MAX_HANDLE_BYTES }),
    serviceId: Type.String({ minLength: 1, maxLength: 200 }),
    expiresAt: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type SdkSecretsUseResult = Static<typeof SdkSecretsUseResultSchema>;

export const SdkSecretsManageOwnArgsSchema = Type.Object({}, { additionalProperties: false });
export type SdkSecretsManageOwnArgs = Static<typeof SdkSecretsManageOwnArgsSchema>;

export const SdkSecretsManageOwnResultSchema = Type.Object(
  {
    connections: Type.Array(
      Type.Object(
        {
          connectionId: Type.String(),
          serviceId: Type.String(),
          serviceName: Type.String(),
          scopes: Type.Array(Type.String()),
          status: Type.String({ maxLength: 32 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: SECRETS_MAX_LIST },
    ),
  },
  { additionalProperties: false },
);
export type SdkSecretsManageOwnResult = Static<typeof SdkSecretsManageOwnResultSchema>;

export const SdkSecretsRevealArgsSchema = Type.Object(
  {
    connectionId: Type.String({
      minLength: 1,
      maxLength: SECRETS_MAX_CONNECTION_ID_BYTES,
    }),
  },
  { additionalProperties: false },
);
export type SdkSecretsRevealArgs = Static<typeof SdkSecretsRevealArgsSchema>;

export const SdkSecretsRevealResultSchema = Type.Object(
  {
    accessToken: Type.String({ minLength: 1, maxLength: 8192 }),
    tokenType: Type.Optional(Type.String({ maxLength: 64 })),
    expiresAt: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type SdkSecretsRevealResult = Static<typeof SdkSecretsRevealResultSchema>;

// Models list bounds (§12 Models catalog, Stage D prototype). The model list
// is a read-only projection of a configured provider's available models.
/** Max number of models returned by one `models.list` call. */
export const MODELS_MAX_LIST = 256;

export const SdkModelsListArgsSchema = Type.Object(
  {
    providerId: IdSchema,
  },
  { additionalProperties: false },
);
export type SdkModelsListArgs = Static<typeof SdkModelsListArgsSchema>;

export const SdkModelsListResultSchema = Type.Object(
  {
    models: Type.Array(ModelInfoSchema, { maxItems: MODELS_MAX_LIST }),
  },
  { additionalProperties: false },
);
export type SdkModelsListResult = Static<typeof SdkModelsListResultSchema>;

// Chats bounds (§12 Application, Stage D prototype). The chat list and chat
// read are read-only projections of the app's chat store.
/** Max number of chat summaries returned by one `chats.list` call. */
export const CHATS_MAX_LIST = 200;
/** Max byte length of a cursor. */
export const CHATS_MAX_CURSOR_BYTES = 256;

export const SdkChatsListArgsSchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ maxLength: CHATS_MAX_CURSOR_BYTES })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: CHATS_MAX_LIST })),
    characterId: Type.Optional(IdSchema),
  },
  { additionalProperties: false },
);
export type SdkChatsListArgs = Static<typeof SdkChatsListArgsSchema>;

export const SdkChatsListResultSchema = Type.Object(
  {
    items: Type.Array(ChatSummarySchema, { maxItems: CHATS_MAX_LIST }),
    nextCursor: Type.Union([Type.String({ maxLength: CHATS_MAX_CURSOR_BYTES }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type SdkChatsListResult = Static<typeof SdkChatsListResultSchema>;

export const SdkChatsReadArgsSchema = Type.Object(
  {
    chatId: IdSchema,
  },
  { additionalProperties: false },
);
export type SdkChatsReadArgs = Static<typeof SdkChatsReadArgsSchema>;

export const SdkChatsReadResultSchema = Type.Object(
  {
    chat: ChatSchema,
  },
  { additionalProperties: false },
);
export type SdkChatsReadResult = Static<typeof SdkChatsReadResultSchema>;

// Characters bounds (§12 Application, Stage D prototype). The character list
// and character read are read-only projections of the app's character store.
/** Max number of character summaries returned by one `characters.list` call. */
export const CHARACTERS_MAX_LIST = 200;
/** Max byte length of a cursor. */
export const CHARACTERS_MAX_CURSOR_BYTES = 256;

export const SdkCharactersListArgsSchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ maxLength: CHARACTERS_MAX_CURSOR_BYTES })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: CHARACTERS_MAX_LIST })),
  },
  { additionalProperties: false },
);
export type SdkCharactersListArgs = Static<typeof SdkCharactersListArgsSchema>;

export const SdkCharactersListResultSchema = Type.Object(
  {
    items: Type.Array(CharacterSummarySchema, { maxItems: CHARACTERS_MAX_LIST }),
    nextCursor: Type.Union([Type.String({ maxLength: CHARACTERS_MAX_CURSOR_BYTES }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type SdkCharactersListResult = Static<typeof SdkCharactersListResultSchema>;

export const SdkCharactersReadArgsSchema = Type.Object(
  {
    characterId: IdSchema,
  },
  { additionalProperties: false },
);
export type SdkCharactersReadArgs = Static<typeof SdkCharactersReadArgsSchema>;

export const SdkCharactersReadResultSchema = Type.Object(
  {
    character: CharacterSchema,
  },
  { additionalProperties: false },
);
export type SdkCharactersReadResult = Static<typeof SdkCharactersReadResultSchema>;

// Lorebook bounds (§12 Application, Stage D prototype). The book list, book
// read and entry list are read-only projections of the app's lorebook store.
/** Max number of books returned by one `lorebook.list` call. */
export const LOREBOK_MAX_LIST = 200;
/** Max byte length of a cursor. */
export const LOREBOK_MAX_CURSOR_BYTES = 256;
/** Max number of entries returned by one `lorebook.entries` call. */
export const LOREBOK_MAX_ENTRIES = 1000;

export const SdkLorebookListArgsSchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ maxLength: LOREBOK_MAX_CURSOR_BYTES })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LOREBOK_MAX_LIST })),
    characterId: Type.Optional(IdSchema),
  },
  { additionalProperties: false },
);
export type SdkLorebookListArgs = Static<typeof SdkLorebookListArgsSchema>;

export const SdkLorebookListResultSchema = Type.Object(
  {
    items: Type.Array(LorebookSchema, { maxItems: LOREBOK_MAX_LIST }),
    nextCursor: Type.Union([Type.String({ maxLength: LOREBOK_MAX_CURSOR_BYTES }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type SdkLorebookListResult = Static<typeof SdkLorebookListResultSchema>;

export const SdkLorebookReadArgsSchema = Type.Object(
  {
    bookId: IdSchema,
  },
  { additionalProperties: false },
);
export type SdkLorebookReadArgs = Static<typeof SdkLorebookReadArgsSchema>;

export const SdkLorebookReadResultSchema = Type.Object(
  {
    book: LorebookSchema,
  },
  { additionalProperties: false },
);
export type SdkLorebookReadResult = Static<typeof SdkLorebookReadResultSchema>;

export const SdkLorebookEntriesArgsSchema = Type.Object(
  {
    bookId: IdSchema,
  },
  { additionalProperties: false },
);
export type SdkLorebookEntriesArgs = Static<typeof SdkLorebookEntriesArgsSchema>;

export const SdkLorebookEntriesResultSchema = Type.Object(
  {
    items: Type.Array(LorebookEntrySchema, { maxItems: LOREBOK_MAX_ENTRIES }),
  },
  { additionalProperties: false },
);
export type SdkLorebookEntriesResult = Static<typeof SdkLorebookEntriesResultSchema>;

// Core DB bounds (§31, Stage D prototype). The brokered query is read-only:
// a single SELECT/WITH statement bound through a prepared statement host-side.
// Plugins never receive a DB driver module (§31 "Plugin DB" / "Core DB").
/** Max byte length of a query SQL text. */
export const DATABASE_MAX_SQL_BYTES = 4096;
/** Max number of bound parameters. */
export const DATABASE_MAX_PARAMS = 64;
/** Max number of rows returned by one `database.core.query` call. */
export const DATABASE_MAX_ROWS = 1000;
/** Max number of columns returned by one `database.core.query` call. */
export const DATABASE_MAX_COLUMNS = 64;

export const SdkDatabaseQueryArgsSchema = Type.Object(
  {
    sql: Type.String({ minLength: 1, maxLength: DATABASE_MAX_SQL_BYTES }),
    params: Type.Optional(
      Type.Array(Type.Union([Type.Null(), Type.String(), Type.Number(), Type.Boolean()]), {
        maxItems: DATABASE_MAX_PARAMS,
      }),
    ),
  },
  { additionalProperties: false },
);
export type SdkDatabaseQueryArgs = Static<typeof SdkDatabaseQueryArgsSchema>;

export const SdkDatabaseQueryResultSchema = Type.Object(
  {
    columns: Type.Array(Type.String(), { maxItems: DATABASE_MAX_COLUMNS }),
    rows: Type.Array(
      Type.Array(Type.Union([Type.Null(), Type.String(), Type.Number(), Type.Boolean()]), {
        maxItems: DATABASE_MAX_COLUMNS,
      }),
      { maxItems: DATABASE_MAX_ROWS },
    ),
  },
  { additionalProperties: false },
);
export type SdkDatabaseQueryResult = Static<typeof SdkDatabaseQueryResultSchema>;

export const SdkEventEnvelopeSchema = Type.Object(
  {
    seq: Type.Integer({ minimum: 1 }),
    name: Type.String({ minLength: 1, maxLength: EVENTS_MAX_NAME_BYTES }),
    emittedAt: Type.Integer({ minimum: 1 }),
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
);
export type SdkEventEnvelope = Static<typeof SdkEventEnvelopeSchema>;

export const SdkEventsReplayArgsSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: EVENTS_MAX_NAME_BYTES }),
    /** Last seen seq (ADR-0025 cursor, `<name>:<seq>`); omit to replay from
     * the beginning of the buffer. */
    cursor: Type.Optional(Type.Integer({ minimum: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: EVENTS_MAX_REPLAY_LIMIT })),
    /** Wait up to this long for the next event when the buffer is empty. */
    waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: EVENTS_MAX_WAIT_MS })),
  },
  { additionalProperties: false },
);
export type SdkEventsReplayArgs = Static<typeof SdkEventsReplayArgsSchema>;

export const SdkEventsReplayResultSchema = Type.Object(
  {
    events: Type.Array(SdkEventEnvelopeSchema, {
      maxItems: EVENTS_MAX_REPLAY_LIMIT,
    }),
    /** Seq of the last returned event, or the requested cursor when nothing
     * new arrived; null when replaying from the beginning with an empty
     * buffer. */
    nextCursor: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type SdkEventsReplayResult = Static<typeof SdkEventsReplayResultSchema>;

/**
 * §18 live-delivery subscription args (Stage F). `cursor` is a best-effort
 * starting point for the worker-side replay fallback: the host delivers every
 * event emitted after the subscription is registered, regardless of cursor.
 */
export const SdkEventsSubscribeArgsSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: EVENTS_MAX_NAME_BYTES }),
    cursor: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
export type SdkEventsSubscribeArgs = Static<typeof SdkEventsSubscribeArgsSchema>;

export const SdkEventsSubscribeResultSchema = Type.Object(
  {
    subscriptionId: Type.String({ minLength: 8, maxLength: 64 }),
  },
  { additionalProperties: false },
);
export type SdkEventsSubscribeResult = Static<typeof SdkEventsSubscribeResultSchema>;

export const SdkEventsUnsubscribeArgsSchema = Type.Object(
  {
    subscriptionId: Type.String({ minLength: 8, maxLength: 64 }),
  },
  { additionalProperties: false },
);
export type SdkEventsUnsubscribeArgs = Static<typeof SdkEventsUnsubscribeArgsSchema>;

export const SdkEventsUnsubscribeResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
  },
  { additionalProperties: false },
);
export type SdkEventsUnsubscribeResult = Static<typeof SdkEventsUnsubscribeResultSchema>;

export const SdkKvGetArgsSchema = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: SDK_MAX_KV_KEY_BYTES }),
  },
  { additionalProperties: false },
);
export type SdkKvGetArgs = Static<typeof SdkKvGetArgsSchema>;

export const SdkKvSetArgsSchema = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: SDK_MAX_KV_KEY_BYTES }),
    value: Type.Unknown(),
  },
  { additionalProperties: false },
);
export type SdkKvSetArgs = Static<typeof SdkKvSetArgsSchema>;

export const SdkKvDeleteArgsSchema = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: SDK_MAX_KV_KEY_BYTES }),
  },
  { additionalProperties: false },
);
export type SdkKvDeleteArgs = Static<typeof SdkKvDeleteArgsSchema>;

export const SdkKvListArgsSchema = Type.Object({}, { additionalProperties: false });
export type SdkKvListArgs = Static<typeof SdkKvListArgsSchema>;

export const SdkKvListResultSchema = Type.Object(
  {
    keys: Type.Array(Type.String({ minLength: 1, maxLength: SDK_MAX_KV_KEY_BYTES })),
  },
  { additionalProperties: false },
);
export type SdkKvListResult = Static<typeof SdkKvListResultSchema>;

export const SdkSettingsGetArgsSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: SDK_MAX_SETTINGS_PATH_BYTES }),
  },
  { additionalProperties: false },
);
export type SdkSettingsGetArgs = Static<typeof SdkSettingsGetArgsSchema>;

export const SdkSettingsSetArgsSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: SDK_MAX_SETTINGS_PATH_BYTES }),
    value: Type.Unknown(),
  },
  { additionalProperties: false },
);
export type SdkSettingsSetArgs = Static<typeof SdkSettingsSetArgsSchema>;

/** Union of the Core SDK args schemas. */
type SdkArgsSchema =
  | typeof SdkKvGetArgsSchema
  | typeof SdkKvSetArgsSchema
  | typeof SdkKvDeleteArgsSchema
  | typeof SdkKvListArgsSchema
  | typeof SdkSettingsGetArgsSchema
  | typeof SdkSettingsSetArgsSchema
  | typeof SdkEventsReplayArgsSchema
  | typeof SdkEventsSubscribeArgsSchema
  | typeof SdkEventsUnsubscribeArgsSchema
  | typeof SdkNetworkFetchArgsSchema
  | typeof SdkModelsListArgsSchema
  | typeof SdkChatsListArgsSchema
  | typeof SdkChatsReadArgsSchema
  | typeof SdkCharactersListArgsSchema
  | typeof SdkCharactersReadArgsSchema
  | typeof SdkLorebookListArgsSchema
  | typeof SdkLorebookReadArgsSchema
  | typeof SdkLorebookEntriesArgsSchema
  | typeof SdkDatabaseQueryArgsSchema
  | typeof SdkFilesPathArgsSchema
  | typeof SdkFilesWriteArgsSchema
  | typeof SdkFilesRenameArgsSchema
  | typeof SdkNetworkSocketIdArgsSchema
  | typeof SdkNetworkSocketSendArgsSchema
  | typeof SdkNetworkSocketReceiveArgsSchema
  | typeof SdkNetworkWebsocketOpenArgsSchema
  | typeof SdkNetworkTcpConnectArgsSchema
  | typeof SdkNetworkListenOpenArgsSchema
  | typeof SdkNetworkListenAcceptArgsSchema
  | typeof SdkNetworkUdpOpenArgsSchema
  | typeof SdkNetworkUdpSendArgsSchema
  | typeof SdkProcessSpawnArgsSchema
  | typeof SdkProcessOutputArgsSchema
  | typeof SdkProcessSignalArgsSchema
  | typeof SdkProcessIdArgsSchema
  | typeof SdkJobsRegisterArgsSchema
  | typeof SdkJobsCancelArgsSchema;

/** One catalog entry: the wire method, its required §12 capability and its
 * args schema. `capability: null` marks a core channel (ТЗ §18 events): no
 * grant is required — the broker still enforces identity, deadline, cycles
 * and bounds. */
export interface SdkOperationCatalogEntry {
  method: string;
  capability: string | null;
  argsSchema: SdkArgsSchema;
}

/**
 * Method → capability mapping for the first SDK operations (§12 Application /
 * Storage, §18 events). Single source of truth: the worker SDK builds broker
 * envelopes from it, the host executor validates calls against it, and the
 * contracts test pins the worker-bootstrap inline copy against it.
 */
export const SDK_OPERATION_CATALOG: readonly SdkOperationCatalogEntry[] = [
  { method: 'storage.kv.get', capability: 'storage.kv', argsSchema: SdkKvGetArgsSchema },
  { method: 'storage.kv.set', capability: 'storage.kv', argsSchema: SdkKvSetArgsSchema },
  { method: 'storage.kv.delete', capability: 'storage.kv', argsSchema: SdkKvDeleteArgsSchema },
  { method: 'storage.kv.list', capability: 'storage.kv', argsSchema: SdkKvListArgsSchema },
  { method: 'settings.get', capability: 'settings.read', argsSchema: SdkSettingsGetArgsSchema },
  { method: 'settings.set', capability: 'settings.write', argsSchema: SdkSettingsSetArgsSchema },
  { method: 'events.replay', capability: null, argsSchema: SdkEventsReplayArgsSchema },
  // §18 live delivery (Stage F): the subscription lives host-side; events are
  // pushed to the worker over the runtime wire (HOST_BRIDGE_MESSAGE frames).
  { method: 'events.subscribe', capability: null, argsSchema: SdkEventsSubscribeArgsSchema },
  { method: 'events.unsubscribe', capability: null, argsSchema: SdkEventsUnsubscribeArgsSchema },
  {
    method: 'network.http.fetch',
    capability: 'network.http',
    argsSchema: SdkNetworkFetchArgsSchema,
  },
  { method: 'models.list', capability: 'models.list', argsSchema: SdkModelsListArgsSchema },
  { method: 'chats.list', capability: 'chats.read', argsSchema: SdkChatsListArgsSchema },
  { method: 'chats.read', capability: 'chats.read', argsSchema: SdkChatsReadArgsSchema },
  {
    method: 'characters.list',
    capability: 'characters.read',
    argsSchema: SdkCharactersListArgsSchema,
  },
  {
    method: 'characters.read',
    capability: 'characters.read',
    argsSchema: SdkCharactersReadArgsSchema,
  },
  {
    method: 'lorebook.list',
    capability: 'lorebook.read',
    argsSchema: SdkLorebookListArgsSchema,
  },
  {
    method: 'lorebook.read',
    capability: 'lorebook.read',
    argsSchema: SdkLorebookReadArgsSchema,
  },
  {
    method: 'lorebook.entries',
    capability: 'lorebook.read',
    argsSchema: SdkLorebookEntriesArgsSchema,
  },
  {
    method: 'database.core.query',
    capability: 'database.core.read',
    argsSchema: SdkDatabaseQueryArgsSchema,
  },
  // §30 Files API (Stage E): all operations are scoped to the plugin-owned
  // data directory via `files.plugin`; broader scopes (`files.paths.read` /
  // `files.paths.write` / `files.system`) arrive with the trust model.
  { method: 'files.read', capability: 'files.plugin', argsSchema: SdkFilesPathArgsSchema },
  { method: 'files.write', capability: 'files.plugin', argsSchema: SdkFilesWriteArgsSchema },
  { method: 'files.stat', capability: 'files.plugin', argsSchema: SdkFilesPathArgsSchema },
  { method: 'files.list', capability: 'files.plugin', argsSchema: SdkFilesPathArgsSchema },
  { method: 'files.rename', capability: 'files.plugin', argsSchema: SdkFilesRenameArgsSchema },
  { method: 'files.remove', capability: 'files.plugin', argsSchema: SdkFilesPathArgsSchema },
  // §29 Socket API (Stage E): websocket / tcp / listen / udp. Destinations
  // pass the §29.1 SSRF scope policy like network.http; listen binds loopback
  // by default (§29.1.4) and requires `network.listen.public` otherwise.
  {
    method: 'network.websocket.open',
    capability: 'network.websocket',
    argsSchema: SdkNetworkWebsocketOpenArgsSchema,
  },
  {
    method: 'network.websocket.send',
    capability: 'network.websocket',
    argsSchema: SdkNetworkSocketSendArgsSchema,
  },
  {
    method: 'network.websocket.receive',
    capability: 'network.websocket',
    argsSchema: SdkNetworkSocketReceiveArgsSchema,
  },
  {
    method: 'network.websocket.close',
    capability: 'network.websocket',
    argsSchema: SdkNetworkSocketIdArgsSchema,
  },
  {
    method: 'network.tcp.connect',
    capability: 'network.tcp',
    argsSchema: SdkNetworkTcpConnectArgsSchema,
  },
  {
    method: 'network.tcp.send',
    capability: 'network.tcp',
    argsSchema: SdkNetworkSocketSendArgsSchema,
  },
  {
    method: 'network.tcp.receive',
    capability: 'network.tcp',
    argsSchema: SdkNetworkSocketReceiveArgsSchema,
  },
  {
    method: 'network.tcp.close',
    capability: 'network.tcp',
    argsSchema: SdkNetworkSocketIdArgsSchema,
  },
  {
    method: 'network.listen.open',
    capability: 'network.listen',
    argsSchema: SdkNetworkListenOpenArgsSchema,
  },
  {
    method: 'network.listen.accept',
    capability: 'network.listen',
    argsSchema: SdkNetworkListenAcceptArgsSchema,
  },
  {
    method: 'network.listen.close',
    capability: 'network.listen',
    argsSchema: SdkNetworkSocketIdArgsSchema,
  },
  {
    method: 'network.udp.open',
    capability: 'network.udp',
    argsSchema: SdkNetworkUdpOpenArgsSchema,
  },
  {
    method: 'network.udp.send',
    capability: 'network.udp',
    argsSchema: SdkNetworkUdpSendArgsSchema,
  },
  {
    method: 'network.udp.receive',
    capability: 'network.udp',
    argsSchema: SdkNetworkSocketIdArgsSchema,
  },
  {
    method: 'network.udp.close',
    capability: 'network.udp',
    argsSchema: SdkNetworkSocketIdArgsSchema,
  },
  // §13/§32 Process API (Stage E): every method admits with `process.spawn`;
  // the executor enforces scoped vs unrestricted (§32.1/§32.2) at run time.
  {
    method: 'process.spawn',
    capability: 'process.spawn',
    argsSchema: SdkProcessSpawnArgsSchema,
  },
  {
    method: 'process.output',
    capability: 'process.spawn',
    argsSchema: SdkProcessOutputArgsSchema,
  },
  {
    method: 'process.signal',
    capability: 'process.spawn',
    argsSchema: SdkProcessSignalArgsSchema,
  },
  {
    method: 'process.wait',
    capability: 'process.spawn',
    argsSchema: SdkProcessOutputArgsSchema,
  },
  {
    method: 'process.close',
    capability: 'process.spawn',
    argsSchema: SdkProcessIdArgsSchema,
  },
  // §19/§27 Jobs API (Stage E): host-side scheduler with job-run pushes.
  {
    method: 'jobs.register',
    capability: 'jobs.background',
    argsSchema: SdkJobsRegisterArgsSchema,
  },
  {
    method: 'jobs.cancel',
    capability: 'jobs.background',
    argsSchema: SdkJobsCancelArgsSchema,
  },
  {
    method: 'jobs.list',
    capability: 'jobs.background',
    argsSchema: SdkJobsListArgsSchema,
  },
  // §34 Services API (Stage E): provider registers, caller connects, the
  // provider settles the call back through `services.respond`.
  {
    method: 'services.provide',
    capability: 'services.provide',
    argsSchema: SdkServicesProvideArgsSchema,
  },
  {
    method: 'services.connect',
    capability: 'services.connect',
    argsSchema: SdkServicesConnectArgsSchema,
  },
  {
    method: 'services.respond',
    capability: 'services.provide',
    argsSchema: SdkServicesRespondArgsSchema,
  },
  // §33 Secrets API (Stage E): Main Host keeps the tokens; use mints a
  // bound handle, manageOwn lists redacted connections, reveal is
  // trusted-only.
  {
    method: 'secrets.use',
    capability: 'secrets.use',
    argsSchema: SdkSecretsUseArgsSchema,
  },
  {
    method: 'secrets.manageOwn',
    capability: 'secrets.manageOwn',
    argsSchema: SdkSecretsManageOwnArgsSchema,
  },
  {
    method: 'secrets.reveal',
    capability: 'secrets.reveal',
    argsSchema: SdkSecretsRevealArgsSchema,
  },
];

/** The broker `method` values as a stable constant set (for code reuse). */
export const SdkOperationMethod = {
  KV_GET: 'storage.kv.get',
  KV_SET: 'storage.kv.set',
  KV_DELETE: 'storage.kv.delete',
  KV_LIST: 'storage.kv.list',
  SETTINGS_GET: 'settings.get',
  SETTINGS_SET: 'settings.set',
  EVENTS_REPLAY: 'events.replay',
  EVENTS_SUBSCRIBE: 'events.subscribe',
  EVENTS_UNSUBSCRIBE: 'events.unsubscribe',
  NETWORK_HTTP_FETCH: 'network.http.fetch',
  MODELS_LIST: 'models.list',
  CHATS_LIST: 'chats.list',
  CHATS_READ: 'chats.read',
  CHARACTERS_LIST: 'characters.list',
  CHARACTERS_READ: 'characters.read',
  LOREBOK_LIST: 'lorebook.list',
  LOREBOK_READ: 'lorebook.read',
  LOREBOK_ENTRIES: 'lorebook.entries',
  DATABASE_CORE_QUERY: 'database.core.query',
  FILES_READ: 'files.read',
  FILES_WRITE: 'files.write',
  FILES_STAT: 'files.stat',
  FILES_LIST: 'files.list',
  FILES_RENAME: 'files.rename',
  FILES_REMOVE: 'files.remove',
  NETWORK_WEBSOCKET_OPEN: 'network.websocket.open',
  NETWORK_WEBSOCKET_SEND: 'network.websocket.send',
  NETWORK_WEBSOCKET_RECEIVE: 'network.websocket.receive',
  NETWORK_WEBSOCKET_CLOSE: 'network.websocket.close',
  NETWORK_TCP_CONNECT: 'network.tcp.connect',
  NETWORK_TCP_SEND: 'network.tcp.send',
  NETWORK_TCP_RECEIVE: 'network.tcp.receive',
  NETWORK_TCP_CLOSE: 'network.tcp.close',
  NETWORK_LISTEN_OPEN: 'network.listen.open',
  NETWORK_LISTEN_ACCEPT: 'network.listen.accept',
  NETWORK_LISTEN_CLOSE: 'network.listen.close',
  NETWORK_UDP_OPEN: 'network.udp.open',
  NETWORK_UDP_SEND: 'network.udp.send',
  NETWORK_UDP_RECEIVE: 'network.udp.receive',
  NETWORK_UDP_CLOSE: 'network.udp.close',
  PROCESS_SPAWN: 'process.spawn',
  PROCESS_OUTPUT: 'process.output',
  PROCESS_SIGNAL: 'process.signal',
  PROCESS_WAIT: 'process.wait',
  PROCESS_CLOSE: 'process.close',
  JOBS_REGISTER: 'jobs.register',
  JOBS_CANCEL: 'jobs.cancel',
  JOBS_LIST: 'jobs.list',
  SERVICES_PROVIDE: 'services.provide',
  SERVICES_CONNECT: 'services.connect',
  SERVICES_RESPOND: 'services.respond',
  SECRETS_USE: 'secrets.use',
  SECRETS_MANAGE_OWN: 'secrets.manageOwn',
  SECRETS_REVEAL: 'secrets.reveal',
} as const;
