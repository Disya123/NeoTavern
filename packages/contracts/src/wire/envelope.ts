/**
 * Wire envelopes: the three top-level message shapes exchanged over the wire
 * (request / response / event) plus protocol-level constants. Envelope
 * `payload` / `result` slots are deliberately tolerant (`additionalProperties:
 * true`) so operation DTOs stay the strict, schema-checked surface.
 */
import { Type, type Static } from '@sinclair/typebox';
import { ProductErrorDtoSchema } from './errors.js';

/** Wire protocol version carried by every envelope. */
export const WIRE_PROTOCOL = { major: 1, minor: 0 } as const;

/** JSON Schema dialect that all wire schemas are emitted in. */
export const SCHEMA_DIALECT = 'JSON Schema 2020-12' as const;

/** FFI ABI version shared with the Rust kernel (must equal 1). */
export const FFI_ABI_VERSION = 1 as const;

/** Version of the generator that produces the contract bundle/manifest. */
export const GENERATOR_VERSION = '1.0.0' as const;

/**
 * Request envelope (`wire.request.envelope`): every request carries the wire
 * protocol version, the schema hash it was built against, a request id and
 * the operation's request payload.
 */
export const RequestEnvelopeSchema = Type.Object(
  {
    wireProtocol: Type.Object({
      major: Type.Integer({ minimum: 1 }),
      minor: Type.Integer({ minimum: 0 }),
    }),
    schemaHash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    requestId: Type.String({ format: 'uuid' }),
    operationId: Type.String({ minLength: 1, maxLength: 128 }),
    payload: Type.Object({}, { additionalProperties: true }),
  },
  { $id: 'wire.request.envelope', additionalProperties: false },
);
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>;

/**
 * Response envelope (`wire.response.envelope`): a discriminated union on
 * `kind` with an `ok` variant carrying the operation result and an `error`
 * variant carrying a product error.
 */
export const ResponseEnvelopeSchema = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal('ok'),
        requestId: Type.String({ format: 'uuid' }),
        result: Type.Object({}, { additionalProperties: true }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('error'),
        requestId: Type.String({ format: 'uuid' }),
        error: ProductErrorDtoSchema,
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'wire.response.envelope', 'x-wire-discriminator': 'kind' },
);
export type ResponseEnvelope = Static<typeof ResponseEnvelopeSchema>;

/**
 * Event envelope (`wire.event.envelope`): streaming payloads (e.g. generation
 * progress) addressed to a stream with a monotonically increasing sequence.
 */
export const EventEnvelopeSchema = Type.Object(
  {
    streamId: Type.String({ format: 'uuid' }),
    sequence: Type.Integer({ minimum: 0 }),
    type: Type.String({ minLength: 1, maxLength: 128 }),
    payload: Type.Object({}, { additionalProperties: true }),
  },
  { $id: 'wire.event.envelope', additionalProperties: false },
);
export type EventEnvelope = Static<typeof EventEnvelopeSchema>;
