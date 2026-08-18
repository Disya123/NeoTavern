import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Fastify `/api/v2` Playwright suite (M7 quarantine). Specs that still
 * need the legacy sidecar (plugins, theme ZIP install, echo provider,
 * context-audit) live under `e2e/legacy/`. Deleted when those surfaces
 * are gone.
 */
const root = import.meta.dirname;
const externalSqlite = resolve(
  root,
  'apps/desktop/src-tauri/resources/native/node_modules/better-sqlite3/lib/index.js',
);

function serverEnv(serverPort: number, dataDir: string): Record<string, string> {
  const env: Record<string, string> = {
    NEOTA_HOST: '127.0.0.1',
    NEOTA_PORT: String(serverPort),
    NEOTA_DATA_DIR: dataDir,
    NEOTA_WEB_DIR: resolve(root, 'apps/web/dist'),
    NEOTA_CORS_ORIGIN: `http://127.0.0.1:${serverPort}`,
    NEOTA_LOG_LEVEL: 'warn',
  };
  if (existsSync(externalSqlite)) env['NEOTA_SQLITE_MODULE'] = externalSqlite;
  return env;
}

const runDataRoot = resolve(tmpdir(), 'neotavern-playwright-legacy', String(process.pid));
const functionalDataDir = resolve(runDataRoot, 'functional');
const visualDataDir = resolve(runDataRoot, 'visual');
rmSync(runDataRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });

const shardOffset = Number.parseInt(process.env['E2E_PORT_OFFSET'] ?? '0', 10) || 0;
const shardPort = 4174 + shardOffset * 2;
const shardVisualPort = 4175 + shardOffset * 2;
const shardReportDir = process.env['E2E_REPORT_DIR'] ?? 'playwright-report';
const shardOutputDir = process.env['E2E_OUTPUT_DIR'] ?? 'test-results';

export default defineConfig({
  testDir: './e2e/legacy',
  fullyParallel: false,
  workers: 1,
  outputDir: shardOutputDir,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: resolve(shardReportDir) }]],
  use: {
    baseURL: `http://127.0.0.1:${shardPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce',
  },
  webServer: [
    {
      command: 'node apps/server/dist/main.js',
      env: serverEnv(shardPort, functionalDataDir),
      url: `http://127.0.0.1:${shardPort}/api/v2/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'node apps/server/dist/main.js',
      env: serverEnv(shardVisualPort, visualDataDir),
      url: `http://127.0.0.1:${shardVisualPort}/api/v2/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      testIgnore: ['**/visual.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'visual',
      testMatch: ['**/visual.spec.ts'],
      use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${shardVisualPort}` },
    },
  ],
});
