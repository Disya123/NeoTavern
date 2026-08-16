import { defineConfig, devices } from '@playwright/test';

const webOrigin = process.env['E2E_HEADLESS_WEB'] ?? 'http://127.0.0.1:4178';

export default defineConfig({
  testDir: './e2e/headless',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: webOrigin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce',
    launchOptions: {
      args: ['--disable-features=LocalNetworkAccessChecks'],
    },
  },
  webServer: {
    command: 'node scripts/e2e-headless.mjs',
    url: `${webOrigin}/e2e/headless-target`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'chromium-headless-remote',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
