import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAppDatabase, pluginStatus, type AppDatabase } from '../src/index.js';

describe('database + repositories', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createAppDatabase(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('runs migrations and creates/lists a character', async () => {
    const c = await db.repos.characters.create({
      name: 'Alice',
      description: 'Adventurer in Wonderland',
      tags: ['fantasy', 'classic'],
    });
    expect(c.id).toMatch(/-/);
    expect(c.tags.sort()).toEqual(['classic', 'fantasy']);

    const page = await db.repos.characters.list({});
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.name).toBe('Alice');
    expect(page.hasMore).toBe(false);
  });

  it('cursor-paginates without loading everything', async () => {
    for (let i = 0; i < 5; i += 1) {
      await db.repos.characters.create({ name: `Char ${i}` });
    }
    const p1 = await db.repos.characters.list({ limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.hasMore).toBe(true);

    const p2 = await db.repos.characters.list({ limit: 2, cursor: p1.nextCursor ?? undefined });
    expect(p2.items).toHaveLength(2);
    const seen = new Set([...p1.items, ...p2.items].map((c) => c.id));
    expect(seen.size).toBe(4); // no overlap
  });

  it('updates and soft-deletes a character', async () => {
    const c = await db.repos.characters.create({ name: 'Bob' });
    const updated = await db.repos.characters.update(c.id, { name: 'Robert' });
    expect(updated?.name).toBe('Robert');

    await db.repos.characters.softDelete(c.id);
    const visible = await db.repos.characters.list({});
    expect(visible.items).toHaveLength(0);
    const withDeleted = await db.repos.characters.list({ includeDeleted: true });
    expect(withDeleted.items).toHaveLength(1);
  });

  it('full-text search finds characters by description', async () => {
    await db.repos.characters.create({
      name: 'Sherlock Holmes',
      description: 'A brilliant consulting detective in London',
    });
    const res = await db.repos.search.search('detective', 'characters', 10);
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0]?.title).toBe('Sherlock Holmes');
  });

  it('supports prefix search', async () => {
    await db.repos.characters.create({ name: 'Hermione Granger', description: 'witch' });
    const res = await db.repos.search.search('herm', 'characters', 10);
    expect(res.results.length).toBeGreaterThan(0);
  });

  it('chat + messages roundtrip in ascending order', async () => {
    const chat = await db.repos.chats.create({ title: 'Test chat' });
    expect(chat.activeBranchId).toBeTruthy();
    const branch = chat.activeBranchId as string;

    await db.repos.messages.create(chat.id, branch, { role: 'user', content: 'hi' });
    await db.repos.messages.create(chat.id, branch, { role: 'assistant', content: 'hello there' });

    const page = await db.repos.messages.list(chat.id, { order: 'asc' });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.content).toBe('hi');
    expect(page.items[1]?.content).toBe('hello there');

    const recent = await db.repos.messages.recentAscending(chat.id, branch, 1);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.content).toBe('hello there');
  });

  it('rolls back chat, branch, and greeting when atomic chat creation fails', async () => {
    db.sqlite.exec(`
      CREATE TEMP TRIGGER reject_test_greeting
      BEFORE INSERT ON messages
      WHEN new.content = 'reject this greeting'
      BEGIN
        SELECT RAISE(ABORT, 'test greeting rejection');
      END;
    `);

    await expect(
      db.repos.chats.create({ title: 'Must roll back' }, 'reject this greeting'),
    ).rejects.toThrow();
    expect((await db.repos.chats.list({ includeDeleted: true })).items).toEqual([]);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM chat_branches').get()).toEqual({
      count: 0,
    });
  });

  it('message search finds content across chats', async () => {
    const chat = await db.repos.chats.create({ title: 'c' });
    const branch = chat.activeBranchId as string;
    await db.repos.messages.create(chat.id, branch, {
      role: 'assistant',
      content: 'The quick brown fox jumps over the lazy dog',
    });
    const res = await db.repos.search.search('fox', 'messages', 10);
    expect(res.results.length).toBeGreaterThan(0);
  });

  it('recovers a streamed chat import interrupted before completion', () => {
    const input = {
      sourceKind: 'chat',
      sourceKey: 'chats/guide/session.jsonl',
      sourceHash: 'a'.repeat(64),
      characterId: null,
      personaId: null,
      title: 'Recovered import',
      createdAt: 10,
      updatedAt: 20,
      metadata: { source: 'test' },
    };
    const interrupted = db.repos.dataImports.beginChatImport(input);
    db.repos.dataImports.appendChatMessage(interrupted, null, {
      role: 'user',
      content: 'partial',
      name: null,
      meta: {},
      createdAt: 11,
      variants: [],
    });

    const retried = db.repos.dataImports.beginChatImport(input);
    expect(retried.created).toBe(true);
    expect(retried.id).not.toBe(interrupted.id);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM chats').get()).toEqual({ count: 1 });
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });

    db.repos.dataImports.finishChatImport(input.sourceKey, retried.id, 0, 20);
    const reused = db.repos.dataImports.beginChatImport(input);
    expect(reused).toMatchObject({ id: retried.id, created: false, messageCount: 0 });
  });

  it('applies skip, merge, replace, and copy import policies without breaking identity', async () => {
    const local = await db.repos.characters.create({
      name: 'Conflict Guide',
      description: 'Keep this local description',
      firstMessage: '',
      tags: ['local'],
    });
    const identity = {
      sourceKind: 'character',
      sourceKey: 'characters/conflict-guide',
      sourceHash: 'b'.repeat(64),
      metadata: { source: 'test' },
    };
    const incoming = {
      name: 'Conflict Guide',
      description: 'Incoming description',
      firstMessage: 'Incoming greeting',
      tags: ['incoming'],
    };

    const skipped = db.repos.dataImports.importCharacter(identity, incoming, null, 'skip');
    expect(skipped).toEqual({ id: local.id, created: false });
    expect((await db.repos.characters.getById(local.id))?.description).toBe(
      'Keep this local description',
    );

    const merged = db.repos.dataImports.importCharacter(identity, incoming, null, 'merge');
    const mergedCharacter = await db.repos.characters.getById(local.id);
    expect(merged).toEqual({ id: local.id, created: false });
    expect(mergedCharacter).toMatchObject({
      description: 'Keep this local description',
      firstMessage: 'Incoming greeting',
    });
    expect(mergedCharacter?.tags.sort()).toEqual(['incoming', 'local']);

    const replaced = db.repos.dataImports.importCharacter(
      identity,
      { ...incoming, description: 'Archive is authoritative', tags: ['archive'] },
      null,
      'replace',
    );
    expect(replaced).toEqual({ id: local.id, created: false });
    expect(await db.repos.characters.getById(local.id)).toMatchObject({
      description: 'Archive is authoritative',
      tags: ['archive'],
    });
    expect(
      db.sqlite
        .prepare('SELECT COUNT(*) AS count FROM character_versions WHERE character_id = ?')
        .get(local.id),
    ).toEqual({ count: 1 });

    const copied = db.repos.dataImports.importCharacter(
      { ...identity, sourceKey: `${identity.sourceKey}#copy:test-run` },
      incoming,
      null,
      'copy',
    );
    expect(copied.created).toBe(true);
    expect(copied.id).not.toBe(local.id);
    expect((await db.repos.characters.list({ q: 'Conflict Guide' })).items).toHaveLength(2);
  });

  it('replaces a chat only after completion and restores the old mapping on abort', () => {
    const input = {
      sourceKind: 'chat',
      sourceKey: 'chats/replace/session.jsonl',
      sourceHash: 'c'.repeat(64),
      characterId: null,
      personaId: null,
      title: 'Original transcript',
      createdAt: 10,
      updatedAt: 20,
      metadata: { source: 'test' },
    };
    const original = db.repos.dataImports.beginChatImport(input);
    const messageId = db.repos.dataImports.appendChatMessage(original, null, {
      role: 'user',
      content: 'old',
      name: null,
      meta: {},
      createdAt: 11,
      variants: [],
    });
    db.repos.dataImports.finishChatImport(input.sourceKey, original.id, 1, 20);

    const replacement = db.repos.dataImports.beginChatImport(
      { ...input, sourceHash: 'd'.repeat(64), title: 'Replacement transcript' },
      'replace',
    );
    expect(replacement).toMatchObject({
      created: true,
      messageCount: 0,
      replacedId: original.id,
    });
    expect(replacement.id).not.toBe(original.id);
    expect(db.sqlite.prepare('SELECT 1 FROM messages WHERE id = ?').get(messageId)).toEqual({
      1: 1,
    });
    db.repos.dataImports.finishChatImport(
      input.sourceKey,
      replacement.id,
      0,
      30,
      replacement.replacedId,
    );
    expect(db.sqlite.prepare('SELECT 1 FROM chats WHERE id = ?').get(original.id)).toBeUndefined();
    expect(db.sqlite.prepare('SELECT title FROM chats WHERE id = ?').get(replacement.id)).toEqual({
      title: 'Replacement transcript',
    });

    const cancelled = db.repos.dataImports.beginChatImport(
      { ...input, sourceHash: 'e'.repeat(64), title: 'Cancelled replacement' },
      'replace',
    );
    db.repos.dataImports.abortChatImport(
      input.sourceKey,
      cancelled.id,
      cancelled.replacedId,
      'e'.repeat(64),
    );
    expect(db.sqlite.prepare('SELECT title FROM chats WHERE id = ?').get(replacement.id)).toEqual({
      title: 'Replacement transcript',
    });
    expect(db.repos.dataImports.findArtifactTarget('chat', input.sourceKey)).toBe(replacement.id);
  });

  it('stores and retrieves settings with defaults', async () => {
    const initial = await db.repos.settings.getAll();
    expect(initial.language).toBe('en');
    const updated = await db.repos.settings.patch({ language: 'ru' });
    expect(updated.language).toBe('ru');
    expect(updated.activeProviderConfigId).toBeNull();
  });

  it('installs, activates, replaces and removes themes atomically with settings', async () => {
    const first = db.repos.themes.install({
      id: 'test.midnight',
      name: 'Midnight',
      version: '1.0.0',
      manifest: { id: 'test.midnight', name: 'Midnight', version: '1.0.0' },
    });
    expect(first.replaced).toBe(false);
    expect(first.theme.enabled).toBe(false);

    expect(db.repos.themes.activate('missing')).toBeNull();
    expect(db.repos.themes.activate('test.midnight')?.enabled).toBe(true);
    expect((await db.repos.settings.getAll()).themeId).toBe('test.midnight');

    const replacement = db.repos.themes.install({
      id: 'test.midnight',
      name: 'Midnight Two',
      version: '2.0.0',
      manifest: { id: 'test.midnight', name: 'Midnight Two', version: '2.0.0' },
    });
    expect(replacement).toMatchObject({
      replaced: true,
      theme: { enabled: true, version: '2.0.0' },
    });

    const second = db.repos.themes.install({
      id: 'test.paper',
      name: 'Paper',
      version: '1.0.0',
      manifest: { id: 'test.paper', name: 'Paper', version: '1.0.0' },
    });
    expect(db.repos.themes.activate(second.theme.id)?.enabled).toBe(true);
    expect(db.repos.themes.list().filter((theme) => theme.enabled)).toHaveLength(1);
    expect((await db.repos.settings.getAll()).themeId).toBe('test.paper');

    expect(db.repos.themes.delete('test.paper')).toEqual({ deleted: true, wasActive: true });
    expect((await db.repos.settings.getAll()).themeId).toBeNull();
    db.repos.themes.resetActive();
    expect(db.repos.themes.list().every((theme) => !theme.enabled)).toBe(true);
  });

  it('requires renewed plugin consent only when an update adds permissions', () => {
    const first = db.repos.plugins.install({
      id: 'test.consent',
      name: 'Consent test',
      version: '1.0.0',
      manifest: {
        id: 'test.consent',
        name: 'Consent test',
        version: '1.0.0',
        apiVersion: 2,
        permissions: ['ui.toolbar'],
      },
      requestedPermissions: ['ui.toolbar'],
    });
    expect(first).toMatchObject({
      replaced: false,
      addedPermissions: ['ui.toolbar'],
      plugin: { enabled: false, grantedPermissions: [] },
    });
    expect(pluginStatus(first.plugin)).toBe('needs-consent');

    expect(db.repos.plugins.grantAndEnable('test.consent', ['ui.toolbar'])).toMatchObject({
      enabled: true,
      grantedPermissions: ['ui.toolbar'],
    });
    const compatibleUpdate = db.repos.plugins.install({
      id: 'test.consent',
      name: 'Consent test',
      version: '1.1.0',
      manifest: {
        id: 'test.consent',
        name: 'Consent test',
        version: '1.1.0',
        apiVersion: 2,
        permissions: ['ui.toolbar'],
      },
      requestedPermissions: ['ui.toolbar'],
    });
    expect(compatibleUpdate).toMatchObject({
      addedPermissions: [],
      plugin: { enabled: true },
    });

    const expandedUpdate = db.repos.plugins.install({
      id: 'test.consent',
      name: 'Consent test',
      version: '2.0.0',
      manifest: {
        id: 'test.consent',
        name: 'Consent test',
        version: '2.0.0',
        apiVersion: 2,
        permissions: ['notifications', 'ui.toolbar'],
      },
      requestedPermissions: ['notifications', 'ui.toolbar'],
    });
    expect(expandedUpdate).toMatchObject({
      addedPermissions: ['notifications'],
      plugin: {
        enabled: false,
        grantedPermissions: ['ui.toolbar'],
      },
    });
    expect(pluginStatus(expandedUpdate.plugin)).toBe('needs-consent');
    expect(db.repos.plugins.delete('test.consent')).toBe(true);
    expect(db.repos.plugins.getById('test.consent')).toBeNull();
  });

  it('never exposes provider API keys in the public config', async () => {
    const created = await db.repos.providerConfigs.create({
      kind: 'openai-compatible',
      name: 'Local',
      apiKey: 'sk-secret-123',
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(created.hasApiKey).toBe(true);
    expect(JSON.stringify(created)).not.toContain('sk-secret-123');

    const full = await db.repos.providerConfigs.getFullConfig(created.id);
    expect(full?.apiKey).toBe('sk-secret-123');
  });

  describe('provider secrets', () => {
    async function makeProvider(): Promise<string> {
      const provider = await db.repos.providerConfigs.create({
        kind: 'openai-compatible',
        name: 'Multi-key provider',
      });
      return provider.id;
    }

    it('masks values in the public projection and never returns them', async () => {
      const providerId = await makeProvider();
      await db.repos.providerSecrets.create(providerId, 'sk-abcdefgh1234', 'primary');

      const [secret] = await db.repos.providerSecrets.listByProvider(providerId);
      expect(secret?.label).toBe('primary');
      expect(secret?.active).toBe(true);
      expect(secret?.masked.endsWith('1234')).toBe(true);
      expect(JSON.stringify(secret)).not.toContain('sk-abcdefgh1234');
    });

    it('activates a new non-empty key and deactivates its siblings', async () => {
      const providerId = await makeProvider();
      await db.repos.providerSecrets.create(providerId, 'first-key', null);
      await db.repos.providerSecrets.create(providerId, 'second-key', null);

      const secrets = await db.repos.providerSecrets.listByProvider(providerId);
      expect(secrets).toHaveLength(2);
      const active = secrets.filter((s) => s.active);
      expect(active).toHaveLength(1);
      expect(active[0]?.masked.endsWith('y')).toBe(true); // "second-key"
      expect(await db.repos.providerSecrets.getActiveValue(providerId)).toBe('second-key');
    });

    it('keeps an empty value inactive so it never masks a usable key', async () => {
      const providerId = await makeProvider();
      await db.repos.providerSecrets.create(providerId, 'real-key', null);
      await db.repos.providerSecrets.create(providerId, '', 'placeholder');

      expect(await db.repos.providerSecrets.getActiveValue(providerId)).toBe('real-key');
      expect(await db.repos.providerSecrets.hasActive(providerId)).toBe(true);
    });

    it('renames a secret without touching its value or active state', async () => {
      const providerId = await makeProvider();
      const id = await db.repos.providerSecrets.create(providerId, 'some-key', 'old');

      const updated = await db.repos.providerSecrets.update(providerId, id, { label: 'new' });
      expect(updated?.label).toBe('new');
      expect(updated?.active).toBe(true);
      expect(await db.repos.providerSecrets.getActiveValue(providerId)).toBe('some-key');
    });

    it('switches the active key via update and deactivates the previous one', async () => {
      const providerId = await makeProvider();
      const first = await db.repos.providerSecrets.create(providerId, 'key-one', null);
      const second = await db.repos.providerSecrets.create(providerId, 'key-two', null);

      const reactivated = await db.repos.providerSecrets.update(providerId, first, {
        active: true,
      });
      expect(reactivated?.active).toBe(true);
      const secrets = await db.repos.providerSecrets.listByProvider(providerId);
      expect(secrets.filter((s) => s.active).map((s) => s.id)).toEqual([first]);
      expect(await db.repos.providerSecrets.getActiveValue(providerId)).toBe('key-one');
      // The previously-active sibling is now inactive.
      expect(secrets.find((s) => s.id === second)?.active).toBe(false);
    });

    it('reactivates the most recent remaining key when the active one is deleted', async () => {
      const providerId = await makeProvider();
      await db.repos.providerSecrets.create(providerId, 'oldest-key', null);
      const middle = await db.repos.providerSecrets.create(providerId, 'middle-key', null);
      const newest = await db.repos.providerSecrets.create(providerId, 'newest-key', null);

      // "newest-key" is active; deleting it should reactivate "middle-key".
      expect(await db.repos.providerSecrets.delete(providerId, newest)).toBe(true);
      expect(await db.repos.providerSecrets.getActiveValue(providerId)).toBe('middle-key');

      const remaining = await db.repos.providerSecrets.listByProvider(providerId);
      expect(remaining).toHaveLength(2);
      expect(remaining.map((s) => s.id)).not.toContain(newest);
      expect(remaining.find((s) => s.active)?.id).toBe(middle);
    });

    it('returns null when updating a secret of another provider', async () => {
      const providerId = await makeProvider();
      const otherId = await makeProvider();
      const id = await db.repos.providerSecrets.create(providerId, 'scoped-key', null);

      expect(await db.repos.providerSecrets.update(otherId, id, { label: 'x' })).toBeNull();
      expect(await db.repos.providerSecrets.delete(otherId, id)).toBe(false);
      // The secret is untouched.
      expect(await db.repos.providerSecrets.getActiveValue(providerId)).toBe('scoped-key');
    });

    it('clears the active key and reports hasActive=false', async () => {
      const providerId = await makeProvider();
      await db.repos.providerSecrets.create(providerId, 'temp-key', null);
      expect(await db.repos.providerSecrets.hasActive(providerId)).toBe(true);

      await db.repos.providerSecrets.clearActive(providerId);
      expect(await db.repos.providerSecrets.hasActive(providerId)).toBe(false);
      expect(await db.repos.providerSecrets.getActiveValue(providerId)).toBeNull();
    });

    it('cascade-deletes secrets when the provider is removed', async () => {
      const providerId = await makeProvider();
      await db.repos.providerSecrets.create(providerId, 'doomed-key', null);
      expect(await db.repos.providerSecrets.listByProvider(providerId)).toHaveLength(1);

      await db.repos.providerConfigs.delete(providerId);
      expect(await db.repos.providerSecrets.listByProvider(providerId)).toHaveLength(0);
    });
  });

  it('retains only the latest generation audit and rejects stale terminal updates', async () => {
    const chat = await db.repos.chats.create({ title: 'Audited chat' });
    const generationOne = '018f0000-0000-7000-8000-000000000201';
    const generationTwo = '018f0000-0000-7000-8000-000000000202';
    const makeAudit = (generationId: string, createdAt: number) => ({
      generationId,
      chatId: chat.id,
      providerConfigId: null,
      providerKind: 'echo',
      providerSource: null,
      model: 'echo',
      createdAt,
      status: 'prepared' as const,
      errorCode: null,
      chatTemplateId: null,
      promptTemplateId: null,
      promptTemplateMode: 'chat' as const,
      tokenizer: { profile: 'exact:test', approximate: false },
      budget: {
        contextLimit: 4096,
        reservedForReply: 512,
        promptTokens: 12,
      },
      contextStrategy: 'truncate',
      entries: [
        {
          identifier: 'history.message-1',
          role: 'user' as const,
          source: 'history' as const,
          content: 'private prompt content',
          tokens: 7,
          included: true,
          exclusionReason: 'none' as const,
          order: 0,
        },
      ],
      providerMessages: [{ role: 'user' as const, content: 'private prompt content' }],
      diagnostics: ['assembled 1 message(s)'],
      usage: null,
    });

    db.repos.promptContextAudits.prepare(makeAudit(generationOne, 1));
    db.repos.promptContextAudits.prepare(makeAudit(generationTwo, 2));
    expect(
      db.repos.promptContextAudits.finish(chat.id, generationOne, {
        status: 'failed',
        errorCode: 'GENERATION_FAILED',
        usage: null,
      }),
    ).toBe(false);
    expect(
      db.repos.promptContextAudits.finish(chat.id, generationTwo, {
        status: 'completed',
        errorCode: null,
        usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
      }),
    ).toBe(true);
    expect(db.repos.promptContextAudits.getLatest(chat.id)).toMatchObject({
      generationId: generationTwo,
      status: 'completed',
      entries: [{ content: 'private prompt content', included: true }],
      usage: { totalTokens: 15 },
    });

    await db.repos.chats.hardDelete(chat.id);
    expect(db.repos.promptContextAudits.getLatest(chat.id)).toBeNull();
  });

  it('reports aggregate diagnostics and clears only cache metadata', async () => {
    await db.repos.characters.create({ name: 'Diagnostic character', description: 'private text' });
    await db.repos.providerConfigs.create({
      kind: 'openai-compatible',
      name: 'Secret provider',
      apiKey: 'diagnostic-secret',
    });
    db.sqlite
      .prepare(
        `INSERT INTO cache_metadata
          (key, relative_path, source_hash, target_size, algorithm_version, mime,
           size_bytes, created_at, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('thumb', 'thumbnails/thumb.webp', 'a'.repeat(64), 256, 1, 'image/webp', 42, 1, 1);

    expect(db.diagnostics()).toMatchObject({
      integrity: 'ok',
      schemaVersion: 23,
      migrationCount: 24,
      entities: { characters: 1 },
      providers: { configured: 1, enabled: 1 },
      plugins: { installed: 0, enabled: 0 },
      themes: { installed: 0, enabled: 0 },
    });
    expect(db.clearCacheMetadata()).toBe(1);
    expect(db.clearCacheMetadata()).toBe(0);
    expect(await db.repos.characters.list({})).toMatchObject({
      items: [{ name: 'Diagnostic character' }],
    });
  });

  it('FTS rebuild restores index from base tables', async () => {
    await db.repos.characters.create({ name: 'Rebuild Me', description: 'uniqueword123' });
    await db.repos.search.rebuild();
    const res = await db.repos.search.search('uniqueword123', 'characters', 10);
    expect(res.results.length).toBeGreaterThan(0);
  });
});
