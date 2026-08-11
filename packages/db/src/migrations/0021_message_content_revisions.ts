/**
 * Immutable manual content history for chat messages.
 *
 * content_revision_count is the next chronological position for the active
 * text. Previous texts live in a STRICT child table and are removed only when
 * their owning message is deleted. The migration runner creates a backup
 * before applying this additive migration to a populated database.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
ALTER TABLE messages ADD COLUMN content_revision_count INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS message_content_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position >= 0),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_message_content_revisions_message
  ON message_content_revisions(message_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_content_revisions_position
  ON message_content_revisions(message_id, position);
`;

export const migration: Migration = {
  version: 21,
  name: '0021_message_content_revisions',
  up,
};
