import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Chromium-only migration oracle. This deliberately uses the legacy React
 * fixture host because the complete Character Manager has not yet reached the
 * Product Wire-only headless host.
 */
const root = import.meta.dirname;
const externalSqlite = resolve(
  root,
  'apps/desktop/src-tauri/resources/native/node_modules/better-sqlite3/lib/index.js',
);
const runDataRoot = resolve(tmpdir(), 'neotavern-ui-oracle', String(process.pid));
const serverPort = 4186;

rmSync(runDataRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });

function serverEnv(): Record<string, string> {
  const env: Record<string, string> = {
    NEOTA_HOST: '127.0.0.1',
    NEOTA_PORT: String(serverPort),
    NEOTA_DATA_DIR: runDataRoot,
    NEOTA_WEB_DIR: resolve(root, 'apps/web/dist'),
    NEOTA_CORS_ORIGIN: `http://127.0.0.1:${serverPort}`,
    NEOTA_LOG_LEVEL: 'warn',
  };
  if (existsSync(externalSqlite)) env['NEOTA_SQLITE_MODULE'] = externalSqlite;
  return env;
}

export default defineConfig({
  testDir: './e2e/ui-oracle',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 2 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${serverPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'pnpm --filter @neotavern/contracts build && node apps/server/dist/main.js',
    env: serverEnv(),
    url: `http://127.0.0.1:${serverPort}/api/v2/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
