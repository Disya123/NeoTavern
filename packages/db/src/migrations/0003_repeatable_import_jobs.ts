/**
 * Allow an archive to be intentionally executed more than once.
 *
 * Exact-archive lookup remains indexed and the compatibility one-step route
 * still reuses the latest completed result. The two-phase route may now apply
 * a different category selection or conflict policy to the same archive.
 * Existing rows and summaries are not rewritten.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
DROP INDEX IF EXISTS import_jobs_completed_source_idx;
CREATE INDEX IF NOT EXISTS import_jobs_completed_source_idx
  ON import_jobs(source_hash, completed_at DESC)
  WHERE status = 'completed';
`;

export const migration: Migration = {
  version: 3,
  name: '0003_repeatable_import_jobs',
  up,
};
