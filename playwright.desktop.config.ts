import { defineConfig } from '@playwright/test';

/**
 * Desktop WebView suite. The app under test is the packaged Tauri shell, launched
 * by `scripts/desktop-webview-e2e.mjs`, which exposes a DevTools endpoint through
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`; specs connect with
 * `chromium.connectOverCDP(process.env.DESKTOP_CDP_URL)`.
 */
export default defineConfig({
  testDir: './e2e/desktop',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  reporter: [['list']],
  outputDir: 'test-results/desktop',
  use: { trace: 'off' },
});
