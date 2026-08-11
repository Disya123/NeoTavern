/**
 * Additive content/import schema.
 *
 * Adds the remaining durable entities required for version history, portable
 * imports, lorebooks, presets and file/cache metadata. No existing table is
 * rewritten, so this migration is safe to apply transactionally without a
 * pre-migration backup.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
CREATE TABLE IF NOT EXISTS character_versions (
  id           TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  snapshot     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (character_id, version)
) STRICT;
CREATE INDEX IF NOT EXISTS character_versions_character_idx
  ON character_versions(character_id, version DESC);

CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,
  owner_type    TEXT NOT NULL,
  owner_id      TEXT NOT NULL,
  logical_name  TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  UNIQUE (owner_type, owner_id, content_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS attachments_owner_idx ON attachments(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS attachments_hash_idx ON attachments(content_hash);

CREATE TABLE IF NOT EXISTS lorebooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  metadata    TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS lorebooks_name_idx ON lorebooks(name);

CREATE TABLE IF NOT EXISTS lore_entries (
  id             TEXT PRIMARY KEY,
  lorebook_id    TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
  keys_json      TEXT NOT NULL DEFAULT '[]',
  secondary_keys TEXT NOT NULL DEFAULT '[]',
  content        TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  position       INTEGER NOT NULL DEFAULT 0,
  constant       INTEGER NOT NULL DEFAULT 0,
  selective      INTEGER NOT NULL DEFAULT 0,
  metadata       TEXT NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS lore_entries_book_position_idx
  ON lore_entries(lorebook_id, position);

CREATE TABLE IF NOT EXISTS presets (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (kind, name)
) STRICT;
CREATE INDEX IF NOT EXISTS presets_kind_idx ON presets(kind);

CREATE TABLE IF NOT EXISTS cache_metadata (
  key               TEXT PRIMARY KEY,
  relative_path     TEXT NOT NULL,
  source_hash       TEXT NOT NULL,
  target_size       INTEGER,
  algorithm_version INTEGER NOT NULL,
  mime              TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  last_accessed_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS cache_metadata_source_idx
  ON cache_metadata(source_hash, algorithm_version);

CREATE TABLE IF NOT EXISTS import_jobs (
  id           TEXT PRIMARY KEY,
  source_hash  TEXT NOT NULL,
  source_name  TEXT NOT NULL,
  source_kind  TEXT NOT NULL,
  status       TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '{}',
  error_code   TEXT,
  started_at   INTEGER NOT NULL,
  completed_at INTEGER
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS import_jobs_completed_source_idx
  ON import_jobs(source_hash)
  WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS import_jobs_started_idx ON import_jobs(started_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS lore_entries_fts USING fts5(
  entry_id UNINDEXED,
  lorebook_id UNINDEXED,
  keys,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS lore_entries_ai AFTER INSERT ON lore_entries BEGIN
  INSERT INTO lore_entries_fts(entry_id, lorebook_id, keys, content)
  VALUES (new.id, new.lorebook_id, new.keys_json, new.content);
END;
CREATE TRIGGER IF NOT EXISTS lore_entries_ad AFTER DELETE ON lore_entries BEGIN
  DELETE FROM lore_entries_fts WHERE entry_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS lore_entries_au AFTER UPDATE ON lore_entries BEGIN
  DELETE FROM lore_entries_fts WHERE entry_id = old.id;
  INSERT INTO lore_entries_fts(entry_id, lorebook_id, keys, content)
  VALUES (new.id, new.lorebook_id, new.keys_json, new.content);
END;
`;

export const migration: Migration = {
  version: 1,
  name: '0001_content_and_imports',
  up,
};
