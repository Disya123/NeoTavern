/** Plugin OAuth connection API contracts (rev4 §K5, api.auth). */
import { Type, type Static } from '@sinclair/typebox';

export const PluginAuthConnectionStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('connected'),
  Type.Literal('expired'),
  Type.Literal('revoked'),
]);
export type PluginAuthConnectionStatus = Static<typeof PluginAuthConnectionStatusSchema>;

/**
 * Public connection metadata as seen by the host UI and the sandbox.
 * Deliberately contains NO token material — tokens never leave the server.
 */
export const PluginAuthConnectionWireSchema = Type.Object(
  {
    connectionId: Type.String({ minLength: 1, maxLength: 64 }),
    serviceId: Type.String({ minLength: 1, maxLength: 200 }),
    serviceName: Type.String({ minLength: 1, maxLength: 100 }),
    scopes: Type.Array(Type.String({ minLength: 1, maxLength: 200 })),
    status: PluginAuthConnectionStatusSchema,
    createdAt: Type.Integer({ minimum: 0 }),
    updatedAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type PluginAuthConnectionWire = Static<typeof PluginAuthConnectionWireSchema>;

export const PluginAuthConnectionsResponseSchema = Type.Object({
  items: Type.Array(PluginAuthConnectionWireSchema),
});
export type PluginAuthConnectionsResponse = Static<typeof PluginAuthConnectionsResponseSchema>;

export const PluginAuthConnectRequestSchema = Type.Object(
  {
    serviceId: Type.String({ minLength: 1, maxLength: 200 }),
    scopes: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 100 }),
    ),
  },
  { additionalProperties: false },
);
export type PluginAuthConnectRequest = Static<typeof PluginAuthConnectRequestSchema>;

export const PluginAuthConnectResultSchema = Type.Object({
  connectionId: Type.String({ minLength: 1, maxLength: 64 }),
  status: Type.Union([Type.Literal('pending'), Type.Literal('connected')]),
  /** https URL the user opens to authorize; null when already connected. */
  authorizationUrl: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
});
export type PluginAuthConnectResult = Static<typeof PluginAuthConnectResultSchema>;

export const PluginAuthRevokeRequestSchema = Type.Object(
  {
    connectionId: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);
export type PluginAuthRevokeRequest = Static<typeof PluginAuthRevokeRequestSchema>;

export const PluginAuthRevokeResultSchema = Type.Object({
  ok: Type.Boolean(),
});
export type PluginAuthRevokeResult = Static<typeof PluginAuthRevokeResultSchema>;

/**
 * Authenticated fetch through the host proxy (rev4 §K5): the server resolves
 * the connection token and signs the request; the sandbox never holds it.
 * Used by web sandboxes; backend sandboxes use the same shape over RPC.
 */
export const PluginAuthFetchRequestSchema = Type.Object(
  {
    url: Type.String({ minLength: 1, maxLength: 2048 }),
    connectionId: Type.String({ minLength: 1, maxLength: 64 }),
    method: Type.Optional(
      Type.Union([
        Type.Literal('GET'),
        Type.Literal('POST'),
        Type.Literal('PUT'),
        Type.Literal('PATCH'),
        Type.Literal('DELETE'),
        Type.Literal('HEAD'),
      ]),
    ),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    bodyText: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type PluginAuthFetchRequest = Static<typeof PluginAuthFetchRequestSchema>;

export const PluginAuthFetchResultSchema = Type.Object({
  status: Type.Integer({ minimum: 0 }),
  headers: Type.Record(Type.String(), Type.String()),
  bodyText: Type.String(),
});
export type PluginAuthFetchResult = Static<typeof PluginAuthFetchResultSchema>;

/** Query of the OAuth callback (called by the IdP after user consent). */
export const PluginAuthCallbackQuerySchema = Type.Object({
  code: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  state: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  error: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  error_description: Type.Optional(Type.String({ maxLength: 512 })),
});
export type PluginAuthCallbackQuery = Static<typeof PluginAuthCallbackQuerySchema>;
