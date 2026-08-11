/**
 * Search and usage-sorting schema (ТЗ §12).
 *
 * - Adds the missing FTS5 index over lorebooks (name/description) with
 *   transactional sync triggers, so books themselves are searchable — not only
 *   their entries via `lore_entries_fts`.
 * - Adds `characters.last_used_at` for sorting the catalog by usage.
 *
 * Purely additive: no table is rewritten, existing rows keep working
 * (`last_used_at` is nullable and treated as "never used" when sorting).
 */
import type { Migration } from './types.js';

const up = /* sql */ `
ALTER TABLE characters ADD COLUMN last_used_at INTEGER;
CREATE INDEX IF NOT EXISTS characters_last_used_idx ON characters(last_used_at);

CREATE VIRTUAL TABLE IF NOT EXISTS lorebooks_fts USING fts5(
  lorebook_id UNINDEXED,
  name,
  description,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS lorebooks_ai AFTER INSERT ON lorebooks BEGIN
  INSERT INTO lorebooks_fts(lorebook_id, name, description)
  VALUES (new.id, new.name, new.description);
END;
CREATE TRIGGER IF NOT EXISTS lorebooks_ad AFTER DELETE ON lorebooks BEGIN
  DELETE FROM lorebooks_fts WHERE lorebook_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS lorebooks_au AFTER UPDATE ON lorebooks BEGIN
  DELETE FROM lorebooks_fts WHERE lorebook_id = old.id;
  INSERT INTO lorebooks_fts(lorebook_id, name, description)
  VALUES (new.id, new.name, new.description);
END;

-- Backfill existing books into the new index (idempotent: table is empty
-- before the first trigger fires, and triggers only run on new writes).
INSERT INTO lorebooks_fts(lorebook_id, name, description)
  SELECT id, name, description FROM lorebooks;
`;

export const migration: Migration = {
  version: 5,
  name: '0005_search_fts_and_usage',
  up,
};
