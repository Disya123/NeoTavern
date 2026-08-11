/**
 * Main Host broker policy tests (Stage D part 9): the decision authority
 * reads real capability grants from `ctx.database.repos.capabilityGrants`
 * (consent rows with expiry/revoke), and execution runs the production
 * backends bound to `ctx.database.repos.*` / `ctx.providers`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_PROVIDER_TIMEOUTS, type ProviderRegistry } from '@neotavern/provider-sdk';
import type { AppDatabase, CapabilityGrantEntry } from '@neotavern/db';
import type { BrokerCallRequest } from '@neotavern/contracts';
import type { BrokerPolicy } from '@neotavern/plugin-runtime';
import { createTestApp } from './helpers.js';
import { createVNextBrokerPolicy, type VNextBrokerHost } from '../src/plugin/vnextBroker.js';

const PLUGIN_ID = 'test.vnext-broker';
const INSTALLATION_ID = 'install-00000001';
const CORE_DB_READ = 'database.core.read';

const VALID_MANIFEST = { id: PLUGIN_ID, name: PLUGIN_ID, version: '1.0.0', apiVersion: 2 };

let database: AppDatabase;
let providers: ProviderRegistry;
let ctx: VNextBrokerHost;
let policy: BrokerPolicy;
let clock: { at: number };

function brokerCall(overrides: Partial<BrokerCallRequest> = {}): BrokerCallRequest {
  return {
    requestId: 'req-00000001',
    caller: { pluginId: PLUGIN_ID, installationId: INSTALLATION_ID, trustLevel: 'sandbox' },
    method: 'characters.list',
    args: {},
    capability: { name: 'characters.read', scope: {} },
    revision: 1,
    deadlineAt: Date.now() + 10_000,
    causalChain: [PLUGIN_ID],
    ...overrides,
  };
}

function coreDbCall(overrides: Partial<BrokerCallRequest> = {}): BrokerCallRequest {
  return brokerCall({
    method: 'database.core.query',
    capability: { name: CORE_DB_READ, scope: {} },
    ...overrides,
  });
}

beforeEach(async () => {
  const handle = await createTestApp();
  database = handle.database;
  providers = handle.providers;
  ctx = { database, providers, config: { providerTimeouts: DEFAULT_PROVIDER_TIMEOUTS } };
  clock = { at: Date.now() };
  policy = createVNextBrokerPolicy(ctx, { now: () => clock.at });
  database.repos.plugins.install({
    id: PLUGIN_ID,
    name: PLUGIN_ID,
    version: '1.0.0',
    manifest: VALID_MANIFEST,
    requestedPermissions: [],
  });
});

function grant(name: string, extra: { expiresAt?: number | null } = {}): CapabilityGrantEntry {
  return database.repos.capabilityGrants.grant({ pluginId: PLUGIN_ID, name, scope: {}, ...extra });
}

describe('authorize (Main Host decision authority)', () => {
  it('rejects methods outside the SDK catalog with PROTOCOL_UNSUPPORTED', () => {
    const decision = policy.authorize(brokerCall({ method: 'chats.teleport' }));
    expect(decision).toMatchObject({ allowed: false, code: 'PROTOCOL_UNSUPPORTED' });
  });

  it('rejects a declared capability that does not match the catalog entry', () => {
    const decision = policy.authorize(
      brokerCall({ capability: { name: 'storage.kv', scope: {} } }),
    );
    expect(decision).toMatchObject({ allowed: false, code: 'POLICY_DENIED' });
  });

  it('allows core-channel methods without any grant', () => {
    const decision = policy.authorize(
      brokerCall({ method: 'events.replay', capability: { name: 'events.replay', scope: {} } }),
    );
    expect(decision).toEqual({ allowed: true });
  });

  it('denies a capability with no active grant (CAPABILITY_DENIED)', () => {
    expect(policy.authorize(brokerCall())).toMatchObject({
      allowed: false,
      code: 'CAPABILITY_DENIED',
    });
  });

  it('admits a call backed by an active grant', () => {
    grant('characters.read');
    expect(policy.authorize(brokerCall())).toEqual({ allowed: true });
  });

  it('denies a revoked grant on the next call', () => {
    grant('characters.read');
    database.repos.capabilityGrants.revoke(PLUGIN_ID, 'characters.read', clock.at);
    expect(policy.authorize(brokerCall())).toMatchObject({
      allowed: false,
      code: 'CAPABILITY_DENIED',
    });
  });

  it('denies an expired grant (CAPABILITY_DENIED)', () => {
    grant('characters.read', { expiresAt: clock.at + 1_000 });
    clock.at += 2_000;
    expect(policy.authorize(brokerCall())).toMatchObject({
      allowed: false,
      code: 'CAPABILITY_DENIED',
    });
  });

  it('fails with CAPABILITY_REVOKED when the observed revision is stale', () => {
    grant('characters.read');
    const fresh = brokerCall({ revision: 1 });
    expect(policy.authorize(fresh)).toEqual({ allowed: true });
    database.repos.capabilityGrants.revoke(PLUGIN_ID, 'characters.read', clock.at);
    grant('characters.read');
    expect(policy.authorize(fresh)).toMatchObject({
      allowed: false,
      code: 'CAPABILITY_REVOKED',
    });
  });

  it('requires a trusted caller level for the §31 core DB read (TRUST_REQUIRED)', () => {
    grant(CORE_DB_READ);
    const call = coreDbCall();
    expect(policy.authorize(call)).toMatchObject({ allowed: false, code: 'TRUST_REQUIRED' });
    const trusted = { ...call, caller: { ...call.caller, trustLevel: 'trusted' } as const };
    expect(policy.authorize(trusted)).toEqual({ allowed: true });
  });

  it('uses the injected grantsProvider when provided', () => {
    const injected = createVNextBrokerPolicy(ctx, {
      grantsProvider: (pluginId, at) =>
        pluginId === PLUGIN_ID
          ? [
              {
                id: 'grant-00000001',
                pluginId,
                name: 'characters.read',
                scope: {},
                revision: 7,
                grantedAt: at,
                expiresAt: null,
                revokedAt: null,
              },
            ]
          : [],
    });
    expect(injected.authorize(brokerCall({ revision: 7 }))).toEqual({ allowed: true });
    expect(injected.authorize(brokerCall({ revision: 1 }))).toMatchObject({
      allowed: false,
      code: 'CAPABILITY_REVOKED',
    });
  });
});

describe('execute (production backends)', () => {
  it('lists characters through the repository', async () => {
    grant('characters.read');
    const created = await database.repos.characters.create({ name: 'Ada' });
    const result = (await policy.execute(brokerCall(), new AbortController().signal)) as {
      items: { id: string; name: string }[];
    };
    expect(result).toEqual({
      items: [
        {
          id: created.id,
          name: 'Ada',
          avatar: null,
          description: '',
          tags: [],
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        },
      ],
      nextCursor: null,
    });
  });

  it('reads a character by id', async () => {
    grant('characters.read');
    const created = await database.repos.characters.create({ name: 'Ada', description: 'pioneer' });
    const result = (await policy.execute(
      brokerCall({ method: 'characters.read', args: { characterId: created.id } }),
      new AbortController().signal,
    )) as { character: { id: string; name: string } };
    expect(result.character).toMatchObject({ id: created.id, name: 'Ada' });
  });

  it('filters chats by characterId', async () => {
    grant('chats.read');
    const ada = await database.repos.characters.create({ name: 'Ada' });
    const bob = await database.repos.characters.create({ name: 'Bob' });
    await database.repos.chats.create({ characterId: ada.id, title: 'with Ada' });
    await database.repos.chats.create({ characterId: bob.id, title: 'with Bob' });
    const result = (await policy.execute(
      brokerCall({
        method: 'chats.list',
        capability: { name: 'chats.read', scope: {} },
        args: { characterId: ada.id },
      }),
      new AbortController().signal,
    )) as { items: { title: string }[] };
    expect(result.items.map((item) => item.title)).toEqual(['with Ada']);
  });

  it('reads a chat by id and fails with NOT_FOUND for unknown chats', async () => {
    grant('chats.read');
    const chat = await database.repos.chats.create({ title: 'hello' });
    const result = (await policy.execute(
      brokerCall({
        method: 'chats.read',
        capability: { name: 'chats.read', scope: {} },
        args: { chatId: chat.id },
      }),
      new AbortController().signal,
    )) as { chat: { id: string; title: string } };
    expect(result.chat).toMatchObject({ id: chat.id, title: 'hello' });
    await expect(
      policy.execute(
        brokerCall({
          method: 'chats.read',
          capability: { name: 'chats.read', scope: {} },
          args: { chatId: 'no-such-chat' },
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lists lorebooks and reads their entries', async () => {
    grant('lorebook.read');
    const book = await database.repos.lorebooks.create({
      name: 'World',
      entries: [{ keys: ['city'], content: 'A city.' }],
    });
    const listed = (await policy.execute(
      brokerCall({ method: 'lorebook.list', capability: { name: 'lorebook.read', scope: {} } }),
      new AbortController().signal,
    )) as { items: { name: string }[] };
    expect(listed.items.map((item) => item.name)).toEqual(['World']);
    const read = (await policy.execute(
      brokerCall({
        method: 'lorebook.read',
        capability: { name: 'lorebook.read', scope: {} },
        args: { bookId: book.id },
      }),
      new AbortController().signal,
    )) as { book: { id: string } };
    expect(read.book).toMatchObject({ id: book.id });
    const entries = (await policy.execute(
      brokerCall({
        method: 'lorebook.entries',
        capability: { name: 'lorebook.read', scope: {} },
        args: { bookId: book.id },
      }),
      new AbortController().signal,
    )) as { items: { keys: string[] }[] };
    expect(entries.items.map((entry) => entry.keys)).toEqual([['city']]);
    await expect(
      policy.execute(
        brokerCall({
          method: 'lorebook.entries',
          capability: { name: 'lorebook.read', scope: {} },
          args: { bookId: 'no-such-book' },
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('runs a read-only core query and rejects write statements', async () => {
    grant(CORE_DB_READ);
    await database.repos.characters.create({ name: 'Ada' });
    const result = (await policy.execute(
      coreDbCall({ args: { sql: 'SELECT name FROM characters ORDER BY name' } }),
      new AbortController().signal,
    )) as { columns: string[]; rows: unknown[][] };
    expect(result).toEqual({ columns: ['name'], rows: [['Ada']] });
    await expect(
      policy.execute(
        coreDbCall({ args: { sql: 'DELETE FROM characters' } }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('returns NOT_FOUND for an unknown provider in models.list', async () => {
    grant('models.list');
    await expect(
      policy.execute(
        brokerCall({
          method: 'models.list',
          capability: { name: 'models.list', scope: {} },
          args: { providerId: 'no-such-provider' },
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('delegates models.list to an injected modelsProvider', async () => {
    const injected = createVNextBrokerPolicy(ctx, {
      modelsProvider: async (providerId) => [{ id: providerId, name: 'echo', contextLength: 4096 }],
    });
    const result = (await injected.execute(
      brokerCall({
        method: 'models.list',
        capability: { name: 'models.list', scope: {} },
        args: { providerId: 'echo-provider' },
      }),
      new AbortController().signal,
    )) as { models: { id: string; name: string }[] };
    expect(result.models).toMatchObject([{ id: 'echo-provider', name: 'echo' }]);
  });

  it('wires injected fetch/DNS into network.fetch', async () => {
    const injected = createVNextBrokerPolicy(ctx, {
      fetchImpl: async (url) =>
        new Response(JSON.stringify({ url, ok: true, injected: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      dnsLookupImpl: async () => ['93.184.216.34'],
    });
    const result = (await injected.execute(
      brokerCall({
        method: 'network.http.fetch',
        capability: { name: 'network.http', scope: {} },
        args: { url: 'https://example.com', method: 'GET' },
      }),
      new AbortController().signal,
    )) as { status: number; url: string; body: string };
    expect(result).toMatchObject({ status: 200, url: 'https://example.com' });
    // The injected fetchImpl produced the body marker; the real network
    // default would never contain it (guards against a silent no-op).
    expect(result.body).toContain('"injected":true');
  });
});
