/**
 * Performance and FTS-hygiene fixes.
 *
 * - Covers the generation hot path: every generation loads the recent history
 *   via `WHERE chat_id = ? AND branch_id = ? ORDER BY created_at DESC, id DESC
 *   LIMIT 200`, which previously forced a temp-B-tree sort over the whole
 *   branch on each run.
 * - Adds expression indexes the usage sort (`COALESCE(last_used_at, 0)`) and
 *   idempotent-import lookups (`json_extract(ext, '$._st2.importHash')`) can
 *   actually use — plain column indexes never matched those expressions.
 * - Adds COLLATE NOCASE name indexes for the import conflict lookups.
 * - Restricts `chats_au` to FTS-indexed columns: it previously rewrote
 *   `chats_fts` on every chats UPDATE, including the per-message `touch()`
 *   (the hottest write path) — pure write amplification.
 * - Backfills `memories_fts`: the rebuild path omitted it, so any past
 *   UI-triggered rebuild left it permanently stale.
 *
 * Purely additive except the `chats_au` recreation; all statements are
 * idempotent-safe.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
CREATE INDEX IF NOT EXISTS messages_chat_branch_created_idx
  ON messages(chat_id, branch_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS characters_usage_idx
  ON characters(COALESCE(last_used_at, 0) DESC, id DESC);

CREATE INDEX IF NOT EXISTS characters_import_hash_idx
  ON characters(json_extract(ext, '$._st2.importHash'));

CREATE INDEX IF NOT EXISTS personas_name_nocase_idx ON personas(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS characters_name_nocase_idx ON characters(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS lorebooks_name_nocase_idx ON lorebooks(name COLLATE NOCASE);

DROP TRIGGER IF EXISTS chats_au;
CREATE TRIGGER IF NOT EXISTS chats_au AFTER UPDATE OF title, summary ON chats BEGIN
  DELETE FROM chats_fts WHERE chat_id = old.id;
  INSERT INTO chats_fts(chat_id, title, summary) VALUES (new.id, new.title, new.summary);
END;

DELETE FROM memories_fts;
INSERT INTO memories_fts(memory_id, keys, content)
SELECT id, keys_json, content FROM memories;
`;

export const migration: Migration = {
  version: 7,
  name: '0007_perf_indexes_and_fts_fixes',
  up,
};
