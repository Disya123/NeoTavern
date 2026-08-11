/**
 * Meta endpoints (health/version) and the built-in instruct-format catalog
 * (ТЗ §4.2: every request/response has a JSON Schema contract — no ad-hoc
 * inline TypeBox in route files).
 */
import { Type, type Static } from '@sinclair/typebox';

export const HealthResponseSchema = Type.Object({
  status: Type.Literal('ok'),
  uptime: Type.Number(),
});
export type HealthResponse = Static<typeof HealthResponseSchema>;

export const VersionResponseSchema = Type.Object({
  name: Type.String(),
  version: Type.String(),
  apiVersion: Type.Integer(),
});
export type VersionResponse = Static<typeof VersionResponseSchema>;

/** One built-in instruct format selectable via `settings.instructFormatId`. */
export const InstructFormatInfoSchema = Type.Object({
  id: Type.String(),
  version: Type.Integer(),
  stopStrings: Type.Array(Type.String()),
});
export type InstructFormatInfo = Static<typeof InstructFormatInfoSchema>;

export const InstructFormatListResponseSchema = Type.Object({
  formats: Type.Array(InstructFormatInfoSchema),
});
export type InstructFormatListResponse = Static<typeof InstructFormatListResponseSchema>;
