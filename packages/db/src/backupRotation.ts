/**
 * Backup retention (ТЗ §10.4 «хранится несколько последних автоматических
 * backup»). Automatic backups are prefixed by kind; rotation keeps the newest
 * `keep` files of a prefix and removes the rest. Synchronous on purpose: it
 * runs during migrations and restore safety copies, where we do not want to
 * interleave other work.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Keep only the newest `keep` `*.db` files starting with `prefix` in `dir`.
 * Returns the absolute paths that were removed. Missing directory → no-op.
 */
export function rotatePrefixedBackups(dir: string, prefix: string, keep: number): string[] {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error('rotatePrefixedBackups: keep must be a positive integer');
  }
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const matching = files
    .filter((file) => file.startsWith(prefix) && file.endsWith('.db'))
    .map((file) => {
      const fullPath = join(dir, file);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(fullPath).mtimeMs;
      } catch {
        return null;
      }
      return { fullPath, mtimeMs };
    })
    .filter((entry): entry is { fullPath: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const removed: string[] = [];
  for (const entry of matching.slice(keep)) {
    try {
      rmSync(entry.fullPath);
      removed.push(entry.fullPath);
    } catch {
      // A rotation failure must never break the operation that triggered it.
    }
  }
  return removed;
}
