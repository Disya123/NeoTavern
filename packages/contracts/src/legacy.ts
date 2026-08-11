/** Public contracts used by the browser legacy compatibility bridge. */
import { Type, type Static } from '@sinclair/typebox';

export const LegacyExtensionNamespaceSchema = Type.String({
  minLength: 1,
  maxLength: 160,
  pattern: '^[a-zA-Z0-9_.-]+$',
});
export type LegacyExtensionNamespace = Static<typeof LegacyExtensionNamespaceSchema>;

export const LegacyExtensionSettingsSchema = Type.Record(Type.String(), Type.Unknown());
export type LegacyExtensionSettings = Static<typeof LegacyExtensionSettingsSchema>;

export const LegacyExtensionSettingsResponseSchema = Type.Object({
  items: Type.Record(LegacyExtensionNamespaceSchema, LegacyExtensionSettingsSchema),
});
export type LegacyExtensionSettingsResponse = Static<typeof LegacyExtensionSettingsResponseSchema>;

export const LegacyExtensionSettingsUpdateSchema = Type.Object(
  { settings: LegacyExtensionSettingsSchema },
  { additionalProperties: false },
);
export type LegacyExtensionSettingsUpdate = Static<typeof LegacyExtensionSettingsUpdateSchema>;
