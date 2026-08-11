/**
 * Common schemas shared by every API contract: identifiers, timestamps,
 * cursor pagination and the error envelope.
 */
import { Type, type Static } from '@sinclair/typebox';

/** A stable string entity identifier (UUIDv7). */
export const IdSchema = Type.String({ minLength: 1, maxLength: 64 });
export type Id = Static<typeof IdSchema>;

/** Unix epoch milliseconds. */
export const TimestampSchema = Type.Integer({ minimum: 0 });
export type Timestamp = Static<typeof TimestampSchema>;

/** Common creation/update metadata. */
export const TimestampsSchema = Type.Object({
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Timestamps = Static<typeof TimestampsSchema>;

/** Cursor-based pagination query (no offset — see AGENTS.md §4). */
export const CursorPageQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
});
export type CursorPageQuery = Static<typeof CursorPageQuerySchema>;

/** Build a cursor-page response schema for a given item schema. */
export function CursorPageSchema<T extends ReturnType<typeof Type.Object>>(item: T) {
  return Type.Object({
    items: Type.Array(item),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
    hasMore: Type.Boolean(),
  });
}
export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

/**
 * The API error envelope. `code` is a stable machine code; the frontend
 * localizes it. See AGENTS.md §5 / ТЗ §4.2.
 */
export const ErrorEnvelopeSchema = Type.Object({
  code: Type.String(),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  traceId: Type.Optional(Type.String()),
});
export type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;

/** A generic boolean acknowledgement. */
export const AckSchema = Type.Object({ ok: Type.Boolean() });
export type Ack = Static<typeof AckSchema>;
