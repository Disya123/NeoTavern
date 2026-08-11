/** Local/remote access-session contracts. Authentication secrets are input-only. */
import { Type, type Static } from '@sinclair/typebox';

export const AuthSessionSchema = Type.Object({
  required: Type.Boolean(),
  authenticated: Type.Boolean(),
  expiresAt: Type.Optional(Type.Integer({ minimum: 0 })),
  csrfToken: Type.Optional(Type.String({ minLength: 32, maxLength: 256 })),
});
export type AuthSession = Static<typeof AuthSessionSchema>;

export const AuthLoginSchema = Type.Object(
  {
    token: Type.String({ minLength: 1, maxLength: 1024 }),
  },
  { additionalProperties: false },
);
export type AuthLogin = Static<typeof AuthLoginSchema>;
