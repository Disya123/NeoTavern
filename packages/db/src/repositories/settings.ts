/**
 * Application settings repository (key/value JSON store).
 * Sensitive material (API keys) is NOT stored here — see provider configs.
 */
import {
  CONTEXT_TOKEN_DEFAULT,
  DEFAULT_PROMPT_TEMPLATE,
  type AppSettings,
  type AppSettingsUpdate,
} from '@neotavern/contracts';
import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '../db.js';
import { settings } from '../schema/index.js';
import { parseJson, toJson } from '../json.js';

const DEFAULTS: AppSettings = {
  language: 'en',
  themeId: null,
  activeProviderConfigId: null,
  activePersonaId: null,
  contextStrategy: 'truncate',
  maxContextTokens: CONTEXT_TOKEN_DEFAULT,
  generationDefaults: {},
  activeGenerationPresetId: null,
  activePromptTemplatePresetId: null,
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  instructFormat: null,
  instructFormatId: null,
};

/**
 * Server-registered extension settings (ТЗ §10 "no arbitrary third-party JS in
 * the main WebView"): the app-level gate for legacy frontend script injection.
 * Default false; exposed through the existing settings API (GET /api/v2/settings)
 * so the web host can read it without web-side server knowledge.
 */
const EXTENSION_SETTING_DEFAULTS: Record<string, unknown> = {
  'extensions.legacyFrontend': false,
};

export class SettingsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getAll(): Promise<AppSettings> {
    const rows = await this.db.select().from(settings);
    const result: Record<string, unknown> = { ...DEFAULTS, ...EXTENSION_SETTING_DEFAULTS };
    for (const row of rows) {
      result[row.key] = parseJson<unknown>(row.value, null);
    }
    return result as AppSettings;
  }

  async patch(update: AppSettingsUpdate): Promise<AppSettings> {
    for (const [key, value] of Object.entries(update)) {
      if (value === undefined) continue;
      await this.db
        .insert(settings)
        .values({ key, value: toJson(value) })
        .onConflictDoUpdate({ target: settings.key, set: { value: toJson(value) } })
        .run();
    }
    return this.getAll();
  }

  async set(key: string, value: unknown): Promise<void> {
    const json = toJson(value);
    await this.db
      .insert(settings)
      .values({ key, value: json })
      .onConflictDoUpdate({ target: settings.key, set: { value: json } })
      .run();
  }

  /** Read a single raw key (namespaced stores like theme settings). */
  async get(key: string): Promise<unknown | undefined> {
    const row = await this.db.select().from(settings).where(eq(settings.key, key)).get();
    return row ? parseJson<unknown>(row.value, null) : undefined;
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key)).run();
  }
}
