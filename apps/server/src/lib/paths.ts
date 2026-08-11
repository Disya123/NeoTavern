/**
 * Data directory layout (ТЗ §10.3). Originals live under files/, regenerable
 * data under cache/. Creating directories is idempotent.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface DataPaths {
  root: string;
  dbFile: string;
  files: string;
  avatars: string;
  backgrounds: string;
  attachments: string;
  audio: string;
  generated: string;
  plugins: string;
  themes: string;
  cache: string;
  thumbnails: string;
  pluginBlobs: string;
  pluginJobs: string;
  backups: string;
  logs: string;
}

export function resolveDataPaths(dataDir: string): DataPaths {
  const root = resolve(dataDir);
  const files = resolve(root, 'files');
  const cache = resolve(root, 'cache');
  return {
    root,
    dbFile: resolve(root, 'app.db'),
    files,
    avatars: resolve(files, 'avatars'),
    backgrounds: resolve(files, 'backgrounds'),
    attachments: resolve(files, 'attachments'),
    audio: resolve(files, 'audio'),
    generated: resolve(files, 'generated'),
    plugins: resolve(root, 'plugins'),
    themes: resolve(root, 'themes'),
    cache,
    thumbnails: resolve(cache, 'thumbnails'),
    pluginBlobs: resolve(cache, 'plugin-blobs'),
    pluginJobs: resolve(cache, 'plugin-jobs'),
    backups: resolve(root, 'backups'),
    logs: resolve(root, 'logs'),
  };
}

/** Create every data directory (idempotent). */
export function ensureDataDirs(paths: DataPaths): void {
  for (const dir of [
    paths.root,
    paths.files,
    paths.avatars,
    paths.backgrounds,
    paths.attachments,
    paths.audio,
    paths.generated,
    paths.plugins,
    paths.themes,
    paths.cache,
    paths.thumbnails,
    paths.pluginBlobs,
    paths.pluginJobs,
    paths.backups,
    paths.logs,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
