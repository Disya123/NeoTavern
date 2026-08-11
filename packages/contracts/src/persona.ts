/**
 * Persona (user identity) schemas. A persona is the "user" side injected into
 * the prompt pipeline as {{user}}.
 */
import { Type, type Static } from '@sinclair/typebox';
import { IdSchema, TimestampSchema } from './common.js';

export const PersonaSchema = Type.Object({
  id: IdSchema,
  name: Type.String(),
  description: Type.String(),
  avatar: Type.Union([Type.String(), Type.Null()]),
  isDefault: Type.Boolean(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Persona = Static<typeof PersonaSchema>;

export const PersonaCreateSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 500 }),
  description: Type.Optional(Type.String()),
  avatar: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  isDefault: Type.Optional(Type.Boolean()),
});
export type PersonaCreate = Static<typeof PersonaCreateSchema>;

export const PersonaUpdateSchema = Type.Partial(PersonaCreateSchema);
export type PersonaUpdate = Static<typeof PersonaUpdateSchema>;

/**
 * The "active persona" rule as a pure function over an in-memory list
 * (ARCH-13): chat-level override → app-wide active persona → the persona
 * flagged default, falling through at each level on a stale reference. The
 * server applies the identical rule in `PersonaRepository.resolveActive`;
 * the web applies this one — both must stay word-for-word equivalent.
 */
export function pickActivePersona<T extends { id: string; isDefault?: boolean | null }>(
  personas: readonly T[],
  chatPersonaId: string | null | undefined,
  appPersonaId: string | null | undefined,
): T | null {
  if (chatPersonaId) {
    const chatPersona = personas.find((persona) => persona.id === chatPersonaId);
    if (chatPersona) return chatPersona;
  }
  if (appPersonaId) {
    const appPersona = personas.find((persona) => persona.id === appPersonaId);
    if (appPersona) return appPersona;
  }
  return personas.find((persona) => persona.isDefault) ?? null;
}
