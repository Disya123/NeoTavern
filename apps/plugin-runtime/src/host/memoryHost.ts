/**
 * Reference host-side executor for the Core SDK (ТЗ v3.2 §12, §18, Stage D).
 *
 * In the production topology the decision + execution authority lives in Main
 * Host (ADR-0027) and the runtime forwards calls over RPC_REQUEST frames;
 * this module is the prototype stand-in: it implements the catalog operations
 * with in-memory per-plugin stores (storage.kv, settings.read/write) and the
 * §18 events channel as a bounded ring buffer with cursor/replay semantics
 * (ADR-0025 §J1). Grants are enforced per §12 capability names; the events
 * channel is a core channel (`capability: null` in the catalog) — no grant is
 * required, but identity, deadline, cycles and bounds still apply.
 *
 * It plugs into the broker core as a `BrokerPolicy`: `authorize` checks the
 * method against the operation catalog (single source of truth
 * `@neotavern/contracts` sdkOps.ts), validates that the call's declared capability
 * matches the catalog entry (unless the entry is a core channel), and checks
 * the plugin's grant set; `execute` dispatches the admitted operation.
 */
import {
  EVENTS_MAX_REPLAY_LIMIT,
  EVENTS_MAX_SUBSCRIPTIONS_PER_PLUGIN,
  EVENTS_MAX_WAIT_MS,
  EVENTS_MAX_WAITERS,
  EVENTS_PER_NAME,
  EVENTS_TOTAL,
  EVENTS_TTL_MS,
  CHATS_MAX_LIST,
  CHARACTERS_MAX_LIST,
  LOREBOK_MAX_ENTRIES,
  LOREBOK_MAX_LIST,
  DATABASE_MAX_COLUMNS,
  DATABASE_MAX_ROWS,
  FILES_MAX_CONTENT_BYTES,
  FILES_MAX_LIST,
  MODELS_MAX_LIST,
  NETWORK_MAX_BODY_BYTES,
  NETWORK_MAX_HEADERS,
  NETWORK_MAX_REDIRECTS,
  NETWORK_SCOPE_LOCAL,
  NETWORK_SCOPE_METADATA,
  NETWORK_SCOPE_PRIVATE,
  SdkChatsListArgsSchema,
  SdkChatsReadArgsSchema,
  SdkCharactersListArgsSchema,
  SdkCharactersReadArgsSchema,
  SdkEventsReplayArgsSchema,
  SdkEventsSubscribeArgsSchema,
  SdkEventsUnsubscribeArgsSchema,
  SdkFilesPathArgsSchema,
  SdkFilesRenameArgsSchema,
  SdkFilesWriteArgsSchema,
  SdkKvDeleteArgsSchema,
  SdkKvGetArgsSchema,
  SdkKvListArgsSchema,
  SdkKvSetArgsSchema,
  SdkLorebookEntriesArgsSchema,
  SdkLorebookListArgsSchema,
  SdkLorebookReadArgsSchema,
  SdkDatabaseQueryArgsSchema,
  SdkModelsListArgsSchema,
  SdkNetworkFetchArgsSchema,
  SdkNetworkListenAcceptArgsSchema,
  SdkNetworkListenOpenArgsSchema,
  SdkNetworkSocketIdArgsSchema,
  SdkNetworkSocketReceiveArgsSchema,
  SdkNetworkSocketSendArgsSchema,
  SdkNetworkTcpConnectArgsSchema,
  SdkNetworkUdpOpenArgsSchema,
  SdkNetworkUdpSendArgsSchema,
  SdkNetworkWebsocketOpenArgsSchema,
  SdkProcessIdArgsSchema,
  SdkProcessOutputArgsSchema,
  SdkProcessSignalArgsSchema,
  SdkProcessSpawnArgsSchema,
  SdkJobsCancelArgsSchema,
  SdkJobsListArgsSchema,
  SdkJobsRegisterArgsSchema,
  SdkServicesConnectArgsSchema,
  SdkServicesProvideArgsSchema,
  SdkServicesRespondArgsSchema,
  SdkSecretsManageOwnArgsSchema,
  SdkSecretsRevealArgsSchema,
  SdkSecretsUseArgsSchema,
  JOBS_MAX_PER_PLUGIN,
  JOBS_MIN_INTERVAL_MS,
  SERVICES_MAX_PENDING,
  SERVICES_MAX_PAYLOAD_BYTES,
  SECRETS_MAX_LIVE,
  SECRETS_MAX_LIST,
  SdkSettingsGetArgsSchema,
  SdkSettingsSetArgsSchema,
  SDK_OPERATION_CATALOG,
  validateSchema,
  type BrokerCallRequest,
  type Character,
  type CharacterSummary,
  type Chat,
  type ChatSummary,
  type Lorebook,
  type LorebookEntry,
  type ModelInfo,
  type SdkCharactersListArgs,
  type SdkCharactersListResult,
  type SdkCharactersReadResult,
  type SdkChatsListArgs,
  type SdkChatsListResult,
  type SdkChatsReadResult,
  type SdkEventEnvelope,
  type SdkEventsReplayArgs,
  type SdkEventsReplayResult,
  type SdkLorebookEntriesResult,
  type SdkLorebookListArgs,
  type SdkLorebookListResult,
  type SdkLorebookReadResult,
  type SdkDatabaseQueryArgs,
  type SdkDatabaseQueryResult,
  type SdkModelsListResult,
  type SdkNetworkFetchArgs,
  type SdkNetworkFetchResult,
  type SdkJobRunEnvelope,
  type SdkServiceCallEnvelope,
  type NetworkScope,
} from '@neotavern/contracts';
import { lookup as dnsLookup } from 'node:dns/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createNetworkPool, type NetworkPool, type NetworkPoolOptions } from './networkPool.js';
import { mappedIpv4, normalizeIpLiteral, VerifiedIpMismatchError } from './netPolicy.js';
import { createSocketRegistry, type SocketRegistry } from './socketHandles.js';
import {
  assertUnrestrictedOrScope,
  createProcessRegistry,
  type ProcessRegistry,
  type ProcessScope,
} from './processHandles.js';
import {
  BrokerCallError,
  BrokerErrorCode,
  type BrokerDecision,
  type BrokerPolicy,
} from '../broker/capabilityBroker.js';

/**
 * §29.1.5 secret-bound request binding. `origin` is a URL whose `origin` part
 * (scheme + host + port) the executor compares against every fetch hop;
 * `headers` are injected at request time (secret wins over plugin headers on
 * conflict) and are dropped as soon as a redirect leaves the bound origin.
 */
export interface NetworkSecret {
  origin: string;
  headers: Record<string, string>;
}

/**
 * §33 Secrets API: Main Host keeps the tokens. The broker host injects the
 * implementation backed by the OAuth connections repo (`authConnections.ts`):
 * `use` validates the stored connection and returns the bound origin plus
 * the resolved Authorization header (the token value never crosses the
 * worker boundary), `manageOwn` lists the plugin's own redacted
 * connections, `reveal` returns the raw token for the explicit trusted-only
 * grant (§11.3).
 */
export interface SecretsProvider {
  use(
    pluginId: string,
    connectionId: string,
  ): Promise<{
    serviceId: string;
    origin: string;
    headers: Record<string, string>;
    expiresAt?: number | null;
  }>;
  manageOwn(pluginId: string): Promise<
    Array<{
      connectionId: string;
      serviceId: string;
      serviceName: string;
      scopes: string[];
      status: string;
    }>
  >;
  reveal(
    pluginId: string,
    connectionId: string,
  ): Promise<{ accessToken: string; tokenType?: string; expiresAt?: number | null }>;
}

export interface MemoryHostOptions {
  /** pluginId → granted §12 capability names at construction time. */
  grants?: Record<string, string[]>;
  /** Injectable clock (tests use a fake clock for TTL eviction). */
  now?: () => number;
  /** Injectable fetch (tests stub network + SSRF edges). Defaults to the §29
   * network pool with verified-IP connects. When provided, the executor
   * passes the policy-approved address list as the third argument so a
   * transport can connect to a verified IP and check `remoteAddress`
   * post-connect (ТЗ §SEC-03); a stub may ignore it. */
  fetchImpl?: (url: string, init: RequestInit, verified?: { ips: string[] }) => Promise<Response>;
  /** Injectable DNS lookup (tests stub rebinding edges). Defaults to
   * `node:dns/promises` `lookup`. */
  dnsLookupImpl?: (hostname: string) => Promise<string[]>;
  /**
   * §29.1.5 secret-bound requests: opaque secret id → bound origin + headers.
   * The executor injects the headers at request time and refuses destinations
   * outside the bound origin; redirects never carry the secret to another
   * origin. The plugin only ever sends the opaque id, never the value.
   */
  networkSecrets?: Readonly<Record<string, NetworkSecret>>;
  /** §29 proxy: executor-level proxy URL (http:// or https://). Never
   * plugin-controlled — a plugin-set proxy would be a local pivoting hole. */
  proxyUrl?: string;
  /** §29 keep-alive/pooling: transport pool bounds (defaults per contracts). */
  networkPool?: NetworkPoolOptions;
  /**
   * §29.1.1 scope capabilities: effective network reach of one plugin at one
   * moment. Computed host-side from the plugin's grants; a non-public
   * destination is allowed only when the matching scope flag is set. The
   * default derives the scope from the in-memory `grants` map (testing /
   * reference host); production wires a DB-backed provider from
   * `grantsSource`.
   */
  networkScopeProvider?: (pluginId: string) => NetworkScope;
  /** Injectable model registry (tests stub `models.list`). Returns the
   * available models for a configured provider id, or `null` if the provider
   * is unknown. In production this is backed by the provider adapter
   * `listModels()` call (§12 Models). */
  modelsProvider?: (providerId: string) => Promise<ModelInfo[] | null>;
  /** Injectable chat list query (tests stub `chats.list`). Returns a page of
   * chat summaries + next cursor for the given query. In production this is
   * backed by the chats repository (`ctx.database.repos.chats`). */
  chatsList?: (query: {
    cursor?: string;
    limit?: number;
    characterId?: string;
  }) => Promise<{ items: ChatSummary[]; nextCursor: string | null }>;
  /** Injectable chat read (tests stub `chats.read`). Returns the full chat
   * or `null` if not found. */
  chatsRead?: (chatId: string) => Promise<Chat | null>;
  /** Injectable character list query (tests stub `characters.list`). Returns
   * a page of character summaries + next cursor. In production backed by
   * `ctx.database.repos.characters`. */
  charactersList?: (query: {
    cursor?: string;
    limit?: number;
  }) => Promise<{ items: CharacterSummary[]; nextCursor: string | null }>;
  /** Injectable character read (tests stub `characters.read`). Returns the
   * full character or `null` if not found. */
  charactersRead?: (characterId: string) => Promise<Character | null>;
  /** Injectable lorebook list query (tests stub `lorebook.list`). Returns a
   * page of books + next cursor. In production backed by
   * `ctx.database.repos.lorebooks`. */
  lorebooksList?: (query: {
    cursor?: string;
    limit?: number;
    characterId?: string;
  }) => Promise<{ items: Lorebook[]; nextCursor: string | null }>;
  /** Injectable lorebook read (tests stub `lorebook.read`). Returns the full
   * book or `null` if not found. */
  lorebookRead?: (bookId: string) => Promise<Lorebook | null>;
  /** Injectable lorebook entries read (tests stub `lorebook.entries`). Returns
   * the entries of a book or `null` when the book does not exist. */
  lorebookEntries?: (bookId: string) => Promise<LorebookEntry[] | null>;
  /** Injectable core DB read query (tests stub `database.core.query`). Runs a
   * read-only SELECT/WITH statement against the app database (in production
   * backed by a prepared statement on `ctx.database`); the executor rejects
   * write statements before delegating. Returns column names + primitive rows
   * (null/string/number/boolean). */
  dbQuery?: (query: {
    sql: string;
    params: unknown[];
  }) => Promise<{ columns: string[]; rows: unknown[][] }>;
  /**
   * Live-delivery push sink (§18, Stage F): called for every event emitted
   * after a subscription registered. The implementation routes the envelope
   * to the subscribing worker over the runtime wire; returning `false` means
   * the subscription is no longer routable (worker gone) and the executor
   * drops it. Absent sink = the event core stays replay-only.
   */
  eventPushSink?: (subscriptionId: string, envelope: SdkEventEnvelope) => boolean;
  /**
   * §30 Files API: plugin-owned data directory resolver. Defaults to a
   * per-plugin directory under the OS temp dir (testing/reference host);
   * production wires `join(pluginsRoot, pluginId, 'data')`. Every files.*
   * operation is confined to the resolved root: absolute paths, `..`
   * segments and symlink escapes are rejected.
   */
  filesRoot?: (pluginId: string) => string;
  /**
   * §32.1 process API: scoped-mode policy. Defaults to a scope that allows
   * only the current Node executable with the plugin's files root as cwd
   * (reference host / tests). Production derives the scope from the
   * plugin manifest (§32.1: executables + cwd roots).
   */
  processScope?: (pluginId: string) => ProcessScope | undefined;
  /**
   * §19/§27 Jobs API: host-side push sink, called when a scheduled job
   * fires. The production host routes the envelope to the owning worker
   * over the runtime wire (`job-run` bridge message); absent sink = jobs
   * still register/list/cancel but never fire (reference host / tests).
   */
  jobPushSink?: (pluginId: string, envelope: SdkJobRunEnvelope) => boolean;
  /**
   * §34 Services API: host-side sink for cross-plugin calls, wired by the
   * broker host (`createVNextBrokerHost`) which routes `service-call`
   * bridge messages to the provider's worker; `false` drops a call whose
   * provider worker is gone (surfaces as SERVICE_UNAVAILABLE).
   */
  serviceCallSink?: (pluginId: string, envelope: SdkServiceCallEnvelope) => boolean;
  /** §33 Secrets API: host-side provider backed by the OAuth repo. */
  secretsProvider?: SecretsProvider;
}

export interface MemoryHostExecutor {
  policy: BrokerPolicy;
  /** Grant capabilities to a plugin at runtime (host consent simulation). */
  grant(pluginId: string, ...capabilities: string[]): void;
  /** Remove a capability grant (host-side revoke, §10.2 decision layer). */
  revoke(pluginId: string, capability: string): void;
  /** True when the plugin currently holds the capability. */
  isGranted(pluginId: string, capability: string): boolean;
  /** KV store snapshot for one plugin (tests/diagnostics). */
  kvSnapshot(pluginId: string): Record<string, unknown>;
  /** Settings snapshot for one plugin (tests/diagnostics). */
  settingsSnapshot(pluginId: string): Record<string, unknown>;
  /** Host-side event emission (§18: the event core is centralized; plugins
   * consume via `sdk.events.replay`, they do not emit). */
  emit(name: string, payload: unknown): SdkEventEnvelope;
  /** Buffered (unexpired) events for one name (tests/diagnostics). */
  eventsSnapshot(name: string): SdkEventEnvelope[];
  /** Live subscription count across plugins (tests/diagnostics). */
  eventSubscriptionCount(): number;
  /**
   * Release transport resources: closes the §29 network pool (keep-alive
   * sockets) if the built-in transport was ever used. Idempotent; a no-op
   * when an injectable `fetchImpl` carried all traffic.
   */
  close(): Promise<void>;
}

interface EventEntry {
  seq: number;
  name: string;
  emittedAt: number;
  payload: unknown;
}

interface EventNameState {
  entries: EventEntry[];
  /** Seq assigned to the next emitted event for this name. */
  nextSeq: number;
  /** Highest seq removed from the buffer (per-name cap, global cap or TTL);
   * cursors below-or-at it point at lost events. */
  evictedUpToSeq: number;
}

interface EventWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}

/** One live-delivery subscription (§18, Stage F): events emitted after
 * registration are pushed to the subscribing worker via `eventPushSink`. */
interface EventSubscription {
  id: string;
  pluginId: string;
  name: string;
}

export function createMemoryHostExecutor(options: MemoryHostOptions = {}): MemoryHostExecutor {
  const now = options.now ?? Date.now;
  // §29 keep-alive/pooling: the built-in transport is a lazily created pool
  // (agents, bounded sockets). Injectable fetchImpl (tests) bypasses it, so
  // tests never leave pooled sockets behind.
  let pool: NetworkPool | null = null;
  function getPool(): NetworkPool {
    if (pool === null) {
      pool = createNetworkPool({ proxyUrl: options.proxyUrl, ...options.networkPool });
    }
    return pool;
  }
  const fetchImpl =
    options.fetchImpl ?? ((url, init, verified) => getPool().fetch(url, init, verified));
  const dnsLookupImpl =
    options.dnsLookupImpl ??
    (async (hostname: string) => {
      const records = await dnsLookup(hostname, { all: true });
      return records.map((r) => r.address);
    });
  const modelsProvider = options.modelsProvider ?? (async () => null);
  const chatsList =
    options.chatsList ??
    (async (): Promise<{ items: ChatSummary[]; nextCursor: string | null }> => ({
      items: [],
      nextCursor: null,
    }));
  const chatsRead = options.chatsRead ?? (async (): Promise<Chat | null> => null);
  const charactersList =
    options.charactersList ??
    (async (): Promise<{ items: CharacterSummary[]; nextCursor: string | null }> => ({
      items: [],
      nextCursor: null,
    }));
  const charactersRead = options.charactersRead ?? (async (): Promise<Character | null> => null);
  const lorebooksList =
    options.lorebooksList ??
    (async (): Promise<{ items: Lorebook[]; nextCursor: string | null }> => ({
      items: [],
      nextCursor: null,
    }));
  const lorebookRead = options.lorebookRead ?? (async (): Promise<Lorebook | null> => null);
  const lorebookEntries =
    options.lorebookEntries ?? (async (): Promise<LorebookEntry[] | null> => []);
  const dbQuery =
    options.dbQuery ??
    (async (): Promise<{ columns: string[]; rows: unknown[][] }> => ({
      columns: [],
      rows: [],
    }));
  const grants = new Map<string, Set<string>>();
  for (const [pluginId, capabilities] of Object.entries(options.grants ?? {})) {
    grants.set(pluginId, new Set(capabilities));
  }
  // §29.1.1 scope capabilities: the default provider derives the effective
  // network reach from the in-memory grants map (reference host / tests).
  // Production wires a DB-backed provider from `grantsSource` (vnextBroker).
  const scopeProvider =
    options.networkScopeProvider ??
    ((pluginId: string): NetworkScope => ({
      local: grants.get(pluginId)?.has(NETWORK_SCOPE_LOCAL) ?? false,
      private: grants.get(pluginId)?.has(NETWORK_SCOPE_PRIVATE) ?? false,
      metadata: grants.get(pluginId)?.has(NETWORK_SCOPE_METADATA) ?? false,
    }));
  const kvStores = new Map<string, Map<string, unknown>>();
  const settingsStores = new Map<string, Map<string, unknown>>();

  // ---- §30 Files API: plugin-scoped roots with path confinement ----

  const defaultFilesRoot = (pluginId: string): string =>
    join(tmpdir(), 'neotavern-sdk-files', pluginId.replace(/[^a-zA-Z0-9._-]/g, '_'));
  const filesRootOf = options.filesRoot ?? defaultFilesRoot;

  /** Split a plugin-relative path and reject traversal primitives. */
  function splitPluginPath(path: string): string[] {
    if (path === '.') return [];
    if (
      path.length === 0 ||
      path.length > FILES_MAX_CONTENT_BYTES ||
      path.includes('\0') ||
      path.includes('\\') ||
      isAbsolute(path) ||
      /^[a-z]:/iu.test(path)
    ) {
      throw new BrokerCallError(BrokerErrorCode.VALIDATION_FAILED, {
        message: 'unsafe file path',
        details: { path },
      });
    }
    const segments = path.split('/');
    if (
      segments.length === 0 ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new BrokerCallError(BrokerErrorCode.VALIDATION_FAILED, {
        message: 'unsafe file path',
        details: { path },
      });
    }
    return segments;
  }

  function isPathWithinRoot(root: string, candidate: string): boolean {
    const difference = relative(root, candidate);
    return (
      difference === '' ||
      (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
    );
  }

  function isMissingPathError(error: unknown): boolean {
    return (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    );
  }

  async function realpathIfExists(path: string): Promise<string | null> {
    try {
      return await realpath(path);
    } catch (error) {
      if (isMissingPathError(error)) return null;
      throw error;
    }
  }

  async function nearestExistingRealpath(path: string): Promise<string | null> {
    let current = path;
    while (true) {
      const canonical = await realpathIfExists(current);
      if (canonical !== null) return canonical;
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

  /** Resolve a plugin-relative path inside the plugin root; re-check the
   * real path so a symlink cannot escape the root (§30). */
  async function resolvePluginPath(pluginId: string, path: string): Promise<string> {
    const root = resolve(filesRootOf(pluginId));
    const target = resolve(root, ...splitPluginPath(path));
    if (!isPathWithinRoot(root, target)) {
      throw new BrokerCallError(BrokerErrorCode.VALIDATION_FAILED, {
        message: 'file path escapes the plugin root',
        details: { path },
      });
    }
    const realRoot = await realpathIfExists(root);
    const realTarget = realRoot === null ? null : await nearestExistingRealpath(target);
    if (realRoot !== null && realTarget !== null && !isPathWithinRoot(realRoot, realTarget)) {
      throw new BrokerCallError(BrokerErrorCode.VALIDATION_FAILED, {
        message: 'file path escapes the plugin root via symlink',
        details: { path },
      });
    }
    return target;
  }

  const catalog = new Map(SDK_OPERATION_CATALOG.map((entry) => [entry.method, entry]));

  const kvStore = (pluginId: string): Map<string, unknown> => {
    let store = kvStores.get(pluginId);
    if (store === undefined) {
      store = new Map();
      kvStores.set(pluginId, store);
    }
    return store;
  };
  const settingsStore = (pluginId: string): Map<string, unknown> => {
    let store = settingsStores.get(pluginId);
    if (store === undefined) {
      store = new Map();
      settingsStores.set(pluginId, store);
    }
    return store;
  };

  // ---- Events channel (§18, ADR-0025 §J1): bounded ring + waiters ----

  const eventStates = new Map<string, EventNameState>();
  const waitersByEvent = new Map<string, Set<EventWaiter>>();
  const subscriptions = new Map<string, EventSubscription>();
  const subscriptionsByPlugin = new Map<string, Set<string>>();
  let waiterCount = 0;
  const eventPushSink = options.eventPushSink;
  let subscriptionSeq = 0;

  const eventState = (name: string): EventNameState => {
    let state = eventStates.get(name);
    if (state === undefined) {
      state = { entries: [], nextSeq: 1, evictedUpToSeq: 0 };
      eventStates.set(name, state);
    }
    return state;
  };

  function sweepExpired(name: string): void {
    const state = eventStates.get(name);
    if (state === undefined || state.entries.length === 0) return;
    const cutoff = now() - EVENTS_TTL_MS;
    let removed = 0;
    while (removed < state.entries.length && state.entries[removed]!.emittedAt < cutoff) {
      removed += 1;
    }
    if (removed === 0) return;
    for (const entry of state.entries.slice(0, removed)) {
      state.evictedUpToSeq = Math.max(state.evictedUpToSeq, entry.seq);
    }
    state.entries.splice(0, removed);
  }

  function evictGlobalOldest(): void {
    const oldest = { name: '', seq: Number.POSITIVE_INFINITY };
    for (const [name, state] of eventStates) {
      const first = state.entries[0];
      if (first !== undefined && first.seq < oldest.seq) {
        oldest.name = name;
        oldest.seq = first.seq;
      }
    }
    if (oldest.name === '') return;
    const state = eventStates.get(oldest.name)!;
    const removed = state.entries.shift()!;
    state.evictedUpToSeq = Math.max(state.evictedUpToSeq, removed.seq);
  }

  function emit(name: string, payload: unknown): SdkEventEnvelope {
    const state = eventState(name);
    sweepExpired(name);
    const envelope: EventEntry = { seq: state.nextSeq, name, emittedAt: now(), payload };
    state.nextSeq += 1;
    state.entries.push(envelope);
    while (state.entries.length > EVENTS_PER_NAME) {
      const removed = state.entries.shift()!;
      state.evictedUpToSeq = Math.max(state.evictedUpToSeq, removed.seq);
    }
    let total = 0;
    for (const s of eventStates.values()) total += s.entries.length;
    while (total > EVENTS_TOTAL) {
      evictGlobalOldest();
      total -= 1;
    }
    const waiters = waitersByEvent.get(name);
    if (waiters !== undefined && waiters.size > 0) {
      for (const waiter of [...waiters]) waiter.resolve();
      waiters.clear();
    }
    // Stage F live delivery: every subscription on this name receives the
    // envelope via the sink; a `false` sink result means the worker is gone,
    // so the subscription is dropped (self-cleaning, no leak on worker death).
    if (eventPushSink !== undefined) {
      for (const [id, subscription] of subscriptions) {
        if (subscription.name !== name) continue;
        if (!eventPushSink(id, envelope)) {
          subscriptions.delete(id);
          subscriptionsByPlugin.get(subscription.pluginId)?.delete(id);
        }
      }
    }
    return envelope;
  }

  function readReplay(args: SdkEventsReplayArgs): SdkEventsReplayResult {
    const state = eventState(args.name);
    const cursor = args.cursor ?? null;
    const limit = args.limit ?? EVENTS_MAX_REPLAY_LIMIT;
    if (cursor !== null && cursor < state.evictedUpToSeq) {
      throw new BrokerCallError('EVENT_CURSOR_EXPIRED', {
        message: 'cursor fell outside the replay window',
        details: { name: args.name, cursor, evictedUpToSeq: state.evictedUpToSeq },
      });
    }
    if (cursor !== null && cursor >= state.nextSeq) {
      throw new BrokerCallError(BrokerErrorCode.VALIDATION_FAILED, {
        message: 'cursor is ahead of the newest emitted event',
        details: { name: args.name, cursor, nextSeq: state.nextSeq },
      });
    }
    const from = cursor === null ? 0 : state.entries.findIndex((e) => e.seq > cursor);
    if (from === -1) {
      return { events: [], nextCursor: cursor };
    }
    const events = state.entries.slice(from, from + limit);
    return { events, nextCursor: events[events.length - 1]?.seq ?? cursor };
  }

  function waitForEvent(name: string, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    if (waiterCount >= EVENTS_MAX_WAITERS) {
      return Promise.reject(
        new BrokerCallError(BrokerErrorCode.SERVICE_UNAVAILABLE, {
          message: 'too many concurrent event waiters',
        }),
      );
    }
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        const set = waitersByEvent.get(name);
        if (set !== undefined) {
          set.delete(waiter);
          if (set.size === 0) waitersByEvent.delete(name);
          waiterCount -= 1;
        }
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(signal.reason);
      };
      const waiter: EventWaiter = {
        resolve: () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(true);
        },
        reject: () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new BrokerCallError(BrokerErrorCode.INTERNAL, { message: 'waiter cancelled' }));
        },
        cleanup,
      };
      let set = waitersByEvent.get(name);
      if (set === undefined) {
        set = new Set();
        waitersByEvent.set(name, set);
      }
      set.add(waiter);
      waiterCount += 1;
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      const onTimeout = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      };
      const timer = setTimeout(onTimeout, timeoutMs);
    });
  }

  async function replayWithWait(
    args: SdkEventsReplayArgs,
    budgetMs: number,
    signal: AbortSignal,
  ): Promise<SdkEventsReplayResult> {
    const deadline = now() + budgetMs;
    for (;;) {
      sweepExpired(args.name);
      const result = readReplay(args);
      if (result.events.length > 0) return result;
      const remaining = deadline - now();
      if (budgetMs <= 0 || remaining <= 0) return result;
      const woke = await waitForEvent(args.name, remaining, signal);
      if (!woke) return readReplay(args);
    }
  }

  // ---- Network fetch (§29, SSRF-hardened) ----

  /**
   * §29.1.1 scope classification: classify a resolved IP into one of four
   * buckets — `'public'` (allowed by `network.http` alone), `'local'`
   * (loopback / `0.0.0.0/8` — requires `network.local`), `'metadata'`
   * (cloud metadata endpoints `169.254.169.254` / `169.254.170.2` — requires
   * `network.metadata`, checked BEFORE link-local), or `'private'`
   * (RFC1918, link-local, ULA, multicast/reserved — requires
   * `network.private`).
   *
   * The scope policy in `checkDestination` admits a non-public address only
   * when the plugin's effective `NetworkScope` has the matching flag set.
   */
  function classifyAddress(ip: string): 'public' | 'local' | 'private' | 'metadata' {
    const normalized = normalizeIpLiteral(ip);
    // IPv4 literal.
    const v4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4 !== null) {
      const [a, b] = [Number(v4[1]), Number(v4[2])];
      if (a === 127 || a === 0) return 'local'; // loopback / 0.0.0.0/8
      // Cloud metadata endpoints are checked BEFORE link-local so they get
      // the dedicated `network.metadata` scope, not `network.private`.
      if (a === 169 && b === 254 && (Number(v4[3]) === 169 || Number(v4[3]) === 170)) {
        return 'metadata';
      }
      if (a === 10) return 'private'; // private 10/8
      if (a === 172 && b >= 16 && b <= 31) return 'private'; // private 172.16/12
      if (a === 192 && b === 168) return 'private'; // private 192.168/16
      if (a === 169 && b === 254) return 'private'; // link-local (non-metadata)
      if (a >= 224) return 'private'; // multicast / reserved
      return 'public';
    }
    // IPv6 literal. Brackets are already stripped by normalizeIpLiteral;
    // IPv4-mapped spellings (dotted `::ffff:127.0.0.1` or hex `::ffff:7f00:1`)
    // are re-checked against the v4 rules so loopback/private can never hide
    // behind the mapped form (ТЗ §SEC-03).
    const lower = normalized.toLowerCase();
    if (lower === '::1' || lower === '::') return 'local'; // loopback / unspecified
    if (lower.startsWith('fe80')) return 'private'; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return 'private'; // ULA fc00::/7
    const mapped = mappedIpv4(lower);
    if (mapped !== null) return classifyAddress(mapped);
    return 'public';
  }

  /**
   * §29.1.1 destination policy: classify every resolved address and admit it
   * only when the plugin's effective scope covers the classification. A
   * non-public address without the matching scope flag is denied with
   * `NETWORK_DESTINATION_DENIED` (or `NETWORK_REDIRECT_DENIED` on a redirect
   * hop, §29.1.3). The error's `details.requiredScope` names the missing
   * capability so the frontend can localize a helpful message.
   *
   * Returns the approved address list: the transport connects to one of these
   * IPs and verifies the connected `remoteAddress` against the same set
   * (ТЗ §SEC-03 — the policy decision and the actual connection share one
   * resolution, closing the DNS-rebinding window).
   */
  async function checkDestination(
    hostname: string,
    isRedirect: boolean,
    scope: NetworkScope,
  ): Promise<string[]> {
    // Bare IP literal: parse directly. Otherwise resolve and policy-check
    // every resolved address (§29.1.2 DNS rebinding). Bracketed IPv6 literals
    // ("[::1]") are normalized before classification.
    const looksLikeIp = hostname.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
    const ips = looksLikeIp ? [hostname] : await dnsLookupImpl(hostname);
    const approved: string[] = [];
    for (const raw of ips) {
      const ip = normalizeIpLiteral(raw);
      const classification = classifyAddress(ip);
      if (classification === 'public') {
        approved.push(ip);
        continue;
      }
      const requiredScope =
        classification === 'local'
          ? NETWORK_SCOPE_LOCAL
          : classification === 'metadata'
            ? NETWORK_SCOPE_METADATA
            : NETWORK_SCOPE_PRIVATE;
      const allowed =
        classification === 'local'
          ? scope.local
          : classification === 'metadata'
            ? scope.metadata
            : scope.private;
      if (!allowed) {
        throw new BrokerCallError(
          isRedirect ? 'NETWORK_REDIRECT_DENIED' : 'NETWORK_DESTINATION_DENIED',
          {
            message: 'destination rejected by the SSRF scope policy',
            details: { hostname, ip, classification, requiredScope },
          },
        );
      }
      approved.push(ip);
    }
    return approved;
  }

  async function performFetch(
    args: SdkNetworkFetchArgs,
    signal: AbortSignal,
    pluginId: string,
  ): Promise<SdkNetworkFetchResult> {
    const scope = scopeProvider(pluginId);
    let currentUrl = args.url;
    const redirects: string[] = [];
    const headers = args.headers ?? {};
    const method = args.method ?? 'GET';
    const resolvedSecret = resolveSecret(args, pluginId);
    let isRedirectHop = false;
    for (let hop = 0; hop <= NETWORK_MAX_REDIRECTS; hop += 1) {
      let parsed: URL;
      try {
        parsed = new URL(currentUrl);
      } catch {
        throw new BrokerCallError(BrokerErrorCode.VALIDATION_FAILED, {
          message: 'invalid url',
          details: { url: currentUrl },
        });
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new BrokerCallError(
          isRedirectHop ? 'NETWORK_REDIRECT_DENIED' : 'NETWORK_DESTINATION_DENIED',
          {
            message: 'non-http scheme rejected',
            details: { scheme: parsed.protocol },
          },
        );
      }
      const approved = await checkDestination(parsed.hostname, isRedirectHop, scope);
      // §29.1.5: a secret pins the destination policy — the first hop must
      // stay inside the bound origin (no `use secret X + arbitrary Y`).
      // Redirects do NOT reject: they simply continue WITHOUT the secret
      // (a redirect never carries the injected secret to another origin).
      if (
        resolvedSecret !== null &&
        !isRedirectHop &&
        parsed.origin !== resolvedSecret.secretOrigin
      ) {
        throw new BrokerCallError('NETWORK_SECRET_ORIGIN_MISMATCH', {
          message: 'secret is bound to a different origin',
          details: { secretId: args.secretId, targetOrigin: parsed.origin },
        });
      }
      // The injected secret travels only while the hop stays inside the
      // secret's bound origin; a redirect that leaves it continues WITHOUT
      // the secret headers.
      let hopHeaders = headers;
      if (resolvedSecret !== null && parsed.origin === resolvedSecret.secretOrigin) {
        hopHeaders = { ...headers, ...resolvedSecret.secret.headers };
      }
      const init: RequestInit = { method, headers: hopHeaders, redirect: 'manual', signal };
      if (args.body !== undefined && args.body !== null && method !== 'GET' && method !== 'HEAD') {
        init.body = args.body;
      }
      let resp: Response;
      try {
        // The approved list is the same resolution the policy check above
        // admitted: the transport connects to one of these IPs and verifies
        // the connected remoteAddress against them (ТЗ §SEC-03).
        resp = await fetchImpl(currentUrl, init, { ips: approved });
      } catch (error) {
        if (error instanceof VerifiedIpMismatchError) {
          throw new BrokerCallError('NETWORK_DESTINATION_DENIED', {
            message: 'connected address not in the approved set',
            details: { hostname: parsed.hostname, remoteAddress: error.remoteAddress },
          });
        }
        throw error;
      }
      const status = resp.status;
      const location = resp.headers.get('location');
      if (status >= 300 && status < 400 && location !== null) {
        if (args.redirect === 'manual') {
          return responseEnvelope(resp, currentUrl, redirects);
        }
        const nextUrl = new URL(location, currentUrl).toString();
        redirects.push(nextUrl);
        currentUrl = nextUrl;
        isRedirectHop = true;
        continue;
      }
      return responseEnvelope(resp, currentUrl, redirects);
    }
    throw new BrokerCallError('NETWORK_REDIRECT_DENIED', {
      message: 'too many redirects',
      details: { hops: NETWORK_MAX_REDIRECTS + 1 },
    });
  }

  /**
   * §29.1.5: resolve the opaque secret handle. Unknown handle and malformed
   * bound origin fail the call before any byte leaves the executor; a bound
   * secret pins the destination policy (no `use secret X + arbitrary Y`).
   * §33 handles are per-plugin: a handle minted for another plugin is
   * unknown here.
   */
  function resolveSecret(
    args: SdkNetworkFetchArgs,
    pluginId: string,
  ): {
    secret: NetworkSecret;
    secretOrigin: string;
  } | null {
    if (args.secretId === undefined) return null;
    if (args.secretId.startsWith('sec-')) {
      const live = liveSecrets.get(args.secretId);
      if (live === undefined || live.pluginId !== pluginId) {
        throw new BrokerCallError('NETWORK_SECRET_NOT_FOUND', {
          message: 'unknown secret handle',
          details: { secretId: args.secretId },
        });
      }
      return { secret: live.secret, secretOrigin: live.secret.origin };
    }
    const secret = options.networkSecrets?.[args.secretId];
    if (secret === undefined) {
      throw new BrokerCallError('NETWORK_SECRET_NOT_FOUND', {
        message: 'unknown secret handle',
        details: { secretId: args.secretId },
      });
    }
    let secretOrigin: string;
    try {
      secretOrigin = new URL(secret.origin).origin;
    } catch {
      throw new BrokerCallError('NETWORK_SECRET_INVALID', {
        message: 'secret is not bound to a valid origin',
      });
    }
    return { secret, secretOrigin };
  }

  async function responseEnvelope(
    resp: Response,
    finalUrl: string,
    redirects: string[],
  ): Promise<SdkNetworkFetchResult> {
    const headers: Record<string, string> = {};
    let count = 0;
    for (const [name, value] of resp.headers.entries()) {
      if (count >= NETWORK_MAX_HEADERS) break;
      headers[name] = value;
      count += 1;
    }
    const body = await readBoundedText(resp, NETWORK_MAX_BODY_BYTES);
    return {
      status: resp.status,
      statusText: resp.statusText,
      headers,
      body,
      url: finalUrl,
      redirects,
    };
  }

  /**
   * §SEC-04 bounded read: stream the (possibly decompressed) body and stop at
   * the cap, destroying the response immediately once it is exceeded — the
   * body must never be accumulated in memory beyond the cap just to be
   * truncated. The truncation contract (a body of at most `cap` bytes) is
   * preserved. Non-streaming responses (body-less HEAD/204/304 and test
   * stubs without a `body` property) fall back to `text()` + slice.
   */
  async function readBoundedText(resp: Response, cap: number): Promise<string> {
    const body = resp.body;
    if (body === null || body === undefined || typeof body.getReader !== 'function') {
      const text = await resp.text();
      return text.length > cap ? text.slice(0, cap) : text;
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength === 0) continue;
        const room = cap - total;
        if (room <= 0) {
          await reader.cancel().catch(() => undefined);
          break;
        }
        if (value.byteLength > room) {
          chunks.push(value.subarray(0, room));
          total = cap;
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }

  // ---- §29 Socket API (Stage E): websocket / tcp / listen / udp ----
  // Trusted sockets live host-side; the plugin only ever holds opaque ids.
  const sockets: SocketRegistry = createSocketRegistry({
    checkDestination: async (host, pluginId) => {
      return checkDestination(host, false, scopeProvider(pluginId));
    },
    checkBind: (host, pluginId) => {
      // §29.1.4: unspecified addresses (0.0.0.0 / ::) mean "all interfaces" —
      // never inherited from Node semantics; a concrete interface is needed.
      if (host === '0.0.0.0' || host === '::') {
        throw new BrokerCallError('POLICY_DENIED', {
          message: 'unspecified bind address is not allowed; bind a concrete interface',
          details: { host },
        });
      }
      const classification = classifyAddress(host);
      if (classification === 'local') return; // §29.1.4: loopback always fine
      if (grants.get(pluginId)?.has('network.listen.public') === true) return;
      throw new BrokerCallError('POLICY_DENIED', {
        message: 'non-loopback bind requires network.listen.public',
        details: { host, classification, requiredCapability: 'network.listen.public' },
      });
    },
  });

  // ---- §13/§32 Process API (Stage E): scoped / unrestricted spawn ----
  // Default scope (reference host / tests): the current Node executable,
  // cwd confined to the plugin's files root.
  const defaultProcessScope = (pluginId: string): ProcessScope => {
    const root = filesRootOf(pluginId);
    return { executables: [process.execPath], cwdRoots: [root], defaultCwd: root };
  };
  const processScopeOf = options.processScope ?? defaultProcessScope;
  const processes: ProcessRegistry = createProcessRegistry();

  // ---- §19/§27 Jobs API (Stage E): host-side scheduler ----
  // Jobs are bounded registrations: timers live host-side, firing pushes a
  // `job-run` envelope through `jobPushSink` (production: bridge message to
  // the owning worker). Revoke or executor shutdown cancels every timer.
  interface ScheduledJob {
    jobId: string;
    pluginId: string;
    name: string;
    intervalMs: number | null;
    payload: unknown;
    timer: NodeJS.Timeout;
  }
  const jobs = new Map<string, ScheduledJob>();
  let jobSeq = 0;
  const jobPushSink = options.jobPushSink;
  const fireJob = (job: ScheduledJob): void => {
    if (jobPushSink === undefined) return;
    jobPushSink(job.pluginId, {
      jobId: job.jobId,
      name: job.name,
      payload: job.payload,
      scheduledAt: now(),
    });
  };
  const cancelJob = (jobId: string): void => {
    const job = jobs.get(jobId);
    if (job === undefined) return;
    clearTimeout(job.timer);
    jobs.delete(jobId);
  };

  // ---- §34 Services API (Stage E): brokered cross-plugin calls ----
  // `services.provide` registers name@version; `services.connect` resolves
  // the provider and pushes a `service-call` envelope through
  // `serviceCallSink` (production: bridge message to the provider worker).
  // The provider settles via `services.respond`, which resolves the caller's
  // pending connect promise. Causal chains (§26.2.1) reject A→B→A cycles
  // with SERVICE_CALL_CYCLE before anything is pushed.
  interface ServiceEntry {
    serviceId: string;
    pluginId: string;
    name: string;
    version: string;
    methods: Set<string>;
  }
  interface PendingServiceCall {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timer: NodeJS.Timeout;
    callerPluginId: string;
    providerPluginId: string;
  }
  const services = new Map<string, ServiceEntry>();
  const serviceByKey = new Map<string, string>();
  const pendingServiceCalls = new Map<string, PendingServiceCall>();
  let serviceSeq = 0;
  let serviceCallSeq = 0;
  const serviceCallSink = options.serviceCallSink;

  const dropService = (serviceId: string): void => {
    const entry = services.get(serviceId);
    if (entry === undefined) return;
    services.delete(serviceId);
    serviceByKey.delete(`${entry.name}@${entry.version}`);
  };
  const rejectPendingFor = (targetPluginId: string, code: string, message: string): void => {
    for (const [callId, pending] of pendingServiceCalls) {
      if (
        targetPluginId !== '*' &&
        pending.providerPluginId !== targetPluginId &&
        pending.callerPluginId !== targetPluginId
      ) {
        continue;
      }
      clearTimeout(pending.timer);
      pendingServiceCalls.delete(callId);
      pending.reject(new BrokerCallError(code, { message }));
    }
  };

  // ---- §33 Secrets API (Stage E): opaque per-plugin handles ----
  // `secrets.use` mints `sec-…` handles bound to the connection's origin;
  // `network.fetch` resolves them in resolveSecret (with the caller's
  // pluginId guard). Revoking a secrets capability closes the plugin's
  // handles (§10.2).
  const liveSecrets = new Map<string, { pluginId: string; secret: NetworkSecret }>();
  let secretSeq = 0;
  const secretsProvider = options.secretsProvider;
  const dropPluginSecrets = (pluginId: string): void => {
    for (const [handle, entry] of [...liveSecrets]) {
      if (entry.pluginId === pluginId) liveSecrets.delete(handle);
    }
  };

  // ---- Authorization and dispatch ----

  function authorize(call: BrokerCallRequest): BrokerDecision {
    const entry = catalog.get(call.method);
    if (entry === undefined) {
      return { allowed: false, code: 'PROTOCOL_UNSUPPORTED' };
    }
    if (entry.capability !== null) {
      if (entry.capability !== call.capability.name) {
        // The declared capability must match the catalog entry for the method;
        // a mismatch means the plugin asked for a different grant than the
        // operation actually needs.
        return {
          allowed: false,
          code: BrokerErrorCode.POLICY_DENIED,
          details: { expectedCapability: entry.capability },
        };
      }
      const granted = grants.get(call.caller.pluginId);
      if (granted === undefined || !granted.has(entry.capability)) {
        return { allowed: false, code: BrokerErrorCode.CAPABILITY_DENIED };
      }
    }
    // Core channels (capability: null, §18 events) skip the grant check; the
    // broker core still enforces identity, deadline, cycles and bounds.
    // §33/§11.3: revealing the raw token requires the trusted level, on top
    // of the separate `secrets.reveal` grant.
    if (call.method === 'secrets.reveal' && call.caller.trustLevel !== 'trusted') {
      return { allowed: false, code: BrokerErrorCode.TRUST_REQUIRED };
    }
    return { allowed: true };
  }

  function decodedArgs(schema: Parameters<typeof validateSchema>[0], args: unknown): unknown {
    const decoded = validateSchema(schema, args);
    if (!decoded.ok) {
      throw new BrokerCallError(BrokerErrorCode.VALIDATION_FAILED, {
        message: 'operation arguments failed validation',
      });
    }
    return decoded.value;
  }

  // Core DB read gate (§31): only a single read-only SELECT/WITH statement is
  // admitted. Conservative defense-in-depth: write verbs and DB-mutating
  // keywords are rejected on the host side as well, so a compromised worker
  // cannot escalate `database.core.read` into a write.
  const DB_WRITE_KEYWORDS = [
    'ALTER',
    'ATTACH',
    'CREATE',
    'DELETE',
    'DETACH',
    'DROP',
    'INSERT',
    'PRAGMA',
    'REINDEX',
    'REPLACE',
    'UPDATE',
    'VACUUM',
  ];

  function assertReadOnlyStatement(sql: string): void {
    const stripped = sql
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ')
      .trim();
    const body = stripped.endsWith(';') ? stripped.slice(0, -1).trimEnd() : stripped;
    if (body.length === 0 || body.includes(';')) {
      throw new BrokerCallError(BrokerErrorCode.POLICY_DENIED, {
        message: 'only a single SQL statement is allowed',
      });
    }
    const first = /^[A-Za-z_]+/.exec(body)?.[0].toUpperCase();
    if (first !== 'SELECT' && first !== 'WITH') {
      throw new BrokerCallError(BrokerErrorCode.POLICY_DENIED, {
        message: 'only read-only SELECT/WITH statements are allowed',
      });
    }
    const upper = body.toUpperCase();
    for (const keyword of DB_WRITE_KEYWORDS) {
      if (new RegExp(`\\b${keyword}\\b`).test(upper)) {
        throw new BrokerCallError(BrokerErrorCode.POLICY_DENIED, {
          message: `keyword ${keyword} is not allowed in a read-only query`,
        });
      }
    }
  }

  function assertBindableParams(params: unknown[]): void {
    for (const param of params) {
      if (typeof param === 'number' && !Number.isFinite(param)) {
        throw new BrokerCallError(BrokerErrorCode.VALIDATION_FAILED, {
          message: 'non-finite numbers cannot be bound',
        });
      }
    }
  }

  async function execute(call: BrokerCallRequest, signal: AbortSignal): Promise<unknown> {
    const pluginId = call.caller.pluginId;
    switch (call.method) {
      case 'storage.kv.get': {
        const { key } = decodedArgs(SdkKvGetArgsSchema, call.args ?? {}) as { key: string };
        return { value: kvStore(pluginId).get(key) ?? null };
      }
      case 'storage.kv.set': {
        const { key, value } = decodedArgs(SdkKvSetArgsSchema, call.args ?? {}) as {
          key: string;
          value: unknown;
        };
        kvStore(pluginId).set(key, value);
        return { ok: true };
      }
      case 'storage.kv.delete': {
        const { key } = decodedArgs(SdkKvDeleteArgsSchema, call.args ?? {}) as { key: string };
        return { deleted: kvStore(pluginId).delete(key) };
      }
      case 'storage.kv.list': {
        decodedArgs(SdkKvListArgsSchema, call.args ?? {});
        return { keys: [...kvStore(pluginId).keys()] };
      }
      case 'settings.get': {
        const { path } = decodedArgs(SdkSettingsGetArgsSchema, call.args ?? {}) as {
          path: string;
        };
        return { value: settingsStore(pluginId).get(path) ?? null };
      }
      case 'settings.set': {
        const { path, value } = decodedArgs(SdkSettingsSetArgsSchema, call.args ?? {}) as {
          path: string;
          value: unknown;
        };
        settingsStore(pluginId).set(path, value);
        return { ok: true };
      }
      case 'events.replay': {
        const args = decodedArgs(SdkEventsReplayArgsSchema, call.args ?? {}) as SdkEventsReplayArgs;
        const deadlineMs = Math.max(0, call.deadlineAt - now());
        // A small margin keeps the waiter from racing the broker core's
        // in-flight deadline abort; the call then completes normally.
        const budgetMs = Math.min(
          args.waitMs ?? 0,
          EVENTS_MAX_WAIT_MS,
          Math.max(0, deadlineMs - 25),
        );
        return replayWithWait(args, budgetMs, signal);
      }
      case 'events.subscribe': {
        const args = decodedArgs(SdkEventsSubscribeArgsSchema, call.args ?? {}) as {
          name: string;
        };
        const owned = subscriptionsByPlugin.get(pluginId)?.size ?? 0;
        if (owned >= EVENTS_MAX_SUBSCRIPTIONS_PER_PLUGIN) {
          throw new BrokerCallError(BrokerErrorCode.SERVICE_UNAVAILABLE, {
            message: 'too many concurrent event subscriptions',
            details: { pluginId, limit: EVENTS_MAX_SUBSCRIPTIONS_PER_PLUGIN },
          });
        }
        const id = `sub-${pluginId.slice(0, 24)}-${++subscriptionSeq}-${randomUUID().slice(0, 8)}`;
        const subscription: EventSubscription = { id, pluginId, name: args.name };
        subscriptions.set(id, subscription);
        let ownedSet = subscriptionsByPlugin.get(pluginId);
        if (ownedSet === undefined) {
          ownedSet = new Set();
          subscriptionsByPlugin.set(pluginId, ownedSet);
        }
        ownedSet.add(id);
        return { subscriptionId: id };
      }
      case 'events.unsubscribe': {
        const args = decodedArgs(SdkEventsUnsubscribeArgsSchema, call.args ?? {}) as {
          subscriptionId: string;
        };
        const subscription = subscriptions.get(args.subscriptionId);
        if (subscription !== undefined && subscription.pluginId === pluginId) {
          subscriptions.delete(args.subscriptionId);
          subscriptionsByPlugin.get(pluginId)?.delete(args.subscriptionId);
        }
        // Idempotent: unsubscribing an unknown or foreign subscription is ok.
        return { ok: true };
      }
      case 'network.http.fetch': {
        const args = decodedArgs(SdkNetworkFetchArgsSchema, call.args ?? {}) as SdkNetworkFetchArgs;
        return performFetch(args, signal, pluginId);
      }
      case 'network.websocket.open': {
        const args = decodedArgs(SdkNetworkWebsocketOpenArgsSchema, call.args ?? {}) as {
          url: string;
          protocols?: string[];
        };
        return { id: await sockets.websocketOpen(pluginId, args.url, args.protocols) };
      }
      case 'network.websocket.send': {
        const args = decodedArgs(SdkNetworkSocketSendArgsSchema, call.args ?? {}) as {
          id: string;
          data: string;
        };
        await sockets.websocketSend(pluginId, args.id, args.data);
        return { ok: true };
      }
      case 'network.websocket.receive': {
        const args = decodedArgs(SdkNetworkSocketReceiveArgsSchema, call.args ?? {}) as {
          id: string;
          limit?: number;
          waitMs?: number;
        };
        return sockets.websocketReceive(
          pluginId,
          args.id,
          args.limit ?? 1,
          args.waitMs ?? 0,
          signal,
        );
      }
      case 'network.websocket.close': {
        const args = decodedArgs(SdkNetworkSocketIdArgsSchema, call.args ?? {}) as { id: string };
        await sockets.websocketClose(pluginId, args.id);
        return { ok: true };
      }
      case 'network.tcp.connect': {
        const args = decodedArgs(SdkNetworkTcpConnectArgsSchema, call.args ?? {}) as {
          host: string;
          port: number;
          tls?: boolean;
        };
        return { id: await sockets.tcpConnect(pluginId, args.host, args.port, args.tls ?? false) };
      }
      case 'network.tcp.send': {
        const args = decodedArgs(SdkNetworkSocketSendArgsSchema, call.args ?? {}) as {
          id: string;
          data: string;
        };
        await sockets.tcpSend(pluginId, args.id, args.data);
        return { ok: true };
      }
      case 'network.tcp.receive': {
        const args = decodedArgs(SdkNetworkSocketReceiveArgsSchema, call.args ?? {}) as {
          id: string;
          limit?: number;
          waitMs?: number;
        };
        return sockets.tcpReceive(pluginId, args.id, args.limit ?? 1, args.waitMs ?? 0, signal);
      }
      case 'network.tcp.close': {
        const args = decodedArgs(SdkNetworkSocketIdArgsSchema, call.args ?? {}) as { id: string };
        await sockets.tcpClose(pluginId, args.id);
        return { ok: true };
      }
      case 'network.listen.open': {
        const args = decodedArgs(SdkNetworkListenOpenArgsSchema, call.args ?? {}) as {
          host?: string;
          port?: number;
        };
        return sockets.listenOpen(pluginId, args.host, args.port ?? 0);
      }
      case 'network.listen.accept': {
        const args = decodedArgs(SdkNetworkListenAcceptArgsSchema, call.args ?? {}) as {
          id: string;
          waitMs?: number;
        };
        return sockets.listenAccept(pluginId, args.id, args.waitMs ?? 0, signal);
      }
      case 'network.listen.close': {
        const args = decodedArgs(SdkNetworkSocketIdArgsSchema, call.args ?? {}) as { id: string };
        await sockets.listenClose(pluginId, args.id);
        return { ok: true };
      }
      case 'network.udp.open': {
        const args = decodedArgs(SdkNetworkUdpOpenArgsSchema, call.args ?? {}) as {
          bindHost?: string;
          bindPort?: number;
        };
        return sockets.udpOpen(pluginId, args.bindHost, args.bindPort ?? 0);
      }
      case 'network.udp.send': {
        const args = decodedArgs(SdkNetworkUdpSendArgsSchema, call.args ?? {}) as {
          id: string;
          data: string;
          host: string;
          port: number;
        };
        await sockets.udpSend(pluginId, args.id, args.data, args.host, args.port);
        return { ok: true };
      }
      case 'network.udp.receive': {
        const args = decodedArgs(SdkNetworkSocketIdArgsSchema, call.args ?? {}) as {
          id: string;
        };
        return sockets.udpReceive(pluginId, args.id, 0, signal);
      }
      case 'network.udp.close': {
        const args = decodedArgs(SdkNetworkSocketIdArgsSchema, call.args ?? {}) as { id: string };
        await sockets.udpClose(pluginId, args.id);
        return { ok: true };
      }
      case 'process.spawn': {
        const args = decodedArgs(SdkProcessSpawnArgsSchema, call.args ?? {}) as {
          executable: string;
          args?: string[];
          cwd?: string;
          env?: Record<string, string>;
          timeoutMs?: number;
          stdout?: string;
          stderr?: string;
        };
        const unrestricted = grants.get(pluginId)?.has('system.unrestricted') === true;
        const scoped = assertUnrestrictedOrScope(
          pluginId,
          args.executable,
          args.cwd ?? '',
          processScopeOf,
          () => unrestricted,
        );
        if (!unrestricted) {
          // Scoped cwd lives inside the plugin's data root: ensure it exists
          // so a fresh install can spawn immediately (§32.1 default cwd).
          await mkdir(scoped.cwd, { recursive: true });
        }
        return {
          id: await processes.spawn(
            pluginId,
            args.executable,
            args.args ?? [],
            scoped.cwd,
            args.env,
            args.timeoutMs ?? 0,
            (args.stdout ?? 'capture') !== 'ignore',
            (args.stderr ?? 'capture') !== 'ignore',
          ),
        };
      }
      case 'process.output': {
        const args = decodedArgs(SdkProcessOutputArgsSchema, call.args ?? {}) as {
          id: string;
          limit?: number;
          waitMs?: number;
        };
        return processes.output(pluginId, args.id, args.limit ?? 16, args.waitMs ?? 0, signal);
      }
      case 'process.signal': {
        const args = decodedArgs(SdkProcessSignalArgsSchema, call.args ?? {}) as {
          id: string;
          signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT';
        };
        await processes.signal(pluginId, args.id, args.signal);
        return { ok: true };
      }
      case 'process.wait': {
        const args = decodedArgs(SdkProcessOutputArgsSchema, call.args ?? {}) as {
          id: string;
          waitMs?: number;
        };
        return processes.wait(pluginId, args.id, args.waitMs ?? 0, signal);
      }
      case 'process.close': {
        const args = decodedArgs(SdkProcessIdArgsSchema, call.args ?? {}) as { id: string };
        await processes.close(pluginId, args.id);
        return { ok: true };
      }
      case 'jobs.register': {
        const args = decodedArgs(SdkJobsRegisterArgsSchema, call.args ?? {}) as {
          name: string;
          intervalMs?: number;
          atMs?: number;
          payload?: unknown;
        };
        if ((args.intervalMs === undefined) === (args.atMs === undefined)) {
          throw new BrokerCallError(BrokerErrorCode.VALIDATION_FAILED, {
            message: 'jobs.register needs exactly one of intervalMs or atMs',
          });
        }
        const owned = [...jobs.values()].filter((job) => job.pluginId === pluginId).length;
        if (owned >= JOBS_MAX_PER_PLUGIN) {
          throw new BrokerCallError('SERVICE_UNAVAILABLE', {
            message: 'too many registered jobs',
            details: { pluginId, limit: JOBS_MAX_PER_PLUGIN },
          });
        }
        const jobId = `job-${pluginId.slice(0, 24)}-${++jobSeq}`;
        const intervalMs = args.intervalMs ?? null;
        const delayMs = args.intervalMs ?? args.atMs ?? JOBS_MIN_INTERVAL_MS;
        const job: ScheduledJob = {
          jobId,
          pluginId,
          name: args.name,
          intervalMs,
          payload: args.payload,
          timer: setTimeout(() => {
            fireJob(job);
            if (intervalMs !== null) {
              job.timer = setTimeout(() => fireJob(job), intervalMs);
            } else {
              jobs.delete(jobId);
            }
          }, delayMs),
        };
        jobs.set(jobId, job);
        return { jobId };
      }
      case 'jobs.cancel': {
        const args = decodedArgs(SdkJobsCancelArgsSchema, call.args ?? {}) as { jobId: string };
        const job = jobs.get(args.jobId);
        if (job !== undefined && job.pluginId === pluginId) {
          cancelJob(args.jobId);
        }
        // Idempotent: cancelling an unknown or foreign job is ok.
        return { ok: true };
      }
      case 'jobs.list': {
        decodedArgs(SdkJobsListArgsSchema, call.args ?? {});
        return {
          jobs: [...jobs.values()]
            .filter((job) => job.pluginId === pluginId)
            .map((job) => ({
              jobId: job.jobId,
              name: job.name,
              intervalMs: job.intervalMs,
              nextRunAt: now(),
            })),
        };
      }
      case 'services.provide': {
        const args = decodedArgs(SdkServicesProvideArgsSchema, call.args ?? {}) as {
          name: string;
          version: string;
          methods: string[];
        };
        const key = `${args.name}@${args.version}`;
        if (serviceByKey.has(key)) {
          throw new BrokerCallError('SERVICE_UNAVAILABLE', {
            message: 'service name@version already registered',
            details: { key },
          });
        }
        const serviceId = `svc-${pluginId.slice(0, 16)}-${++serviceSeq}`;
        const entry: ServiceEntry = {
          serviceId,
          pluginId,
          name: args.name,
          version: args.version,
          methods: new Set(args.methods),
        };
        services.set(serviceId, entry);
        serviceByKey.set(key, serviceId);
        return { serviceId };
      }
      case 'services.connect': {
        const args = decodedArgs(SdkServicesConnectArgsSchema, call.args ?? {}) as {
          name: string;
          version: string;
          method: string;
          args?: unknown;
          deadlineMs?: number;
        };
        const serviceId = serviceByKey.get(`${args.name}@${args.version}`);
        if (serviceId === undefined) {
          throw new BrokerCallError('NOT_FOUND', {
            message: 'service not found',
            details: { name: args.name, version: args.version },
          });
        }
        const entry = services.get(serviceId);
        if (entry === undefined) {
          throw new BrokerCallError('NOT_FOUND', {
            message: 'service not found',
            details: { name: args.name, version: args.version },
          });
        }
        if (!entry.methods.has(args.method)) {
          throw new BrokerCallError('VALIDATION_FAILED', {
            message: 'service does not declare that method',
            details: { service: `${args.name}@${args.version}`, method: args.method },
          });
        }
        // §26.2.1: the provider already sits on the causal path (A→B→A).
        if (call.causalChain.includes(entry.pluginId)) {
          throw new BrokerCallError(BrokerErrorCode.SERVICE_CALL_CYCLE, {
            message: 'service call would create a cycle',
            details: { chain: [...call.causalChain, call.caller.pluginId] },
          });
        }
        const payloadJson = JSON.stringify(args.args);
        if (payloadJson !== undefined && payloadJson.length > SERVICES_MAX_PAYLOAD_BYTES) {
          throw new BrokerCallError(BrokerErrorCode.VALIDATION_FAILED, {
            message: 'service call args exceed the payload bound',
            details: { max: SERVICES_MAX_PAYLOAD_BYTES },
          });
        }
        if (pendingServiceCalls.size >= SERVICES_MAX_PENDING) {
          throw new BrokerCallError('SERVICE_UNAVAILABLE', {
            message: 'too many in-flight service calls',
            details: { limit: SERVICES_MAX_PENDING },
          });
        }
        const callId = `sc-${pluginId.slice(0, 16)}-${++serviceCallSeq}`;
        const chain = [...call.causalChain, call.caller.pluginId];
        if (
          serviceCallSink !== undefined &&
          !serviceCallSink(entry.pluginId, {
            callId,
            serviceId,
            chain,
            method: args.method,
            args: args.args,
          })
        ) {
          throw new BrokerCallError('SERVICE_UNAVAILABLE', {
            message: 'service provider worker is not available',
          });
        }
        const budgetMs = Math.min(
          args.deadlineMs ?? Number.MAX_SAFE_INTEGER,
          Math.max(0, call.deadlineAt - now()),
          2_147_483_647,
        );
        return await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingServiceCalls.delete(callId);
            reject(
              new BrokerCallError(BrokerErrorCode.OPERATION_DEADLINE, {
                message: 'service call deadline exceeded',
              }),
            );
          }, budgetMs);
          const onAbort = (): void => {
            clearTimeout(timer);
            pendingServiceCalls.delete(callId);
            // The broker aborts with the real reason (deadline, revoke,
            // shutdown); surface it instead of masking it.
            const reason = signal.reason;
            reject(
              reason instanceof Error && typeof (reason as { code?: unknown }).code === 'string'
                ? reason
                : new BrokerCallError('CAPABILITY_REVOKED', {
                    message: 'service call aborted',
                  }),
            );
          };
          signal.addEventListener('abort', onAbort, { once: true });
          pendingServiceCalls.set(callId, {
            resolve,
            reject,
            timer,
            callerPluginId: pluginId,
            providerPluginId: entry.pluginId,
          });
        });
      }
      case 'services.respond': {
        const args = decodedArgs(SdkServicesRespondArgsSchema, call.args ?? {}) as {
          callId: string;
          ok: boolean;
          result?: unknown;
          error?: { code: string; message: string };
        };
        const pending = pendingServiceCalls.get(args.callId);
        // Only the provider worker may settle; unknown/stale responses are
        // dropped (idempotent) instead of erroring the provider.
        if (pending === undefined || pending.providerPluginId !== pluginId) {
          return { ok: false };
        }
        clearTimeout(pending.timer);
        pendingServiceCalls.delete(args.callId);
        if (args.ok) {
          pending.resolve({ result: args.result });
        } else {
          pending.reject(
            new BrokerCallError(args.error?.code ?? 'SERVICE_UNAVAILABLE', {
              message: args.error?.message ?? 'service method failed',
            }),
          );
        }
        return { ok: true };
      }
      case 'secrets.use': {
        const args = decodedArgs(SdkSecretsUseArgsSchema, call.args ?? {}) as {
          connectionId: string;
        };
        if (secretsProvider === undefined) {
          throw new BrokerCallError('SERVICE_UNAVAILABLE', {
            message: 'secrets provider is not configured',
          });
        }
        const owned = [...liveSecrets.values()].filter(
          (entry) => entry.pluginId === pluginId,
        ).length;
        if (owned >= SECRETS_MAX_LIVE) {
          throw new BrokerCallError('SERVICE_UNAVAILABLE', {
            message: 'too many live secret handles',
            details: { pluginId, limit: SECRETS_MAX_LIVE },
          });
        }
        const resolved = await secretsProvider.use(pluginId, args.connectionId);
        const handle = `sec-${pluginId.slice(0, 16)}-${++secretSeq}`;
        liveSecrets.set(handle, {
          pluginId,
          secret: { origin: resolved.origin, headers: resolved.headers },
        });
        return {
          handle,
          serviceId: resolved.serviceId,
          ...(resolved.expiresAt === undefined ? {} : { expiresAt: resolved.expiresAt }),
        };
      }
      case 'secrets.manageOwn': {
        decodedArgs(SdkSecretsManageOwnArgsSchema, call.args ?? {});
        if (secretsProvider === undefined) {
          throw new BrokerCallError('SERVICE_UNAVAILABLE', {
            message: 'secrets provider is not configured',
          });
        }
        const connections = await secretsProvider.manageOwn(pluginId);
        return { connections: connections.slice(0, SECRETS_MAX_LIST) };
      }
      case 'secrets.reveal': {
        const args = decodedArgs(SdkSecretsRevealArgsSchema, call.args ?? {}) as {
          connectionId: string;
        };
        if (secretsProvider === undefined) {
          throw new BrokerCallError('SERVICE_UNAVAILABLE', {
            message: 'secrets provider is not configured',
          });
        }
        // Trust gate enforced in authorize; this is the defense-in-depth
        // layer so the code path is untestable without the provider.
        return secretsProvider.reveal(pluginId, args.connectionId);
      }
      case 'models.list': {
        const args = decodedArgs(SdkModelsListArgsSchema, call.args ?? {}) as {
          providerId: string;
        };
        const models = await modelsProvider(args.providerId);
        if (models === null) {
          throw new BrokerCallError('NOT_FOUND', {
            message: 'provider not found',
            details: { providerId: args.providerId },
          });
        }
        const result: SdkModelsListResult = {
          models: models.slice(0, MODELS_MAX_LIST),
        };
        return result;
      }
      case 'chats.list': {
        const args = decodedArgs(SdkChatsListArgsSchema, call.args ?? {}) as SdkChatsListArgs;
        const page = await chatsList({
          cursor: args.cursor,
          limit: args.limit,
          characterId: args.characterId,
        });
        const result: SdkChatsListResult = {
          items: page.items.slice(0, CHATS_MAX_LIST),
          nextCursor: page.nextCursor,
        };
        return result;
      }
      case 'chats.read': {
        const args = decodedArgs(SdkChatsReadArgsSchema, call.args ?? {}) as { chatId: string };
        const chat = await chatsRead(args.chatId);
        if (chat === null) {
          throw new BrokerCallError('NOT_FOUND', {
            message: 'chat not found',
            details: { chatId: args.chatId },
          });
        }
        const result: SdkChatsReadResult = { chat };
        return result;
      }
      case 'characters.list': {
        const args = decodedArgs(
          SdkCharactersListArgsSchema,
          call.args ?? {},
        ) as SdkCharactersListArgs;
        const page = await charactersList({
          cursor: args.cursor,
          limit: args.limit,
        });
        const result: SdkCharactersListResult = {
          items: page.items.slice(0, CHARACTERS_MAX_LIST),
          nextCursor: page.nextCursor,
        };
        return result;
      }
      case 'characters.read': {
        const args = decodedArgs(SdkCharactersReadArgsSchema, call.args ?? {}) as {
          characterId: string;
        };
        const character = await charactersRead(args.characterId);
        if (character === null) {
          throw new BrokerCallError('NOT_FOUND', {
            message: 'character not found',
            details: { characterId: args.characterId },
          });
        }
        const result: SdkCharactersReadResult = { character };
        return result;
      }
      case 'lorebook.list': {
        const args = decodedArgs(SdkLorebookListArgsSchema, call.args ?? {}) as SdkLorebookListArgs;
        const page = await lorebooksList({
          cursor: args.cursor,
          limit: args.limit,
          characterId: args.characterId,
        });
        const result: SdkLorebookListResult = {
          items: page.items.slice(0, LOREBOK_MAX_LIST),
          nextCursor: page.nextCursor,
        };
        return result;
      }
      case 'lorebook.read': {
        const args = decodedArgs(SdkLorebookReadArgsSchema, call.args ?? {}) as {
          bookId: string;
        };
        const book = await lorebookRead(args.bookId);
        if (book === null) {
          throw new BrokerCallError('NOT_FOUND', {
            message: 'lorebook not found',
            details: { bookId: args.bookId },
          });
        }
        const result: SdkLorebookReadResult = { book };
        return result;
      }
      case 'lorebook.entries': {
        const args = decodedArgs(SdkLorebookEntriesArgsSchema, call.args ?? {}) as {
          bookId: string;
        };
        const entries = await lorebookEntries(args.bookId);
        if (entries === null) {
          throw new BrokerCallError('NOT_FOUND', {
            message: 'lorebook not found',
            details: { bookId: args.bookId },
          });
        }
        const result: SdkLorebookEntriesResult = {
          items: entries.slice(0, LOREBOK_MAX_ENTRIES),
        };
        return result;
      }
      case 'database.core.query': {
        const args = decodedArgs(
          SdkDatabaseQueryArgsSchema,
          call.args ?? {},
        ) as SdkDatabaseQueryArgs;
        assertReadOnlyStatement(args.sql);
        const params = args.params ?? [];
        assertBindableParams(params);
        const page = await dbQuery({ sql: args.sql, params });
        const rows = page.rows.slice(0, DATABASE_MAX_ROWS).map((row) => {
          if (!Array.isArray(row)) {
            throw new BrokerCallError(BrokerErrorCode.VALIDATION_FAILED, {
              message: 'database row is not an array',
            });
          }
          return row.slice(0, DATABASE_MAX_COLUMNS).map((cell) => {
            if (
              cell !== null &&
              typeof cell !== 'string' &&
              typeof cell !== 'number' &&
              typeof cell !== 'boolean'
            ) {
              throw new BrokerCallError(BrokerErrorCode.VALIDATION_FAILED, {
                message: 'database cell is not a primitive value',
              });
            }
            return cell;
          });
        });
        const result: SdkDatabaseQueryResult = {
          columns: page.columns.slice(0, DATABASE_MAX_COLUMNS),
          rows,
        };
        return result;
      }
      case 'files.read': {
        const { path } = decodedArgs(SdkFilesPathArgsSchema, call.args ?? {}) as {
          path: string;
        };
        const target = await resolvePluginPath(pluginId, path);
        const info = await stat(target).catch(() => null);
        if (info === null || !info.isFile()) {
          throw new BrokerCallError('NOT_FOUND', {
            message: 'file not found',
            details: { path },
          });
        }
        if (info.size > FILES_MAX_CONTENT_BYTES) {
          throw new BrokerCallError('FILE_TOO_LARGE', {
            message: 'file exceeds the read bound',
            details: { path, sizeBytes: info.size, limitBytes: FILES_MAX_CONTENT_BYTES },
          });
        }
        return { content: await readFile(target, 'utf8') };
      }
      case 'files.write': {
        const { path, content } = decodedArgs(SdkFilesWriteArgsSchema, call.args ?? {}) as {
          path: string;
          content: string;
        };
        if (Buffer.byteLength(content, 'utf8') > FILES_MAX_CONTENT_BYTES) {
          throw new BrokerCallError('FILE_TOO_LARGE', {
            message: 'file content exceeds the write bound',
            details: { path, limitBytes: FILES_MAX_CONTENT_BYTES },
          });
        }
        const root = filesRootOf(pluginId);
        await mkdir(root, { recursive: true });
        const target = await resolvePluginPath(pluginId, path);
        await mkdir(dirname(target), { recursive: true });
        // Atomic write (temp + rename, AGENTS.md §12).
        const temporary = `${target}.partial-${randomBytes(4).toString('hex')}`;
        try {
          await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
          await rename(temporary, target);
        } catch (error) {
          await rm(temporary, { force: true }).catch(() => undefined);
          throw error;
        }
        return { ok: true };
      }
      case 'files.stat': {
        const { path } = decodedArgs(SdkFilesPathArgsSchema, call.args ?? {}) as {
          path: string;
        };
        const target = await resolvePluginPath(pluginId, path);
        const info = await stat(target).catch(() => null);
        if (info === null) {
          throw new BrokerCallError('NOT_FOUND', {
            message: 'path not found',
            details: { path },
          });
        }
        if (info.isFile()) {
          return { kind: 'file', size: info.size };
        }
        return { kind: 'directory', size: 0 };
      }
      case 'files.list': {
        const { path } = decodedArgs(SdkFilesPathArgsSchema, call.args ?? {}) as {
          path: string;
        };
        const target = await resolvePluginPath(pluginId, path);
        const entries = await readdir(target, { withFileTypes: true }).catch(() => null);
        if (entries === null) {
          throw new BrokerCallError('NOT_FOUND', {
            message: 'directory not found',
            details: { path },
          });
        }
        return {
          entries: entries
            .filter((entry) => !entry.isSymbolicLink())
            .slice(0, FILES_MAX_LIST)
            .map((entry) => entry.name),
        };
      }
      case 'files.rename': {
        const { from, to } = decodedArgs(SdkFilesRenameArgsSchema, call.args ?? {}) as {
          from: string;
          to: string;
        };
        const fromTarget = await resolvePluginPath(pluginId, from);
        const toTarget = await resolvePluginPath(pluginId, to);
        await mkdir(dirname(toTarget), { recursive: true });
        await rename(fromTarget, toTarget);
        return { ok: true };
      }
      case 'files.remove': {
        const { path } = decodedArgs(SdkFilesPathArgsSchema, call.args ?? {}) as {
          path: string;
        };
        const target = await resolvePluginPath(pluginId, path);
        await rm(target, { recursive: true, force: true });
        return { ok: true };
      }
      default:
        throw new BrokerCallError('PROTOCOL_UNSUPPORTED', {
          message: 'unknown sdk operation',
        });
    }
  }

  return {
    policy: { authorize, execute },
    grant(pluginId, ...capabilities) {
      let set = grants.get(pluginId);
      if (set === undefined) {
        set = new Set();
        grants.set(pluginId, set);
      }
      for (const capability of capabilities) set.add(capability);
    },
    revoke(pluginId, capability) {
      grants.get(pluginId)?.delete(capability);
      // §10.2 revoke: close the plugin's network handles when any network
      // capability is revoked (in-flight socket state must not outlive it).
      if (capability.startsWith('network.')) {
        void sockets.closePlugin(pluginId);
      }
      // §10.2/§32: revoking process capabilities kills the plugin's children.
      if (capability === 'process.spawn' || capability === 'system.unrestricted') {
        void processes.closePlugin(pluginId);
      }
      // §10.2/§19: revoking a jobs capability cancels the plugin's schedules.
      if (capability === 'jobs.background' || capability === 'jobs.longRunning') {
        for (const job of [...jobs.values()]) {
          if (job.pluginId === pluginId) cancelJob(job.jobId);
        }
      }
      // §10.2/§34: revoking services capabilities drops the plugin's
      // registrations and settles in-flight calls in both directions.
      if (capability === 'services.provide' || capability === 'services.connect') {
        for (const [serviceId, entry] of [...services]) {
          if (entry.pluginId === pluginId) dropService(serviceId);
        }
        rejectPendingFor(
          pluginId,
          BrokerErrorCode.CAPABILITY_REVOKED,
          'service capability revoked',
        );
      }
      // §10.2/§33: revoking a secrets capability closes the plugin's live
      // secret handles.
      if (capability === 'secrets.use' || capability === 'secrets.reveal') {
        dropPluginSecrets(pluginId);
      }
    },
    isGranted(pluginId, capability) {
      return grants.get(pluginId)?.has(capability) ?? false;
    },
    kvSnapshot(pluginId) {
      return Object.fromEntries(kvStore(pluginId));
    },
    settingsSnapshot(pluginId) {
      return Object.fromEntries(settingsStore(pluginId));
    },
    emit,
    eventsSnapshot(name) {
      const state = eventStates.get(name);
      return state === undefined ? [] : [...state.entries];
    },
    eventSubscriptionCount() {
      return subscriptions.size;
    },
    async close() {
      await sockets.closeAll();
      await processes.closeAll();
      for (const jobId of [...jobs.keys()]) cancelJob(jobId);
      rejectPendingFor('*', 'SERVICE_UNAVAILABLE', 'runtime shutting down');
      services.clear();
      serviceByKey.clear();
      liveSecrets.clear();
      await pool?.close();
    },
  };
}
