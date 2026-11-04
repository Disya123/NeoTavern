/**
 * Desktop WebView E2E: the packaged shell, driven through the real WebView2 over
 * CDP. These specs answer a different question than the shell smoke: not "did the
 * kernel answer", but "does a user see a working app" — the shell boots, the
 * sidebar renders, and the starter library arrives from the kernel.
 *
 * Fixtures are the packaged artifact itself; each run starts from a fresh data
 * root because the harness copies the bundle to a temp directory.
 */
/// <reference types="node" />
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const cdp = process.env['DESKTOP_CDP_URL'];
  if (!cdp) throw new Error('DESKTOP_CDP_URL is required (run scripts/desktop-webview-e2e.mjs)');
  browser = await chromium.connectOverCDP(cdp);
  const context = browser.contexts()[0];
  if (!context) throw new Error('the shell exposed no browser context');
  page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await browser?.close();
});

test('boots the packaged shell with the kernel-backed library', async () => {
  await expect(page).toHaveTitle('NeoTavern');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav).toBeVisible();
  // The starter character is not part of the web bundle — the kernel writes it on
  // first open, so seeing it means the UI read the kernel, not a fixture.
  await expect(page.getByText('Hazel', { exact: true }).first()).toBeVisible();
});

test('opens the AI settings panel from the sidebar', async () => {
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('button', { name: 'AI Settings' }).click();
  await expect(page.getByRole('region', { name: 'AI Settings', exact: true })).toBeVisible();
});
