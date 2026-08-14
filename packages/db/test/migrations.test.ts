import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migration as initialMigration } from '../src/migrations/0000_init.js';
import { migrations } from '../src/migrations/index.js';
import { PRE_MIGRATION_BACKUP_PREFIX, runMigrations } from '../src/migrate.js';
import { createLogger, isAppError } from '@neotavern/shared';
import { createConnection, makeDir } from './helpers.js';

const logger = createLogger({ level: 'error', scope: 'migration-test' });

describe('database migrations', () => {
  it('upgrades a populated version-0 database without losing data', () => {
    const sqlite = createConnection({ path: ':memory:' });
    sqlite.exec(`
      CREATE TABLE _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT;
    `);
    sqlite.exec(initialMigration.up);
    sqlite
      .prepare('INSERT INTO _migrations(version, name, applied_at) VALUES (?, ?, ?)')
      .run(0, initialMigration.name, Date.now());
    sqlite
      .prepare(
        `INSERT INTO characters (
          id, name, description, personality, scenario, first_message,
          example_dialogues, ext, created_at, updated_at
        ) VALUES (?, ?, '', '', '', '', '', '{}', ?, ?)`,
      )
      .run('018f0000-0000-7000-8000-000000000001', 'Existing character', 1, 1);

    const result = runMigrations(sqlite, logger);
    expect(result.applied).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
    ]);
    expect(result.currentVersion).toBe(24);
    expect(
      sqlite
        .prepare('SELECT name FROM characters WHERE id = ?')
        .get('018f0000-0000-7000-8000-000000000001'),
    ).toEqual({ name: 'Existing character' });

    const requiredTables = [
      'character_versions',
      'attachments',
      'lorebooks',
      'lore_entries',
      'presets',
      'cache_metadata',
      'import_jobs',
      'import_artifacts',
      'prompt_context_audits',
      'provider_secrets',
      'connection_profiles',
      'message_drafts',
      'message_block_attachments',
      'message_content_revisions',
    ];
    const rows = sqlite
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (${requiredTables.map(() => '?').join(', ')})`,
      )
      .all(...requiredTables) as Array<{ name: string }>;
    expect(new Set(rows.map((row) => row.name))).toEqual(new Set(requiredTables));

    expect(
      sqlite
        .prepare(
          "SELECT name FROM pragma_table_info('messages') WHERE name = 'content_revision_count'",
        )
        .get(),
    ).toEqual({ name: 'content_revision_count' });

    const insertJob = sqlite.prepare(
      `INSERT INTO import_jobs (
         id, source_hash, source_name, source_kind, status, summary,
         error_code, started_at, completed_at
       ) VALUES (?, ?, 'archive.zip', 'sillytavern-data-zip', 'completed', '{}', NULL, ?, ?)`,
    );
    insertJob.run('018f0000-0000-7000-8000-000000000101', 'e'.repeat(64), 2, 3);
    insertJob.run('018f0000-0000-7000-8000-000000000102', 'e'.repeat(64), 4, 5);
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS count FROM import_jobs WHERE source_hash = ?')
        .get('e'.repeat(64)),
    ).toEqual({ count: 2 });

    expect(runMigrations(sqlite, logger).applied).toEqual([]);
    expect(
      sqlite
        .prepare(
          "SELECT name FROM pragma_table_info('plugin_registry') WHERE name = 'granted_permissions'",
        )
        .all(),
    ).toEqual([{ name: 'granted_permissions' }]);
    // 0015: install source + resolved npm dependency list columns are additive.
    expect(
      sqlite
        .prepare(
          "SELECT name FROM pragma_table_info('plugin_registry') WHERE name IN ('source', 'dependencies') ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: 'dependencies' }, { name: 'source' }]);
  });

  it('backfills character tags into characters_fts and keeps them in sync', () => {
    const sqlite = createConnection({ path: ':memory:' });
    sqlite.exec(`
      CREATE TABLE _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT;
    `);
    sqlite.exec(initialMigration.up);
    sqlite
      .prepare('INSERT INTO _migrations(version, name, applied_at) VALUES (?, ?, ?)')
      .run(0, initialMigration.name, Date.now());
    const charId = '018f0000-0000-7000-8000-000000000001';
    const tagId = '018f0000-0000-7000-8000-000000000002';
    sqlite
      .prepare(
        `INSERT INTO characters (
          id, name, description, personality, scenario, first_message,
          example_dialogues, ext, created_at, updated_at
        ) VALUES (?, ?, '', '', '', '', '', '{}', ?, ?)`,
      )
      .run(charId, 'Tagged character', 1, 1);
    sqlite.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(tagId, 'sfw');
    sqlite
      .prepare('INSERT INTO character_tags (character_id, tag_id) VALUES (?, ?)')
      .run(charId, tagId);

    runMigrations(sqlite, logger);

    const row = sqlite
      .prepare('SELECT tags FROM characters_fts WHERE character_id = ?')
      .get(charId) as { tags: string };
    expect(row.tags).toBe('sfw');

    // Free text finds the character by tag name after the upgrade.
    const byTag = sqlite
      .prepare("SELECT character_id FROM characters_fts WHERE characters_fts MATCH 'sfw'")
      .all() as Array<{ character_id: string }>;
    expect(byTag.map((r) => r.character_id)).toEqual([charId]);

    // Triggers re-index on tag link changes.
    const otherTagId = '018f0000-0000-7000-8000-000000000003';
    sqlite.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(otherTagId, 'knight');
    sqlite
      .prepare('INSERT INTO character_tags (character_id, tag_id) VALUES (?, ?)')
      .run(charId, otherTagId);
    const afterAdd = sqlite
      .prepare('SELECT tags FROM characters_fts WHERE character_id = ?')
      .get(charId) as { tags: string };
    expect(afterAdd.tags).toBe('sfw knight');

    sqlite.prepare('DELETE FROM character_tags WHERE tag_id = ?').run(tagId);
    const afterDelete = sqlite
      .prepare('SELECT tags FROM characters_fts WHERE character_id = ?')
      .get(charId) as { tags: string };
    expect(afterDelete.tags).toBe('knight');
  });

  it('backfills favorite/chat_count/token_count and keeps them in sync (0012)', () => {
    const sqlite = createConnection({ path: ':memory:' });
    sqlite.exec(`
      CREATE TABLE _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT;
    `);
    sqlite.exec(initialMigration.up);
    sqlite
      .prepare('INSERT INTO _migrations(version, name, applied_at) VALUES (?, ?, ?)')
      .run(0, initialMigration.name, Date.now());

    const favChar = '018f0000-0000-7000-8000-000000000001';
    const legacyFavChar = '018f0000-0000-7000-8000-000000000002';
    const plainChar = '018f0000-0000-7000-8000-000000000003';
    const noChatChar = '018f0000-0000-7000-8000-000000000004';
    const chatId = '018f0000-0000-7000-8000-000000000010';
    const branchId = '018f0000-0000-7000-8000-000000000011';
    const deletedChatId = '018f0000-0000-7000-8000-000000000012';
    const deletedBranchId = '018f0000-0000-7000-8000-000000000013';

    const insertChar = sqlite.prepare(
      `INSERT INTO characters (
         id, name, description, personality, scenario, first_message,
         example_dialogues, ext, created_at, updated_at
       ) VALUES (?, ?, '', '', '', '', '', ?, ?, ?)`,
    );
    insertChar.run(favChar, 'Fav', '{"favorite":true}', 1, 1);
    insertChar.run(legacyFavChar, 'Legacy Fav', '{"legacy":{"favorite":true}}', 2, 2);
    insertChar.run(plainChar, 'Plain', '{}', 3, 3);
    insertChar.run(noChatChar, 'NoChats', '{}', 4, 4);

    // A non-deleted chat with two messages + a soft-deleted chat whose bytes
    // must NOT count toward token_count.
    sqlite
      .prepare(
        `INSERT INTO chats (
           id, character_id, persona_id, title, active_branch_id, summary,
           message_count, created_at, updated_at, deleted_at
         ) VALUES (?, ?, NULL, 't', ?, '', 2, 1, 1, NULL)`,
      )
      .run(chatId, plainChar, branchId);
    sqlite
      .prepare('INSERT INTO chat_branches (id, chat_id, name, created_at) VALUES (?, ?, ?, ?)')
      .run(branchId, chatId, 'main', 1);
    sqlite
      .prepare(
        `INSERT INTO chats (
           id, character_id, persona_id, title, active_branch_id, summary,
           message_count, created_at, updated_at, deleted_at
         ) VALUES (?, ?, NULL, 'gone', ?, '', 1, 1, 1, 999)`,
      )
      .run(deletedChatId, plainChar, deletedBranchId);
    sqlite
      .prepare('INSERT INTO chat_branches (id, chat_id, name, created_at) VALUES (?, ?, ?, ?)')
      .run(deletedBranchId, deletedChatId, 'main', 1);

    const insertMessage = sqlite.prepare(
      `INSERT INTO messages (
         id, chat_id, branch_id, parent_id, role, content, name, meta, created_at
       ) VALUES (?, ?, ?, NULL, 'user', ?, NULL, '{}', ?)`,
    );
    insertMessage.run('m1', chatId, branchId, 'hello', 1); // 5
    insertMessage.run('m2', chatId, branchId, 'world!!', 2); // 7 → 12 total
    insertMessage.run('m3', deletedChatId, deletedBranchId, 'should-not-count', 1);

    // Apply all pending migrations (1..12), including 0012.
    runMigrations(sqlite, logger);

    const countsFor = (id: string) =>
      sqlite
        .prepare('SELECT favorite, chat_count, token_count FROM characters WHERE id = ?')
        .get(id) as { favorite: number; chat_count: number; token_count: number };

    expect(countsFor(favChar)).toMatchObject({ favorite: 1, chat_count: 0, token_count: 0 });
    expect(countsFor(legacyFavChar)).toMatchObject({ favorite: 1, chat_count: 0, token_count: 0 });
    expect(countsFor(plainChar)).toMatchObject({ favorite: 0, chat_count: 1, token_count: 12 });
    expect(countsFor(noChatChar)).toMatchObject({ favorite: 0, chat_count: 0, token_count: 0 });

    // Trigger: a new chat bumps chat_count, and a new message bumps token_count.
    const newChat = '018f0000-0000-7000-8000-000000000020';
    const newBranch = '018f0000-0000-7000-8000-000000000021';
    sqlite
      .prepare(
        `INSERT INTO chats (
           id, character_id, persona_id, title, active_branch_id, summary,
           message_count, created_at, updated_at, deleted_at
         ) VALUES (?, ?, NULL, 't', ?, '', 0, 5, 5, NULL)`,
      )
      .run(newChat, plainChar, newBranch);
    sqlite
      .prepare('INSERT INTO chat_branches (id, chat_id, name, created_at) VALUES (?, ?, ?, ?)')
      .run(newBranch, newChat, 'main', 5);
    insertMessage.run('m4', newChat, newBranch, 'abc', 5); // 3
    expect(countsFor(plainChar)).toMatchObject({ chat_count: 2, token_count: 15 });

    // Trigger: soft-deleting the chat drops chat_count and its message bytes.
    sqlite.prepare('UPDATE chats SET deleted_at = 7 WHERE id = ?').run(newChat);
    expect(countsFor(plainChar)).toMatchObject({ chat_count: 1, token_count: 12 });

    // Trigger: restoring the chat adds both back.
    sqlite.prepare('UPDATE chats SET deleted_at = NULL WHERE id = ?').run(newChat);
    expect(countsFor(plainChar)).toMatchObject({ chat_count: 2, token_count: 15 });

    // Trigger: hard-deleting the chat drops it again (chat_count and bytes).
    sqlite.prepare('DELETE FROM chats WHERE id = ?').run(newChat);
    expect(countsFor(plainChar)).toMatchObject({ chat_count: 1, token_count: 12 });

    // Trigger: editing a message adjusts token_count by the delta.
    insertMessage.run('m5', chatId, branchId, 'replace', 6); // +7 → 19
    sqlite.prepare('UPDATE messages SET content = ? WHERE id = ?').run('short', 'm5'); // 7 → 5, -2
    expect(countsFor(plainChar).token_count).toBe(17);
  });

  it('moves a legacy provider api_key into an active provider_secrets row', () => {
    const sqlite = createConnection({ path: ':memory:' });
    sqlite.exec(`
      CREATE TABLE _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT;
    `);
    sqlite.exec(initialMigration.up);
    sqlite
      .prepare('INSERT INTO _migrations(version, name, applied_at) VALUES (?, ?, ?)')
      .run(0, initialMigration.name, Date.now());
    sqlite
      .prepare(
        `INSERT INTO provider_configs (
          id, kind, name, base_url, model, api_key, enabled, settings, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, NULL, ?, 1, '{}', ?, ?)`,
      )
      .run(
        '018f0000-0000-7000-8000-000000000abc',
        'openai-compatible',
        'Legacy',
        'sk-legacy-key',
        1,
        1,
      );
    sqlite
      .prepare(
        `INSERT INTO provider_configs (
          id, kind, name, base_url, model, api_key, enabled, settings, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, NULL, NULL, 1, '{}', ?, ?)`,
      )
      .run('018f0000-0000-7000-8000-000000000def', 'openai-compatible', 'Keyless', 1, 1);

    runMigrations(sqlite, logger);

    // The key is preserved as the provider's single active, labelled secret.
    const secrets = sqlite
      .prepare(
        `SELECT provider_id, label, value, active FROM provider_secrets ORDER BY provider_id`,
      )
      .all() as Array<{ provider_id: string; label: string; value: string; active: number }>;
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toMatchObject({
      provider_id: '018f0000-0000-7000-8000-000000000abc',
      label: 'migrated',
      value: 'sk-legacy-key',
      active: 1,
    });

    // The legacy column is nulled so runtime reads come from provider_secrets.
    expect(sqlite.prepare('SELECT api_key FROM provider_configs ORDER BY id').all()).toEqual([
      { api_key: null },
      { api_key: null },
    ]);
  });

  it('backfills swipe positions and variant counters (0020)', () => {
    const sqlite = createConnection({ path: ':memory:' });
    sqlite.exec(`
      CREATE TABLE _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT;
    `);
    sqlite.exec(initialMigration.up);
    sqlite
      .prepare('INSERT INTO _migrations(version, name, applied_at) VALUES (?, ?, ?)')
      .run(0, initialMigration.name, Date.now());

    const chatId = '018f0000-0000-7000-8000-000000000010';
    const branchId = '018f0000-0000-7000-8000-000000000011';
    const withVariants = '018f0000-0000-7000-8000-000000000020';
    const withoutVariants = '018f0000-0000-7000-8000-000000000021';
    const v1 = '018f0000-0000-7000-8000-000000000030';
    const v2 = '018f0000-0000-7000-8000-000000000031';

    // Migrate up to 19, then seed pre-0020 data (no position/variant columns
    // yet) with the variants ordered by distinct created_at.
    runMigrations(sqlite, logger, migrations.slice(0, 20));
    sqlite
      .prepare(
        `INSERT INTO chats (id, title, active_branch_id, created_at, updated_at)
         VALUES (?, 'seeded', ?, 1, 1)`,
      )
      .run(chatId, branchId);
    sqlite
      .prepare('INSERT INTO chat_branches (id, chat_id, name, created_at) VALUES (?, ?, ?, ?)')
      .run(branchId, chatId, 'main', 1);
    const insertMessage = sqlite.prepare(
      `INSERT INTO messages (
         id, chat_id, branch_id, parent_id, role, content, name, meta, created_at
       ) VALUES (?, ?, ?, NULL, 'assistant', ?, NULL, '{}', ?)`,
    );
    insertMessage.run(withVariants, chatId, branchId, 'current text', 10);
    insertMessage.run(withoutVariants, chatId, branchId, 'single take', 20);
    const insertVariant = sqlite.prepare(
      'INSERT INTO message_variants (id, message_id, content, created_at) VALUES (?, ?, ?, ?)',
    );
    insertVariant.run(v1, withVariants, 'first take', 100);
    insertVariant.run(v2, withVariants, 'second take', 200);

    expect(runMigrations(sqlite, logger, migrations.slice(0, 21)).applied).toEqual([20]);

    // The backfill assigns deterministic positions by (created_at, id).
    const positions = sqlite
      .prepare('SELECT id, position FROM message_variants WHERE message_id = ? ORDER BY position')
      .all(withVariants) as Array<{ id: string; position: number }>;
    expect(positions).toEqual([
      { id: v1, position: 0 },
      { id: v2, position: 1 },
    ]);

    // variant_count = 1 + stored variants; active_variant_position = count.
    const counters = sqlite
      .prepare(
        'SELECT variant_count, active_variant_position FROM messages WHERE id IN (?, ?) ORDER BY id',
      )
      .all(withVariants, withoutVariants) as Array<{
      variant_count: number;
      active_variant_position: number;
    }>;
    expect(counters).toEqual([
      { variant_count: 3, active_variant_position: 2 },
      { variant_count: 1, active_variant_position: 0 },
    ]);

    // The new columns exist and the unique (message_id, position) index enforces swaps.
    for (const [table, columns] of [
      ['messages', ['variant_count', 'active_variant_position', 'checkpoint_chat_id']],
      ['message_variants', ['position']],
      ['chats', ['parent_chat_id', 'origin', 'source_message_id']],
    ] as const) {
      const found = sqlite
        .prepare(
          `SELECT name FROM pragma_table_info('${table}') WHERE name IN (${columns.map(() => '?').join(', ')})`,
        )
        .all(...columns) as Array<{ name: string }>;
      expect(new Set(found.map((row) => row.name))).toEqual(new Set(columns));
    }
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_message_variants_position'",
        )
        .get(),
    ).toBeTruthy();
    // The unique (message_id, position) index rejects duplicate positions.
    expect(() =>
      sqlite
        .prepare(
          'INSERT INTO message_variants (id, message_id, position, content, created_at) VALUES (?, ?, 0, ?, ?)',
        )
        .run('018f0000-0000-7000-8000-000000000032', withVariants, 'dup', 300),
    ).toThrow(/UNIQUE/i);
  });

  it('rolls back a failed migration completely', () => {
    const sqlite = createConnection({ path: ':memory:' });
    const broken = [
      {
        version: 99,
        name: '0099_broken',
        up: 'CREATE TABLE should_rollback (id TEXT); INVALID SQL;',
      },
    ] as const;

    let error: unknown;
    try {
      runMigrations(sqlite, logger, broken);
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) expect(error.code).toBe('MIGRATION_FAILED');
    expect(
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('should_rollback'),
    ).toBeUndefined();
    expect(
      sqlite.prepare('SELECT version FROM _migrations WHERE version = 99').get(),
    ).toBeUndefined();
  });

  it('creates a pre-migration backup only when migrations are pending', () => {
    const sqlite = createConnection({ path: ':memory:' });
    const backupDir = makeDir('neotavern-migration-backup-');
    const migration = {
      version: 10,
      name: '0010_backup_probe',
      up: 'CREATE TABLE backup_probe (id TEXT PRIMARY KEY) STRICT;',
    };

    runMigrations(sqlite, logger, [migration], {
      autoBackup: { backupDir, keep: 3 },
    });
    const afterMigration = readdirSync(backupDir).filter((file) =>
      file.startsWith(PRE_MIGRATION_BACKUP_PREFIX),
    );
    expect(afterMigration).toHaveLength(1);

    runMigrations(sqlite, logger, [migration], {
      autoBackup: { backupDir, keep: 3 },
    });
    expect(
      readdirSync(backupDir).filter((file) => file.startsWith(PRE_MIGRATION_BACKUP_PREFIX)),
    ).toEqual(afterMigration);
  });

  it('retains only the configured number of pre-migration backups', () => {
    const sqlite = createConnection({ path: ':memory:' });
    const backupDir = makeDir('neotavern-migration-rotation-');

    for (const version of [20, 21, 22]) {
      runMigrations(
        sqlite,
        logger,
        [
          {
            version,
            name: `00${version}_rotation_probe`,
            up: `CREATE TABLE rotation_probe_${version} (id TEXT PRIMARY KEY) STRICT;`,
          },
        ],
        { autoBackup: { backupDir, keep: 2 } },
      );
    }

    const backups = readdirSync(backupDir)
      .filter((file) => file.startsWith(PRE_MIGRATION_BACKUP_PREFIX))
      .sort();
    expect(backups).toHaveLength(2);
    expect(backups.some((file) => file.includes('to-v20-'))).toBe(false);
    expect(backups.some((file) => file.includes('to-v21-'))).toBe(true);
    expect(backups.some((file) => file.includes('to-v22-'))).toBe(true);
  });
});
