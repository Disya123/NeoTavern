/**
 * Application database facade: opens the SQLite connection, runs migrations
 * automatically, and exposes typed repositories. This is the only entry point
 * the server needs — plugins never receive this directly (AGENTS.md §11).
 */
import { openDatabase, type SqliteConnection } from './connection.js';
import { createDrizzle, systemClock, type Clock, type DrizzleDb } from './db.js';
import { runMigrations } from './migrate.js';
import { createLogger, uuidv7 } from '@neotavern/shared';
import { AppMetaRepository } from './repositories/appMeta.js';
import { AttachmentRepository } from './repositories/attachments.js';
import { CacheMetadataRepository } from './repositories/cacheMetadata.js';
import { CharacterRepository } from './repositories/characters.js';
import { ChatRepository } from './repositories/chats.js';
import { MessageRepository } from './repositories/messages.js';
import { MessageDraftRepository } from './repositories/messageDrafts.js';
import { MessageBlockRepository } from './repositories/messageBlocks.js';
import { SnapshotRepository } from './repositories/snapshots.js';
import { PersonaRepository } from './repositories/personas.js';
import { LorebookRepository } from './repositories/lorebooks.js';
import { MemoryRepository } from './repositories/memories.js';
import { PresetRepository } from './repositories/presets.js';
import { ProfileRepository } from './repositories/profiles.js';
import { PromptContextAuditRepository } from './repositories/promptContextAudits.js';
import { SettingsRepository } from './repositories/settings.js';
import { ProviderConfigRepository } from './repositories/providerConfigs.js';
import { ProviderSecretRepository } from './repositories/providerSecrets.js';
import { ConnectionProfileRepository } from './repositories/connectionProfiles.js';
import { SearchRepository } from './repositories/search.js';
import { DataImportRepository } from './repositories/dataImports.js';
import { ThemeRepository } from './repositories/themes.js';
import { PluginRepository } from './repositories/plugins.js';
import {
  CapabilityGrantRepository,
  PluginStateRepository,
} from './repositories/pluginCapabilities.js';
import { PluginAuthRepository } from './repositories/pluginAuth.js';
import { PluginSecretRepository } from './repositories/pluginSecrets.js';

export interface Repositories {
  appMeta: AppMetaRepository;
  attachments: AttachmentRepository;
  cacheMetadata: CacheMetadataRepository;
  characters: CharacterRepository;
  chats: ChatRepository;
  messages: MessageRepository;
  messageDrafts: MessageDraftRepository;
  messageBlocks: MessageBlockRepository;
  snapshots: SnapshotRepository;
  personas: PersonaRepository;
  lorebooks: LorebookRepository;
  memories: MemoryRepository;
  presets: PresetRepository;
  profiles: ProfileRepository;
  promptContextAudits: PromptContextAuditRepository;
  settings: SettingsRepository;
  providerConfigs: ProviderConfigRepository;
  providerSecrets: ProviderSecretRepository;
  connectionProfiles: ConnectionProfileRepository;
  search: SearchRepository;
  dataImports: DataImportRepository;
  themes: ThemeRepository;
  plugins: PluginRepository;
  pluginState: PluginStateRepository;
  capabilityGrants: CapabilityGrantRepository;
  authConnections: PluginAuthRepository;
  pluginSecrets: PluginSecretRepository;
}

export interface DatabaseDiagnostics {
  integrity: 'ok' | 'error';
  schemaVersion: number;
  migrationCount: number;
  entities: {
    characters: number;
    chats: number;
    messages: number;
    personas: number;
    lorebooks: number;
    presets: number;
  };
  providers: { configured: number; enabled: number };
  plugins: { installed: number; enabled: number };
  themes: { installed: number; enabled: number };
}

export interface AppDatabase {
  readonly sqlite: SqliteConnection;
  readonly db: DrizzleDb;
  readonly repos: Repositories;
  close(): void;
  /** Online backup via SQLite's backup API (safe with WAL). */
  backup(destPath: string): Promise<void>;
  /**
   * Restore a complete SQLite snapshot into the live database through the
   * online backup API. Existing repositories remain usable after completion.
   */
  restore(sourcePath: string): Promise<void>;
  /** Aggregate, content-free state for the redacted diagnostic report. */
  diagnostics(): DatabaseDiagnostics;
  /** Remove metadata for regenerable cache entries. Returns affected rows. */
  clearCacheMetadata(): number;
}

export interface CreateDatabaseOptions {
  clock?: Clock;
  /** Skip running migrations (tests that manage schema manually). */
  skipMigrations?: boolean;
  /**
   * Directory for automatic pre-migration backups (ТЗ §10.4). When set, a
   * snapshot is taken before any pending migration is applied.
   */
  autoBackupDir?: string;
  /**
   * Resolves an opaque secret reference to a value (ТЗ §SEC-01). Injected by
   * the server; without it, provider secrets resolve to null and the provider
   * runtime reports the key as unavailable.
   */
  secretResolver?: (ref: string) => Promise<string | null>;
}

export function createAppDatabase(path: string, options: CreateDatabaseOptions = {}): AppDatabase {
  const sqlite = openDatabase({ path });
  const db = createDrizzle(sqlite);
  if (!options.skipMigrations) {
    runMigrations(sqlite, createLogger({ scope: 'db' }), undefined, {
      ...(options.autoBackupDir ? { autoBackup: { backupDir: options.autoBackupDir } } : {}),
    });
  }
  const clock = options.clock ?? systemClock;

  const appMeta = new AppMetaRepository(db);
  const providerSecrets = new ProviderSecretRepository(db, clock);
  // Stable install identity (ТЗ §10.2): generated once on first open and kept
  // for the lifetime of the data directory. Synchronous on purpose — this
  // must never race with callers that close the database right after open.
  sqlite
    .prepare(
      `INSERT INTO app_meta (key, value) VALUES ('install_id', ?)
       ON CONFLICT(key) DO NOTHING`,
    )
    .run(uuidv7());

  const repos: Repositories = {
    appMeta,
    attachments: new AttachmentRepository(db, clock),
    cacheMetadata: new CacheMetadataRepository(db, clock),
    characters: new CharacterRepository(db, clock),
    chats: new ChatRepository(db, clock),
    messages: new MessageRepository(db, clock),
    messageDrafts: new MessageDraftRepository(db, clock),
    messageBlocks: new MessageBlockRepository(db, clock),
    snapshots: new SnapshotRepository(db, clock),
    personas: new PersonaRepository(db, clock),
    lorebooks: new LorebookRepository(db, clock),
    memories: new MemoryRepository(db, clock),
    presets: new PresetRepository(db, clock),
    // Profiles use the app_meta store for the active-profile marker.
    profiles: new ProfileRepository(db, clock, appMeta),
    promptContextAudits: new PromptContextAuditRepository(sqlite),
    settings: new SettingsRepository(db),
    providerSecrets,
    providerConfigs: new ProviderConfigRepository(
      db,
      clock,
      providerSecrets,
      options.secretResolver,
    ),
    connectionProfiles: new ConnectionProfileRepository(db, clock),
    search: new SearchRepository(db),
    dataImports: new DataImportRepository(sqlite, clock),
    themes: new ThemeRepository(sqlite),
    plugins: new PluginRepository(sqlite),
    pluginState: new PluginStateRepository(sqlite),
    capabilityGrants: new CapabilityGrantRepository(sqlite),
    authConnections: new PluginAuthRepository(sqlite),
    pluginSecrets: new PluginSecretRepository(sqlite),
  };

  return {
    sqlite,
    db,
    repos,
    close: () => sqlite.close(),
    backup: async (destPath: string) => {
      await sqlite.backup(destPath);
    },
    restore: async (sourcePath: string) => {
      if (path === ':memory:') {
        throw new Error('Cannot restore a file snapshot into an in-memory database');
      }
      // Handle hygiene (ТЗ §10.3.1, §17.4): the source handle must be closed on
      // every exit path, including a failed openDatabase() (openDatabase itself
      // closes on pragma failure — the null guard here is defense in depth).
      let source: SqliteConnection | null = null;
      try {
        source = openDatabase({ path: sourcePath, readonly: true });
        const checks = source.pragma('quick_check') as Array<Record<string, unknown>>;
        const valid =
          checks.length > 0 &&
          checks.every((row) => Object.values(row).every((value) => value === 'ok'));
        if (!valid) throw new Error('Backup database failed SQLite quick_check');
        await source.backup(path);
      } finally {
        source?.close();
      }
    },
    diagnostics: () => readDiagnostics(sqlite),
    clearCacheMetadata: () => sqlite.prepare('DELETE FROM cache_metadata').run().changes,
  };
}

function readDiagnostics(sqlite: SqliteConnection): DatabaseDiagnostics {
  const integrityRows = sqlite.pragma('quick_check') as Array<Record<string, unknown>>;
  const integrity =
    integrityRows.length > 0 &&
    integrityRows.every((row) => Object.values(row).every((value) => value === 'ok'))
      ? 'ok'
      : 'error';
  const migration = sqlite
    .prepare(
      `SELECT
         COUNT(*) AS migration_count,
         COALESCE(MAX(version), -1) AS schema_version
       FROM _migrations`,
    )
    .get() as { migration_count: number; schema_version: number };
  const entities = sqlite
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM characters WHERE deleted_at IS NULL) AS characters,
         (SELECT COUNT(*) FROM chats WHERE deleted_at IS NULL) AS chats,
         (SELECT COUNT(*) FROM messages) AS messages,
         (SELECT COUNT(*) FROM personas) AS personas,
         (SELECT COUNT(*) FROM lorebooks WHERE deleted_at IS NULL) AS lorebooks,
         (SELECT COUNT(*) FROM presets) AS presets`,
    )
    .get() as DatabaseDiagnostics['entities'];
  const providers = readEnabledCounts(sqlite, 'provider_configs');
  const plugins = readEnabledCounts(sqlite, 'plugin_registry');
  const themes = readEnabledCounts(sqlite, 'theme_registry');

  return {
    integrity,
    schemaVersion: migration.schema_version,
    migrationCount: migration.migration_count,
    entities,
    providers: { configured: providers.total, enabled: providers.enabled },
    plugins: { installed: plugins.total, enabled: plugins.enabled },
    themes: { installed: themes.total, enabled: themes.enabled },
  };
}

function readEnabledCounts(
  sqlite: SqliteConnection,
  table: 'provider_configs' | 'plugin_registry' | 'theme_registry',
): { total: number; enabled: number } {
  return sqlite
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), 0) AS enabled
       FROM ${table}`,
    )
    .get() as { total: number; enabled: number };
}
