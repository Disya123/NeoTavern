/**
 * App event channel contract (ARCH-12).
 *
 * The SSE stream (/api/v2/events) and its consumers used to agree on event
 * names and the envelope shape by string coincidence across three packages;
 * the whitelist had already drifted. The relayed event set and the envelope
 * are defined here once — the server relay and the web subscriber both
 * derive from these.
 */
import { Type, type Static } from '@sinclair/typebox';

/** Events the server relays to browsers over SSE for cache invalidation. */
export const BROWSER_APP_EVENTS = [
  'chat.created',
  'chat.opened',
  'chat.message.created',
  'chat.message.updated',
  'chat.message.deleted',
  'character.selected',
  'generation.started',
  'generation.delta',
  'generation.finished',
  'generation.error',
] as const;
export type BrowserAppEvent = (typeof BROWSER_APP_EVENTS)[number];

/** Wire envelope of a relayed app event frame. */
export const AppEventEnvelopeSchema = Type.Object({
  type: Type.Literal('event'),
  event: Type.String(),
  payload: Type.Optional(Type.Unknown()),
});
export type AppEventEnvelope = Static<typeof AppEventEnvelopeSchema>;
