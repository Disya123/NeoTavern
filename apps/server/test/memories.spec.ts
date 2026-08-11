/**
 * Integration tests for the memory/RAG routes (src/plugins/memories.ts, ТЗ
 * §4.4). Boots the real app against an in-memory database and exercises CRUD,
 * scope/character filtering, the enabled flag and the validation/404
 * envelopes via Fastify inject() — zero route mocks.
 *
 * Note on FTS: `memories_fts` is only consumed inside the prompt pipeline via
 * `MemoryRepository.ftsMatchRanks`; the search route's scopes are
 * characters/chats/messages/lorebooks (no `memories` scope), so no HTTP route
 * exposes memory FTS and it is deliberately not asserted here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { TypedApp } from '../src/types.js';
import { createTestApp } from './helpers.js';

let app: TypedApp;
let characterId: string;

interface MemoryBody {
  id: string;
  scope: 'global' | 'character';
  characterId: string | null;
  keys: string[];
  content: string;
  enabled: boolean;
  position: number;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

// createTestApp tracks the app/database/temp dir and tears them down in its
// registered afterEach, so each test boots a fresh app (and character).
beforeEach(async () => {
  ({ app } = await createTestApp());
  const character = await app.inject({
    method: 'POST',
    url: '/api/v2/characters',
    payload: { name: 'Memory Bot' },
  });
  expect(character.statusCode).toBe(200);
  characterId = character.json().id as string;
});

async function listMemories(query = ''): Promise<MemoryBody[]> {
  const res = await app.inject({ method: 'GET', url: `/api/v2/memories${query}` });
  expect(res.statusCode).toBe(200);
  return res.json().items as MemoryBody[];
}

describe('memories', () => {
  it('creates a memory with repo defaults and runs the full CRUD lifecycle', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/memories',
      payload: { content: 'The lighthouse keeper logs every storm.' },
    });
    expect(created.statusCode, created.payload).toBe(200);
    const memory = created.json() as MemoryBody;
    expect(memory).toMatchObject({
      scope: 'global',
      characterId: null,
      keys: [],
      content: 'The lighthouse keeper logs every storm.',
      enabled: true,
      position: 0,
      metadata: {},
    });
    expect(memory.id.length).toBeGreaterThan(0);
    expect(memory.updatedAt).toBeGreaterThanOrEqual(memory.createdAt);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v2/memories/${memory.id}`,
      payload: {
        content: 'The lighthouse keeper logs every storm and ship.',
        keys: ['lighthouse', 'storm'],
        enabled: false,
        position: 7,
      },
    });
    expect(patched.statusCode, patched.payload).toBe(200);
    expect(patched.json()).toMatchObject({
      id: memory.id,
      content: 'The lighthouse keeper logs every storm and ship.',
      keys: ['lighthouse', 'storm'],
      enabled: false,
      position: 7,
    });

    const listed = await listMemories();
    const reloaded = listed.find((item) => item.id === memory.id);
    expect(reloaded).toMatchObject({ keys: ['lighthouse', 'storm'], enabled: false, position: 7 });

    const deleted = await app.inject({ method: 'DELETE', url: `/api/v2/memories/${memory.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });
    expect((await listMemories()).some((item) => item.id === memory.id)).toBe(false);
  });

  it('infers character scope from characterId and filters the list by scope, character and enabled', async () => {
    // characterId without an explicit scope infers scope "character".
    const inferred = await app.inject({
      method: 'POST',
      url: '/api/v2/memories',
      payload: { content: 'Prefers charts drawn by hand.', characterId },
    });
    expect(inferred.statusCode, inferred.payload).toBe(200);
    expect(inferred.json()).toMatchObject({ scope: 'character', characterId });
    const inferredId = inferred.json().id as string;

    const explicit = await app.inject({
      method: 'POST',
      url: '/api/v2/memories',
      payload: {
        scope: 'character',
        characterId,
        keys: ['tea'],
        content: 'Drinks salted tea at dusk.',
        position: 3,
        metadata: { source: 'session-1' },
      },
    });
    expect(explicit.statusCode, explicit.payload).toBe(200);
    expect(explicit.json()).toMatchObject({
      scope: 'character',
      characterId,
      metadata: { source: 'session-1' },
    });
    const explicitId = explicit.json().id as string;

    const globalMemory = await app.inject({
      method: 'POST',
      url: '/api/v2/memories',
      payload: { scope: 'global', content: 'The archive closes at midnight.', enabled: false },
    });
    expect(globalMemory.statusCode, globalMemory.payload).toBe(200);
    const globalId = globalMemory.json().id as string;

    const byScope = await listMemories('?scope=character');
    expect(byScope.every((item) => item.scope === 'character')).toBe(true);
    expect(byScope.map((item) => item.id)).toEqual(
      expect.arrayContaining([inferredId, explicitId]),
    );
    expect(byScope.map((item) => item.id)).not.toContain(globalId);

    const byCharacter = await listMemories(`?characterId=${characterId}`);
    expect(byCharacter.map((item) => item.id)).toEqual(
      expect.arrayContaining([inferredId, explicitId]),
    );
    expect(byCharacter.every((item) => item.characterId === characterId)).toBe(true);

    const disabledOnly = await listMemories('?enabled=false');
    expect(disabledOnly.map((item) => item.id)).toContain(globalId);
    expect(disabledOnly.every((item) => item.enabled === false)).toBe(true);
    expect(disabledOnly.map((item) => item.id)).not.toContain(explicitId);

    const combined = await listMemories(`?scope=character&characterId=${characterId}&enabled=true`);
    expect(combined.map((item) => item.id)).toEqual(
      expect.arrayContaining([inferredId, explicitId]),
    );

    // Metadata PATCH merges over the stored record instead of replacing it.
    const merged = await app.inject({
      method: 'PATCH',
      url: `/api/v2/memories/${explicitId}`,
      payload: { metadata: { reviewed: true } },
    });
    expect(merged.json().metadata).toEqual({ source: 'session-1', reviewed: true });
  });

  it('rejects invalid create bodies with a VALIDATION envelope', async () => {
    const missingContent = await app.inject({
      method: 'POST',
      url: '/api/v2/memories',
      payload: { keys: ['no-content'] },
    });
    expect(missingContent.statusCode).toBe(422);
    expect(missingContent.json().code).toBe('VALIDATION');

    const emptyContent = await app.inject({
      method: 'POST',
      url: '/api/v2/memories',
      payload: { content: '' },
    });
    expect(emptyContent.statusCode).toBe(422);
    expect(emptyContent.json().code).toBe('VALIDATION');

    const characterScopeWithoutId = await app.inject({
      method: 'POST',
      url: '/api/v2/memories',
      payload: { scope: 'character', content: 'orphaned character memory' },
    });
    expect(characterScopeWithoutId.statusCode).toBe(422);
    expect(characterScopeWithoutId.json()).toMatchObject({
      code: 'VALIDATION',
      params: { path: 'characterId' },
    });

    const badScope = await app.inject({
      method: 'POST',
      url: '/api/v2/memories',
      payload: { content: 'x', scope: 'universe' },
    });
    expect(badScope.statusCode).toBe(422);
    expect(badScope.json().code).toBe('VALIDATION');

    const badPosition = await app.inject({
      method: 'POST',
      url: '/api/v2/memories',
      payload: { content: 'x', position: -1 },
    });
    expect(badPosition.statusCode).toBe(422);
    expect(badPosition.json().code).toBe('VALIDATION');
  });

  it('returns 404 envelopes for unknown characters on create and unknown memories on patch', async () => {
    const unknownCharacter = await app.inject({
      method: 'POST',
      url: '/api/v2/memories',
      payload: { content: 'belongs to nobody', characterId: 'no-such-character' },
    });
    expect(unknownCharacter.statusCode).toBe(404);
    expect(unknownCharacter.json()).toMatchObject({
      code: 'CHARACTER_NOT_FOUND',
      params: { characterId: 'no-such-character' },
    });

    const unknownMemory = await app.inject({
      method: 'PATCH',
      url: '/api/v2/memories/no-such-memory',
      payload: { content: 'update?' },
    });
    expect(unknownMemory.statusCode).toBe(404);
    expect(unknownMemory.json()).toMatchObject({
      code: 'NOT_FOUND',
      params: { memoryId: 'no-such-memory' },
    });
  });

  it('treats delete as an idempotent acknowledgement', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/memories',
      payload: { content: 'short-lived fact' },
    });
    const id = created.json().id as string;

    const first = await app.inject({ method: 'DELETE', url: `/api/v2/memories/${id}` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });

    const second = await app.inject({ method: 'DELETE', url: `/api/v2/memories/${id}` });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true });
  });
});
