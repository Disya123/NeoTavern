/**
 * Connection profiles — named bundles of connection settings layered over
 * provider configs (the classic SillyTavern "Connection Profiles" manager).
 *
 * `name` and `mode` are columns for listing/filtering; every other field lives
 * in the versioned `payload` JSON so unknown fields survive round-trips
 * (AGENTS.md §11). Pure additive table; no data backfill. The runner snapshots
 * the database before applying (ТЗ §10.4).
 */
import type { Migration } from './types.js';

const up = /* sql */ `
CREATE TABLE IF NOT EXISTS connection_profiles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  mode        TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS connection_profiles_name_idx
  ON connection_profiles(name);
`;

export const migration: Migration = {
  version: 10,
  name: '0010_connection_profiles',
  up,
};
