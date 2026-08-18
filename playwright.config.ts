import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * M7 Kernel Playwright config. Boots `neotavern-headless` + `apps/web/dist`
 * (scripts/e2e-headless.mjs). The Fastify `/api/v2` suite lives in
 * `playwright.legacy.config.ts` until those specs are ported.
 */
const root = import.meta.dirname;
const shardOffset = Number.parseInt(process.env['E2E_PORT_OFFSET'] ?? '0', 10) || 0;
const webPort = 4174 + shardOffset * 2;
const headlessPort = 18080 + shardOffset * 2;
const webOrigin = `http://127.0.0.1:${webPort}`;
const wireUrl = `http://127.0.0.1:${headlessPort}`;
const shardReportDir = process.env['E2E_REPORT_DIR'] ?? 'playwright-report';
const shardOutputDir = process.env['E2E_OUTPUT_DIR'] ?? 'test-results';

process.env['E2E_WIRE_URL'] = wireUrl;
process.env['E2E_HEADLESS_WEB_PORT'] = String(webPort);
process.env['E2E_HEADLESS_BIND'] = `127.0.0.1:${headlessPort}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  outputDir: shardOutputDir,
  testIgnore: ['**/spikes/**', '**/legacy/**'],
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: resolve(shardReportDir) }]],
  use: {
    baseURL: webOrigin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce',
    launchOptions: {
      args: ['--disable-features=LocalNetworkAccessChecks'],
    },
    storageState: {
      cookies: [],
      origins: [
        {
          origin: webOrigin,
          localStorage: [
            {
              name: 'neotavern.hostSession',
              value: JSON.stringify({ kind: 'remote', url: wireUrl }),
            },
          ],
        },
      ],
    },
  },
  webServer: {
    command: 'node scripts/e2e-headless.mjs',
    url: `${webOrigin}/e2e/headless-target`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      E2E_HEADLESS_WEB_PORT: String(webPort),
      E2E_HEADLESS_BIND: `127.0.0.1:${headlessPort}`,
    },
  },
  projects: [
    {
      name: 'chromium-kernel',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
