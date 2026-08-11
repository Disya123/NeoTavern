/** Shared filesystem-scan helpers for theme/style contract tests (DUP-26). */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Repository root (these helpers live in packages/theme-sdk/test). */
export const repoRoot = resolve(import.meta.dirname, '../../..');

/** Source trees covered by the styling contracts. */
export const SCAN_DIRS = [resolve(repoRoot, 'apps/web/src'), resolve(repoRoot, 'packages/ui/src')];

/** Recursively collect files under `dir` whose name satisfies `accept`. */
export function collectSourceFiles(dir: string, accept: (fileName: string) => boolean): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path, accept));
    } else if (entry.isFile() && accept(entry.name)) {
      files.push(path);
    }
  }
  return files;
}
