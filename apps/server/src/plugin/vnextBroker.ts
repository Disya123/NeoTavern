/**
 * vNext Main Host broker policy (ADR-0027 §3, ТЗ Plugin SDK vNext v3.2
 * §10–§12, §31; Stage D part 9).
 *
 * The decision authority lives in Main Host: `authorize` validates the call
 * against the SDK operation catalog (`SDK_OPERATION_CATALOG`, the single
 * source of truth for method→capability), verifies the declared capability
 * matches the catalog entry, and reads the actual grant from
 * `ctx.database.repos.capabilityGrants` — the same rows the consent flow
 * writes and revoke/expiry touch — so a revocation takes effect on the next
 * call. A stale observed grant revision (revoke race) fails with
 * CAPABILITY_REVOKED, and trusted capabilities (§31 core DB read)
 * additionally require a `trusted` caller level (TRUST_REQUIRED).
 *
 * Execution reuses the reference host executor (`createMemoryHostExecutor`)
 * with production backends bound to `ctx.database.repos.*` and
 * `ctx.providers`: the same dispatch the runtime-side prototype exercised,
 * now against the real store. KV/settings/events/network stay in-process;
 * chats, characters, lorebook, models and core DB hit the real database.
 * The executor's construction-time in-memory grants are deliberately
 * unused — `authorize` here is the only admission authority.
 *
 * The returned policy is transport-agnostic: it can be wired into
 * `createCapabilityBrokerCore` directly or behind the Runtime ↔ Main Host
 * RPC frames once those are forwarded (Stage D part 9b).
 */
import {
  BrokerTrustLevel,
  NETWORK_SCOPE_LOCAL,
  NETWORK_SCOPE_METADATA,
  NETWORK_SCOPE_PRIVATE,
  SDK_OPERATION_CATALOG,
  type BrokerCallRequest,
  type Character,
  type CharacterSummary,
  type Chat,
  type ChatSummary,
  type CursorPage,
  type ModelInfo,
  type NetworkScope,
  type SdkEventEnvelope,
} from '@neotavern/contracts';
import type { AppDatabase, CapabilityGrantEntry, SqliteConnection } from '@neotavern/db';
import type { ProviderRegistry, ProviderTimeouts } from '@neotavern/provider-sdk';
import {
  BrokerErrorCode,
  createMemoryHostExecutor,
  type BrokerDecision,
  type BrokerPolicy,
  type MemoryHostOptions,
} from '@neotavern/plugin-runtime';
import { assertProviderConfigValid } from '../plugins/providers.js';

/** Host surface the broker needs; `AppContext` satisfies it structurally. */
export interface VNextBrokerHost {
  database: AppDatabase;
  providers: ProviderRegistry;
  config: { providerTimeouts: ProviderTimeouts };
}

/**
 * Capabilities that additionally require a `trusted` caller (§31: the core
 * database is app-owned; sandboxed plugins only get the read API through a
 * trusted grant).
 */
const TRUSTED_CAPABILITIES: ReadonlySet<string> = new Set(['database.core.read']);

export interface VNextBrokerOptions {
  /** Injectable clock for grant expiry checks (tests use a fake clock). */
  now?: () => number;
  /** Grant source; defaults to `ctx.database.repos.capabilityGrants.listActive`. */
  grantsProvider?: (pluginId: string, now: number) => CapabilityGrantEntry[];
  /** Trusted-capability set; defaults to the §31 core DB read. */
  trustedCapabilities?: ReadonlySet<string>;
  fetchImpl?: MemoryHostOptions['fetchImpl'];
  dnsLookupImpl?: MemoryHostOptions['dnsLookupImpl'];
  /** §29.1.5 secret registry (opaque handles → bound origin + headers). */
  networkSecrets?: MemoryHostOptions['networkSecrets'];
  /** §29 proxy (executor-level config, never plugin-controlled). */
  proxyUrl?: MemoryHostOptions['proxyUrl'];
  /** §29 keep-alive/pooling bounds for the built-in transport. */
  networkPool?: MemoryHostOptions['networkPool'];
  /**
   * §29.1.1 scope capabilities: effective network reach per plugin. Defaults
   * to a DB-backed provider that derives `network.local` / `network.private`
   * / `network.metadata` booleans from the same `grantsSource` rows the
   * consent flow writes.
   */
  networkScopeProvider?: MemoryHostOptions['networkScopeProvider'];
  modelsProvider?: MemoryHostOptions['modelsProvider'];
  chatsList?: MemoryHostOptions['chatsList'];
  chatsRead?: MemoryHostOptions['chatsRead'];
  charactersList?: MemoryHostOptions['charactersList'];
  charactersRead?: MemoryHostOptions['charactersRead'];
  lorebooksList?: MemoryHostOptions['lorebooksList'];
  lorebookRead?: MemoryHostOptions['lorebookRead'];
  lorebookEntries?: MemoryHostOptions['lorebookEntries'];
  dbQuery?: MemoryHostOptions['dbQuery'];
  /** Live-delivery push sink (§18, Stage F): routes `event-push` bridge
   * messages to the subscribing worker over the runtime wire. Wired by the
   * broker host (`createVNextBrokerHost`), which maps subscription ids to
   * worker refs; `false` drops a subscription whose worker is gone. */
  eventPushSink?: MemoryHostOptions['eventPushSink'];
  /**
   * §30 Files API: plugin-owned data directory resolver. Defaults to a
   * per-plugin temp dir (reference host); production wires
   * `join(pluginsRoot, pluginId, 'data')` so every `files.*` operation is
   * confined to the plugin's own data directory.
   */
  filesRoot?: MemoryHostOptions['filesRoot'];
  /**
   * §32.1 process API: scoped-mode policy (executables + cwd roots). Absent
   * = the reference default: the current Node executable inside the
   * plugin's files root. Manifest-derived scopes arrive with Stage H
   * (build pipeline); `system.unrestricted` always bypasses the scope.
   */
  processScope?: MemoryHostOptions['processScope'];
  /**
   * §19/§27 Jobs API: host-side push sink, wired by the broker host
   * (`createVNextBrokerHost`) which routes `job-run` bridge messages to the
   * owning worker; `false` drops a push whose worker is gone.
   */
  jobPushSink?: MemoryHostOptions['jobPushSink'];
  /**
   * §34 Services API: host-side sink for cross-plugin calls, wired by the
   * broker host which routes `service-call` bridge messages to the
   * provider's worker; `false` surfaces as SERVICE_UNAVAILABLE.
   */
  serviceCallSink?: MemoryHostOptions['serviceCallSink'];
  /** §33 Secrets API: host-side provider (OAuth repo backed). */
  secretsProvider?: MemoryHostOptions['secretsProvider'];
}

function chatSummaryOf(chat: Chat): ChatSummary {
  return {
    id: chat.id,
    characterId: chat.characterId,
    title: chat.title,
    messageCount: chat.messageCount,
    parentChatId: chat.parentChatId,
    origin: chat.origin,
    sourceMessageId: chat.sourceMessageId,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
}

function characterSummaryOf(character: Character): CharacterSummary {
  return {
    id: character.id,
    name: character.name,
    avatar: character.avatar,
    description: character.description,
    tags: character.tags,
    createdAt: character.createdAt,
    updatedAt: character.updatedAt,
  };
}

function mapPage<T, S>(
  page: CursorPage<T>,
  map: (item: T) => S,
): { items: S[]; nextCursor: string | null } {
  return { items: page.items.map(map), nextCursor: page.nextCursor };
}

/** Bound a model list to the SDK contract shape (provider not found → null). */
async function listModelsForProvider(
  ctx: VNextBrokerHost,
  providerId: string,
): Promise<ModelInfo[] | null> {
  const full = await ctx.database.repos.providerConfigs.getFullConfig(providerId);
  if (full === null) return null;
  const normalized = await assertProviderConfigValid(ctx, full.kind, {
    baseUrl: full.baseUrl,
    model: full.model,
    apiKey: full.apiKey,
    settings: full.settings,
  });
  const adapter = ctx.providers.create(full.kind, {
    ...normalized,
    timeouts: ctx.config.providerTimeouts,
  });
  return adapter.listModels(AbortSignal.timeout(ctx.config.providerTimeouts.readMs));
}

/**
 * Run an already-admitted read-only statement. The executor validates the SQL
 * (single SELECT/WITH, no write keywords) and the result cells before this
 * point, so the prepared statement here never mutates the store.
 */
async function runCoreQuery(
  sqlite: SqliteConnection,
  query: { sql: string; params: unknown[] },
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const statement = sqlite.prepare(query.sql);
  const columns = statement.columns().map((column) => column.name);
  const rows = statement.raw(true).all(...query.params) as unknown[][];
  return { columns, rows };
}

export function createVNextBrokerPolicy(
  ctx: VNextBrokerHost,
  options: VNextBrokerOptions = {},
): BrokerPolicy & {
  emit(name: string, payload: unknown): SdkEventEnvelope;
  close(): Promise<void>;
} {
  const now = options.now ?? Date.now;
  const trusted = options.trustedCapabilities ?? TRUSTED_CAPABILITIES;
  const grantsSource =
    options.grantsProvider ??
    ((pluginId: string, at: number) =>
      ctx.database.repos.capabilityGrants.listActive(pluginId, at));
  // §29.1.1 scope capabilities: derive the effective network reach from the
  // same grant rows the consent flow writes. A plugin holding `network.local`
  // / `network.private` / `network.metadata` alongside `network.http` can
  // reach loopback / RFC1918 / cloud-metadata destinations respectively;
  // without the scope flag, only public Internet addresses are admitted.
  const scopeProvider =
    options.networkScopeProvider ??
    ((pluginId: string): NetworkScope => {
      const grants = grantsSource(pluginId, now());
      const names = new Set(grants.map((g) => g.name));
      return {
        local: names.has(NETWORK_SCOPE_LOCAL),
        private: names.has(NETWORK_SCOPE_PRIVATE),
        metadata: names.has(NETWORK_SCOPE_METADATA),
      };
    });
  const catalog = new Map(SDK_OPERATION_CATALOG.map((entry) => [entry.method, entry]));

  const host = createMemoryHostExecutor({
    now,
    modelsProvider:
      options.modelsProvider ?? ((providerId) => listModelsForProvider(ctx, providerId)),
    chatsList:
      options.chatsList ??
      (async (query) =>
        mapPage(
          await ctx.database.repos.chats.list({
            cursor: query.cursor,
            limit: query.limit,
            characterId: query.characterId,
          }),
          chatSummaryOf,
        )),
    chatsRead: options.chatsRead ?? ((chatId) => ctx.database.repos.chats.getById(chatId)),
    charactersList:
      options.charactersList ??
      (async (query) =>
        mapPage(
          await ctx.database.repos.characters.list({ cursor: query.cursor, limit: query.limit }),
          characterSummaryOf,
        )),
    charactersRead:
      options.charactersRead ??
      ((characterId) => ctx.database.repos.characters.getById(characterId)),
    lorebooksList:
      options.lorebooksList ??
      (async (query) =>
        mapPage(
          await ctx.database.repos.lorebooks.list({
            cursor: query.cursor,
            limit: query.limit,
            characterId: query.characterId,
          }),
          (book) => book,
        )),
    lorebookRead:
      options.lorebookRead ?? ((bookId) => ctx.database.repos.lorebooks.getById(bookId)),
    lorebookEntries:
      options.lorebookEntries ??
      (async (bookId) => {
        const book = await ctx.database.repos.lorebooks.getById(bookId);
        if (book === null) return null;
        return ctx.database.repos.lorebooks.listEntries(bookId);
      }),
    dbQuery: options.dbQuery ?? ((query) => runCoreQuery(ctx.database.sqlite, query)),
    fetchImpl: options.fetchImpl,
    dnsLookupImpl: options.dnsLookupImpl,
    networkSecrets: options.networkSecrets,
    proxyUrl: options.proxyUrl,
    networkPool: options.networkPool,
    networkScopeProvider: scopeProvider,
    eventPushSink: options.eventPushSink,
    filesRoot: options.filesRoot,
    processScope: options.processScope,
    jobPushSink: options.jobPushSink,
    serviceCallSink: options.serviceCallSink,
    secretsProvider: options.secretsProvider,
  });

  function authorize(call: BrokerCallRequest): BrokerDecision {
    const entry = catalog.get(call.method);
    if (entry === undefined) {
      return { allowed: false, code: 'PROTOCOL_UNSUPPORTED' };
    }
    if (entry.capability !== null) {
      if (entry.capability !== call.capability.name) {
        // The declared capability must match the catalog entry for the
        // method; a mismatch means the plugin asked for a different grant
        // than the operation actually needs.
        return {
          allowed: false,
          code: BrokerErrorCode.POLICY_DENIED,
          details: { expectedCapability: entry.capability },
        };
      }
      const grants = grantsSource(call.caller.pluginId, now());
      const grant = grants.find((g) => g.name === entry.capability);
      if (grant === undefined) {
        return { allowed: false, code: BrokerErrorCode.CAPABILITY_DENIED };
      }
      if (call.revision !== undefined && call.revision !== grant.revision) {
        // Revoke race: the caller saw an older revision than the active grant.
        return {
          allowed: false,
          code: BrokerErrorCode.CAPABILITY_REVOKED,
          details: { capability: entry.capability },
        };
      }
      if (trusted.has(entry.capability) && call.caller.trustLevel !== BrokerTrustLevel.TRUSTED) {
        return {
          allowed: false,
          code: BrokerErrorCode.TRUST_REQUIRED,
          details: { capability: entry.capability },
        };
      }
    }
    // Core channels (capability: null, §18 events) skip the grant check; the
    // broker core still enforces identity, deadline, cycles and bounds.
    return { allowed: true };
  }

  return {
    authorize,
    execute: (call, signal) => host.policy.execute(call, signal),
    emit: (name, payload) => host.emit(name, payload),
    close: () => host.close(),
  };
}
