/**
 * Chat CAS + server-side message drafts (rev4 stage 3).
 *
 * `messages.revision` gives every message a compare-and-swap version:
 * writers passing `expectedRevision` on PATCH get `MESSAGE_CONFLICT` instead
 * of silently clobbering a concurrent edit, and each successful update bumps
 * the revision and records `updated_at`.
 *
 * `messages.idempotency_key` (unique per chat) dedupes retried creates: a
 * create replayed with the same key returns the original message instead of
 * duplicating it — the outbox contract for chat writes.
 *
 * `message_drafts` is the server-side streaming object: plugin/host writers
 * stream into a draft (their flush rate stays an internal policy), and only
 * `commit` materializes a real message atomically. A crashed writer leaves a
 * draft row that the sweep deletes — never a half-written committed message.
 * Committed drafts keep their row (with `committed_message_id`) so a commit
 * retry is idempotent; the sweep removes them afterwards.
 *
 * Additive DDL only; rollback is restoring the pre-migration backup the
 * runner creates for a populated database.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE messages ADD COLUMN updated_at INTEGER;
ALTER TABLE messages ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency
  ON messages(chat_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_drafts (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES chat_branches(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool', 'plugin')),
  content TEXT NOT NULL DEFAULT '',
  name TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  sequence INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  committed_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_message_drafts_chat
  ON message_drafts(chat_id, branch_id);
`;

export const migration: Migration = {
  version: 18,
  name: '0018_chat_cas_and_drafts',
  up,
};
