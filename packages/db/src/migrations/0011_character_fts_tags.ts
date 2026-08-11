/**
 * Make character tags full-text searchable.
 *
 * Recreates `characters_fts` with a `tags` column (space-joined tag names)
 * so free text like `knight` or `NSFW` finds characters by tag, not only by
 * name/description/personality/scenario. FTS5 cannot `ALTER TABLE ADD
 * COLUMN` ("virtual tables may not be altered"), so the index is rebuilt
 * from the base tables — it is derived data, and the runner's transaction
 * makes the swap atomic.
 *
 * The column is kept in sync by:
 *
 * - recreated `characters_ai` / `characters_au` triggers that compute the
 *   current tag list (the character row itself never changes tags);
 * - new `character_tags_ai` / `character_tags_ad` triggers that re-index the
 *   affected character whenever its tag links change.
 *
 * The `tags` column is plain text in FTS5 (not UNINDEXED), so tag names
 * participate in bm25 ranking and prefix/phrase matching. SQL `tag:` filters
 * in the character repository are unaffected — they stay `LIKE` prefix
 * lookups (`COLLATE NOCASE`) against the `tags` table.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
DROP TRIGGER IF EXISTS characters_ai;
DROP TRIGGER IF EXISTS characters_au;
DROP TABLE IF EXISTS characters_fts;

CREATE VIRTUAL TABLE characters_fts USING fts5(
  character_id UNINDEXED,
  name,
  description,
  personality,
  scenario,
  tags,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO characters_fts(character_id, name, description, personality, scenario, tags)
SELECT c.id, c.name, c.description, c.personality, c.scenario,
       COALESCE((SELECT group_concat(t.name, ' ') FROM character_tags ct
                 JOIN tags t ON t.id = ct.tag_id WHERE ct.character_id = c.id), '')
FROM characters c;

CREATE TRIGGER characters_ai AFTER INSERT ON characters BEGIN
  INSERT INTO characters_fts(character_id, name, description, personality, scenario, tags)
  SELECT new.id, new.name, new.description, new.personality, new.scenario,
    COALESCE((SELECT group_concat(t.name, ' ') FROM character_tags ct
              JOIN tags t ON t.id = ct.tag_id WHERE ct.character_id = new.id), '');
END;

CREATE TRIGGER characters_au AFTER UPDATE ON characters BEGIN
  DELETE FROM characters_fts WHERE character_id = old.id;
  INSERT INTO characters_fts(character_id, name, description, personality, scenario, tags)
  SELECT new.id, new.name, new.description, new.personality, new.scenario,
    COALESCE((SELECT group_concat(t.name, ' ') FROM character_tags ct
              JOIN tags t ON t.id = ct.tag_id WHERE ct.character_id = new.id), '');
END;

CREATE TRIGGER IF NOT EXISTS character_tags_ai AFTER INSERT ON character_tags BEGIN
  UPDATE characters_fts SET tags = (
    SELECT group_concat(t.name, ' ')
    FROM character_tags ct
    JOIN tags t ON t.id = ct.tag_id
    WHERE ct.character_id = new.character_id
  ) WHERE character_id = new.character_id;
END;

CREATE TRIGGER IF NOT EXISTS character_tags_ad AFTER DELETE ON character_tags BEGIN
  UPDATE characters_fts SET tags = (
    SELECT group_concat(t.name, ' ')
    FROM character_tags ct
    JOIN tags t ON t.id = ct.tag_id
    WHERE ct.character_id = old.character_id
  ) WHERE character_id = old.character_id;
END;
`;

export const migration: Migration = {
  version: 11,
  name: '0011_character_fts_tags',
  up,
};
