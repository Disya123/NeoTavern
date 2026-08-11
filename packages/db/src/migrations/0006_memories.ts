/**
 * Memory/RAG store (ТЗ §4.4 Memory/RAG pipeline stage).
 *
 * Memories are long-lived knowledge fragments injected into the prompt:
 * global (persona facts, world notes) or scoped to a character. Retrieval is
 * keyword-driven with an FTS5 content index for broader matching; embeddings
 * remain an optional plugin concern (ТЗ §12).
 *
 * Purely additive.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
CREATE TABLE IF NOT EXISTS memories (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL DEFAULT 'global',
  character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  keys_json    TEXT NOT NULL DEFAULT '[]',
  content      TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  position     INTEGER NOT NULL DEFAULT 0,
  metadata     TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS memories_scope_idx ON memories(scope, character_id);
CREATE INDEX IF NOT EXISTS memories_position_idx ON memories(position);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED,
  keys,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(memory_id, keys, content)
  VALUES (new.id, new.keys_json, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
  INSERT INTO memories_fts(memory_id, keys, content)
  VALUES (new.id, new.keys_json, new.content);
END;
`;

export const migration: Migration = {
  version: 6,
  name: '0006_memories',
  up,
};
