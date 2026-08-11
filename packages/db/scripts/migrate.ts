#!/usr/bin/env -S node --import tsx
/**
 * Standalone migration runner (pnpm db:migrate). Opens the app database in the
 * data directory and applies any pending migrations. The server also migrates
 * automatically on startup; this is for manual/offline use.
 *
 * Like the server path, a pre-migration backup is taken before any pending
 * migration runs (ТЗ §10.4: «перед миграцией создаётся backup»).
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAppDatabase } from '../src/database.js';

const dataDir = process.env['NEOTA_DATA_DIR'] ?? resolve(process.cwd(), 'data');
mkdirSync(dataDir, { recursive: true });
const dbPath = resolve(dataDir, 'app.db');
const backupsDir = resolve(dataDir, 'backups');
mkdirSync(backupsDir, { recursive: true });

const db = createAppDatabase(dbPath, { autoBackupDir: backupsDir });
console.log(`[db:migrate] migrations applied for ${dbPath}`);
db.close();
