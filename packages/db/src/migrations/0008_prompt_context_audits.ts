/**
 * Retain the latest full prompt-context audit per chat. Replacing by chat id
 * bounds duplicate prompt storage; the chat foreign key removes it on delete.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
CREATE TABLE IF NOT EXISTS prompt_context_audits (
  chat_id       TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL,
  payload       TEXT NOT NULL,
  created_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS prompt_context_audits_generation_idx
  ON prompt_context_audits(generation_id);
`;

export const migration: Migration = {
  version: 8,
  name: '0008_prompt_context_audits',
  up,
};
