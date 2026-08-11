/**
 * Integration tests for the persona routes (src/plugins/personas.ts). Boots
 * the real app against an in-memory database and exercises CRUD, default
 * persona handling, 404s and the validation envelope via Fastify inject().
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { TypedApp } from '../src/types.js';
import { createTestApp } from './helpers.js';

let app: TypedApp;

interface PersonaBody {
  id: string;
  name: string;
  description: string;
  avatar: string | null;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

// createTestApp tracks the app/database/temp dir and tears them down in its
// registered afterEach, so each test boots a fresh app.
beforeEach(async () => {
  ({ app } = await createTestApp());
});

async function listPersonas(): Promise<PersonaBody[]> {
  const res = await app.inject({ method: 'GET', url: '/api/v2/personas' });
  expect(res.statusCode).toBe(200);
  return res.json().items as PersonaBody[];
}

describe('personas', () => {
  it('creates a persona with defaults and reads it back', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/personas',
      payload: { name: 'Traveler' },
    });
    expect(created.statusCode, created.payload).toBe(200);
    expect(created.json()).toMatchObject({
      name: 'Traveler',
      description: '',
      avatar: null,
      isDefault: false,
    });
    const id = created.json().id as string;

    const fetched = await app.inject({ method: 'GET', url: `/api/v2/personas/${id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({ id, name: 'Traveler', isDefault: false });

    const listed = await listPersonas();
    expect(listed.map((persona) => persona.id)).toContain(id);
  });

  it('updates fields and moves the default flag, keeping a single default', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/v2/personas',
      payload: { name: 'First Default', isDefault: true },
    });
    expect(first.statusCode, first.payload).toBe(200);
    const firstId = first.json().id as string;
    expect(first.json().isDefault).toBe(true);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v2/personas/${firstId}`,
      payload: { name: 'Renamed', description: 'the renamed one', avatar: 'persona-1.png' },
    });
    expect(patched.statusCode, patched.payload).toBe(200);
    expect(patched.json()).toMatchObject({
      id: firstId,
      name: 'Renamed',
      description: 'the renamed one',
      avatar: 'persona-1.png',
      isDefault: true,
    });

    // A new default via create clears the previous one…
    const second = await app.inject({
      method: 'POST',
      url: '/api/v2/personas',
      payload: { name: 'Second Default', isDefault: true },
    });
    expect(second.statusCode, second.payload).toBe(200);
    const secondId = second.json().id as string;
    let defaults = (await listPersonas()).filter((persona) => persona.isDefault);
    expect(defaults.map((persona) => persona.id)).toEqual([secondId]);

    // …and PATCH can move the flag back, again leaving exactly one default.
    const moved = await app.inject({
      method: 'PATCH',
      url: `/api/v2/personas/${firstId}`,
      payload: { isDefault: true },
    });
    expect(moved.statusCode, moved.payload).toBe(200);
    expect(moved.json().isDefault).toBe(true);
    defaults = (await listPersonas()).filter((persona) => persona.isDefault);
    expect(defaults.map((persona) => persona.id)).toEqual([firstId]);

    // Clearing the flag leaves no default at all.
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/v2/personas/${firstId}`,
      payload: { isDefault: false },
    });
    expect(cleared.json().isDefault).toBe(false);
    expect((await listPersonas()).filter((persona) => persona.isDefault)).toEqual([]);
  });

  it('deletes personas and acknowledges deleting unknown ids', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/personas',
      payload: { name: 'Disposable' },
    });
    const id = created.json().id as string;

    const deleted = await app.inject({ method: 'DELETE', url: `/api/v2/personas/${id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });
    expect((await listPersonas()).map((persona) => persona.id)).not.toContain(id);

    const gone = await app.inject({ method: 'GET', url: `/api/v2/personas/${id}` });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().code).toBe('PERSONA_NOT_FOUND');

    // Delete is an acknowledgement: unknown ids still return ok.
    const again = await app.inject({ method: 'DELETE', url: `/api/v2/personas/${id}` });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ ok: true });
  });

  it('returns PERSONA_NOT_FOUND for unknown ids on get and patch', async () => {
    const fetched = await app.inject({ method: 'GET', url: '/api/v2/personas/no-such-persona' });
    expect(fetched.statusCode).toBe(404);
    expect(fetched.json()).toMatchObject({
      code: 'PERSONA_NOT_FOUND',
      params: { personaId: 'no-such-persona' },
    });

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/v2/personas/no-such-persona',
      payload: { name: 'ghost' },
    });
    expect(patched.statusCode).toBe(404);
    expect(patched.json()).toMatchObject({
      code: 'PERSONA_NOT_FOUND',
      params: { personaId: 'no-such-persona' },
    });
  });

  it('rejects invalid bodies with a VALIDATION envelope', async () => {
    const missingName = await app.inject({
      method: 'POST',
      url: '/api/v2/personas',
      payload: { description: 'nameless' },
    });
    expect(missingName.statusCode).toBe(422);
    expect(missingName.json().code).toBe('VALIDATION');

    const emptyName = await app.inject({
      method: 'POST',
      url: '/api/v2/personas',
      payload: { name: '' },
    });
    expect(emptyName.statusCode).toBe(422);
    expect(emptyName.json().code).toBe('VALIDATION');

    const oversizedName = await app.inject({
      method: 'POST',
      url: '/api/v2/personas',
      payload: { name: 'x'.repeat(501) },
    });
    expect(oversizedName.statusCode).toBe(422);
    expect(oversizedName.json().code).toBe('VALIDATION');
  });
});
