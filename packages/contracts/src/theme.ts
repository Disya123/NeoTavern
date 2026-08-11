/**
 * Public Theme SDK runtime contracts.
 *
 * Theme manifests remain owned and validated by `@neotavern/theme-sdk`; the API
 * transports the validated JSON without duplicating that package's schema.
 */
import { Type, type Static } from '@sinclair/typebox';

export const ThemeIdSchema = Type.String({
  minLength: 1,
  maxLength: 160,
  pattern: '^[a-z0-9][a-z0-9_-]*(\\.[a-z0-9][a-z0-9_-]*)*$',
});
export type ThemeId = Static<typeof ThemeIdSchema>;

export const InstalledThemeSchema = Type.Object({
  id: ThemeIdSchema,
  name: Type.String({ minLength: 1, maxLength: 200 }),
  version: Type.String({ minLength: 1, maxLength: 100 }),
  enabled: Type.Boolean(),
  manifest: Type.Record(Type.String(), Type.Unknown()),
  installedAt: Type.Integer({ minimum: 0 }),
  componentsCssUrl: Type.Union([Type.String(), Type.Null()]),
  shellCssUrl: Type.Union([Type.String(), Type.Null()]),
  previewUrl: Type.Union([Type.String(), Type.Null()]),
  /** Theme translation resources: language code → asset URL (ТЗ §9). */
  localesUrls: Type.Optional(Type.Record(Type.String(), Type.String())),
});
export type InstalledTheme = Static<typeof InstalledThemeSchema>;

/** Persisted theme-setting values (validated server-side against the manifest). */
export const ThemeSettingsValuesSchema = Type.Record(Type.String(), Type.Unknown());
export type ThemeSettingsValues = Static<typeof ThemeSettingsValuesSchema>;

export const ThemeSettingsResponseSchema = Type.Object({
  values: ThemeSettingsValuesSchema,
});
export type ThemeSettingsResponse = Static<typeof ThemeSettingsResponseSchema>;

export const ThemeListResponseSchema = Type.Object({
  items: Type.Array(InstalledThemeSchema),
  activeThemeId: Type.Union([ThemeIdSchema, Type.Null()]),
});
export type ThemeListResponse = Static<typeof ThemeListResponseSchema>;

export const ThemeInstallResultSchema = Type.Object({
  theme: InstalledThemeSchema,
  replaced: Type.Boolean(),
});
export type ThemeInstallResult = Static<typeof ThemeInstallResultSchema>;

export const ThemeActivationResultSchema = Type.Object({
  activeThemeId: Type.Union([ThemeIdSchema, Type.Null()]),
});
export type ThemeActivationResult = Static<typeof ThemeActivationResultSchema>;

export const ThemeDeleteResultSchema = Type.Object({
  deleted: Type.Boolean(),
  activeThemeId: Type.Union([ThemeIdSchema, Type.Null()]),
});
export type ThemeDeleteResult = Static<typeof ThemeDeleteResultSchema>;

/**
 * Pre-hydration theme bootstrap (anti-FOUC): everything a plain inline script
 * needs to apply the active theme before React mounts — resolved token
 * variables for both modes and the package stylesheet URLs.
 */
export const ThemeBootResponseSchema = Type.Object({
  themeId: Type.Union([ThemeIdSchema, Type.Null()]),
  cssUrls: Type.Array(Type.String()),
  light: Type.Record(Type.String(), Type.String()),
  dark: Type.Record(Type.String(), Type.String()),
});
export type ThemeBootResponse = Static<typeof ThemeBootResponseSchema>;
