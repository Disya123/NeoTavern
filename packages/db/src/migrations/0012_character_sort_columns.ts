/**
 * Catalog sort columns for the character browser.
 *
 * Adds three derived counter columns to `characters` so the catalog can be
 * sorted by favorites, chat count and message volume without scanning the
 * whole `chats` / `messages` tables on every list request. The columns are
 * maintained by SQL triggers (the same pattern FTS sync uses) so every write
 * path — repos, legacy imports, future code — keeps them consistent.
 *
 * - `favorite` mirrors `ext.favorite` / `ext.legacy.favorite`. `ext` stays the
 *   source of truth (the API contract is unchanged); the column only makes
 *   "favorites first" ordering indexable.
 * - `chat_count` is the number of non-deleted chats for the character. Trash
 *   is excluded (consistent with search).
 * - `token_count` is the total length (in characters) of message content across
 *   non-deleted chats of the character. There is no persisted real token usage,
 *   so this is a volume proxy; the docs call that out. Trash is excluded.
 *
 * The chat triggers also adjust `token_count` on soft/hard delete and restore:
 * a chat owns a block of message bytes, so removing/restoring the chat must
 * move that whole block in one step (message triggers ignore deleted chats to
 * avoid double counting). The hard-delete trigger runs `BEFORE DELETE` so the
 * chat's message rows are still readable — `ON DELETE CASCADE` removes them
 * before an `AFTER DELETE` trigger would see them. Per-message deltas while
 * the chat is alive are handled by the message triggers.
 *
 * The migration is additive (`ALTER TABLE ADD COLUMN` + `CREATE INDEX/TRIGGER`
 * with `IF NOT EXISTS`) and idempotent-safe; rollback is restoring the
 * pre-migration backup the runner creates for a populated database.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
ALTER TABLE characters ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN chat_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN token_count INTEGER NOT NULL DEFAULT 0;

UPDATE characters
SET favorite = 1
WHERE json_extract(ext, '$.favorite') = 1
   OR json_extract(ext, '$.legacy.favorite') = 1;

UPDATE characters
SET chat_count = COALESCE((
  SELECT COUNT(*) FROM chats
  WHERE character_id = characters.id AND deleted_at IS NULL
), 0);

UPDATE characters
SET token_count = COALESCE((
  SELECT SUM(length(m.content))
  FROM messages m
  JOIN chats c ON c.id = m.chat_id
  WHERE c.character_id = characters.id AND c.deleted_at IS NULL
), 0);

CREATE INDEX IF NOT EXISTS characters_favorite_idx
  ON characters(favorite DESC, name ASC, id ASC);
CREATE INDEX IF NOT EXISTS characters_chat_count_idx
  ON characters(chat_count DESC, name ASC, id ASC);
CREATE INDEX IF NOT EXISTS characters_token_count_idx
  ON characters(token_count DESC, name ASC, id ASC);

CREATE TRIGGER IF NOT EXISTS characters_chat_count_ai AFTER INSERT ON chats BEGIN
  UPDATE characters
  SET chat_count = chat_count + 1
  WHERE id = NEW.character_id
    AND NEW.character_id IS NOT NULL
    AND NEW.deleted_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS characters_chat_count_ad BEFORE DELETE ON chats BEGIN
  UPDATE characters
  SET chat_count = MAX(chat_count - 1, 0),
      token_count = MAX(token_count - (
        SELECT COALESCE(SUM(length(content)), 0) FROM messages WHERE chat_id = OLD.id
      ), 0)
  WHERE id = OLD.character_id
    AND OLD.character_id IS NOT NULL
    AND OLD.deleted_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS characters_chat_count_au
AFTER UPDATE OF character_id, deleted_at ON chats
BEGIN
  UPDATE characters
  SET chat_count = MAX(chat_count - 1, 0),
      token_count = MAX(token_count - (
        SELECT COALESCE(SUM(length(content)), 0) FROM messages WHERE chat_id = OLD.id
      ), 0)
  WHERE id = OLD.character_id
    AND OLD.character_id IS NOT NULL
    AND OLD.deleted_at IS NULL;
  UPDATE characters
  SET chat_count = chat_count + 1,
      token_count = token_count + (
        SELECT COALESCE(SUM(length(content)), 0) FROM messages WHERE chat_id = NEW.id
      )
  WHERE id = NEW.character_id
    AND NEW.character_id IS NOT NULL
    AND NEW.deleted_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS characters_token_count_ai AFTER INSERT ON messages BEGIN
  UPDATE characters
  SET token_count = token_count + length(NEW.content)
  WHERE id = (
    SELECT character_id FROM chats
    WHERE id = NEW.chat_id AND deleted_at IS NULL AND character_id IS NOT NULL
  );
END;

CREATE TRIGGER IF NOT EXISTS characters_token_count_ad AFTER DELETE ON messages BEGIN
  UPDATE characters
  SET token_count = MAX(token_count - length(OLD.content), 0)
  WHERE id = (
    SELECT character_id FROM chats
    WHERE id = OLD.chat_id AND deleted_at IS NULL AND character_id IS NOT NULL
  );
END;

CREATE TRIGGER IF NOT EXISTS characters_token_count_au
AFTER UPDATE OF content ON messages
WHEN length(OLD.content) IS NOT length(NEW.content)
BEGIN
  UPDATE characters
  SET token_count = token_count - length(OLD.content) + length(NEW.content)
  WHERE id = (
    SELECT character_id FROM chats
    WHERE id = NEW.chat_id AND deleted_at IS NULL AND character_id IS NOT NULL
  );
END;
`;

export const migration: Migration = {
  version: 12,
  name: '0012_character_sort_columns',
  up,
};
