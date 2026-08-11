/**
 * Initial schema migration.
 *
 * Creates all core tables (STRICT where possible), FTS5 indexes for
 * characters/chats/messages, and triggers that keep the FTS indexes in sync
 * with their base tables transactionally (ТЗ §10, §12).
 *
 * This migration is idempotent-safe via `IF NOT EXISTS` and is tracked by
 * version in `_migrations`, so it runs exactly once per database.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS profiles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS personas (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  avatar      TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS characters (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  avatar                    TEXT,
  description               TEXT NOT NULL DEFAULT '',
  personality               TEXT NOT NULL DEFAULT '',
  scenario                  TEXT NOT NULL DEFAULT '',
  first_message             TEXT NOT NULL DEFAULT '',
  example_dialogues         TEXT NOT NULL DEFAULT '',
  system_prompt             TEXT,
  post_history_instructions TEXT,
  creator                   TEXT,
  creator_notes             TEXT,
  ext                       TEXT NOT NULL DEFAULT '{}',
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  deleted_at                INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS characters_name_idx ON characters(name);
CREATE INDEX IF NOT EXISTS characters_created_idx ON characters(created_at);

CREATE TABLE IF NOT EXISTS tags (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE IF NOT EXISTS character_tags (
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  tag_id       TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (character_id, tag_id)
) STRICT;

CREATE TABLE IF NOT EXISTS chats (
  id               TEXT PRIMARY KEY,
  character_id     TEXT REFERENCES characters(id) ON DELETE SET NULL,
  persona_id       TEXT REFERENCES personas(id) ON DELETE SET NULL,
  title            TEXT NOT NULL DEFAULT 'New chat',
  active_branch_id TEXT,
  summary          TEXT NOT NULL DEFAULT '',
  message_count    INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS chats_character_idx ON chats(character_id);
CREATE INDEX IF NOT EXISTS chats_updated_idx ON chats(updated_at);

CREATE TABLE IF NOT EXISTS chat_branches (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  name       TEXT NOT NULL DEFAULT 'main',
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS chat_branches_chat_idx ON chat_branches(chat_id);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  branch_id  TEXT NOT NULL REFERENCES chat_branches(id) ON DELETE CASCADE,
  parent_id  TEXT,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  name       TEXT,
  meta       TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS messages_chat_branch_idx ON messages(chat_id, branch_id);
CREATE INDEX IF NOT EXISTS messages_created_idx ON messages(created_at);

CREATE TABLE IF NOT EXISTS message_variants (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS message_variants_msg_idx ON message_variants(message_id);

CREATE TABLE IF NOT EXISTS provider_configs (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  base_url   TEXT,
  model      TEXT,
  api_key    TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  settings   TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS plugin_registry (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  version     TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 0,
  manifest    TEXT NOT NULL DEFAULT '{}',
  permissions TEXT NOT NULL DEFAULT '[]',
  installed_at INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS plugin_settings (
  plugin_id TEXT PRIMARY KEY,
  settings  TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE IF NOT EXISTS plugin_storage (
  plugin_id TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
) STRICT;

CREATE TABLE IF NOT EXISTS theme_registry (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  version      TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 0,
  manifest     TEXT NOT NULL DEFAULT '{}',
  installed_at INTEGER NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- Full-text search (FTS5). Standalone (not external-content) tables keyed by
-- the entity string id; kept in sync via triggers below.
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS characters_fts USING fts5(
  character_id UNINDEXED,
  name,
  description,
  personality,
  scenario,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS chats_fts USING fts5(
  chat_id UNINDEXED,
  title,
  summary,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  message_id UNINDEXED,
  chat_id UNINDEXED,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- characters FTS sync
CREATE TRIGGER IF NOT EXISTS characters_ai AFTER INSERT ON characters BEGIN
  INSERT INTO characters_fts(character_id, name, description, personality, scenario)
  VALUES (new.id, new.name, new.description, new.personality, new.scenario);
END;
CREATE TRIGGER IF NOT EXISTS characters_ad AFTER DELETE ON characters BEGIN
  DELETE FROM characters_fts WHERE character_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS characters_au AFTER UPDATE ON characters BEGIN
  DELETE FROM characters_fts WHERE character_id = old.id;
  INSERT INTO characters_fts(character_id, name, description, personality, scenario)
  VALUES (new.id, new.name, new.description, new.personality, new.scenario);
END;

-- chats FTS sync
CREATE TRIGGER IF NOT EXISTS chats_ai AFTER INSERT ON chats BEGIN
  INSERT INTO chats_fts(chat_id, title, summary) VALUES (new.id, new.title, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS chats_ad AFTER DELETE ON chats BEGIN
  DELETE FROM chats_fts WHERE chat_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS chats_au AFTER UPDATE ON chats BEGIN
  DELETE FROM chats_fts WHERE chat_id = old.id;
  INSERT INTO chats_fts(chat_id, title, summary) VALUES (new.id, new.title, new.summary);
END;

-- messages FTS sync
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(message_id, chat_id, content)
  VALUES (new.id, new.chat_id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts(message_id, chat_id, content)
  VALUES (new.id, new.chat_id, new.content);
END;
`;

export const migration: Migration = {
  version: 0,
  name: '0000_init',
  up,
};
