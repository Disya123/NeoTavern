/**
 * Connection profiles repository tests (OTHER-67): the repository stays in
 * the tree but is deliberately NOT on the AppDatabase facade until the
 * feature gains routes/UI — so these tests construct it directly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAppDatabase, systemClock, ConnectionProfileRepository } from '../src/index.js';

describe('connection profiles repository', () => {
  let db: ReturnType<typeof createAppDatabase>;
  let repository: ConnectionProfileRepository;

  beforeEach(() => {
    db = createAppDatabase(':memory:');
    repository = new ConnectionProfileRepository(db.db, systemClock);
  });
  afterEach(() => {
    db.close();
  });

  it('creates, lists and reads back a profile with its overrides', async () => {
    const created = await repository.create({
      name: 'Local ooba',
      mode: 'text',
      providerConfigId: '018f0000-0000-7000-8000-000000000aaa',
      model: 'llama-local',
      promptPostProcessing: 'merge',
      includeBody: { grammar: 'chat.gbnf' },
      exclude: ['model'],
    });
    expect(created.id).toMatch(/-/);
    expect(created.name).toBe('Local ooba');
    expect(created.mode).toBe('text');

    const listed = await repository.list();
    expect(listed).toHaveLength(1);

    const fetched = await repository.getById(created.id);
    expect(fetched).toMatchObject({
      name: 'Local ooba',
      mode: 'text',
      providerConfigId: '018f0000-0000-7000-8000-000000000aaa',
      model: 'llama-local',
      promptPostProcessing: 'merge',
      exclude: ['model'],
    });
    expect(fetched?.includeBody).toEqual({ grammar: 'chat.gbnf' });
  });

  it('defaults exclude to an empty list when omitted', async () => {
    const created = await repository.create({ name: 'Bare', mode: 'chat' });
    expect(created.exclude).toEqual([]);
    const fetched = await repository.getById(created.id);
    expect(fetched?.exclude).toEqual([]);
  });

  it('merges a partial update over the stored payload, preserving other fields', async () => {
    const created = await repository.create({
      name: 'Profile',
      mode: 'chat',
      model: 'gpt-x',
      baseUrl: 'http://localhost:8000/v1',
      includeBody: { logprobs: true },
    });

    const updated = await repository.update(created.id, {
      name: 'Renamed',
      model: 'gpt-y',
    });
    expect(updated).toMatchObject({
      name: 'Renamed',
      mode: 'chat',
      model: 'gpt-y',
      // Untouched fields survive the partial update.
      baseUrl: 'http://localhost:8000/v1',
    });
    expect(updated?.includeBody).toEqual({ logprobs: true });
  });

  it('replaces the exclude list wholesale on update', async () => {
    const created = await repository.create({
      name: 'Profile',
      mode: 'chat',
      exclude: ['model'],
    });
    const updated = await repository.update(created.id, {
      exclude: ['baseUrl', 'presetId'],
    });
    expect(updated?.exclude).toEqual(['baseUrl', 'presetId']);
  });

  it('returns null when updating or deleting a missing profile', async () => {
    expect(await repository.update('missing', { name: 'x' })).toBeNull();
    expect(await repository.delete('missing')).toBe(false);
  });

  it('deletes a profile', async () => {
    const created = await repository.create({ name: 'Doomed', mode: 'chat' });
    expect(await repository.delete(created.id)).toBe(true);
    expect(await repository.getById(created.id)).toBeNull();
    expect(await repository.list()).toHaveLength(0);
  });
});
