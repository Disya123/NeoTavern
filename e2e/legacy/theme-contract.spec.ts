/**
 * Theme package contract coverage on top of the release smoke suite:
 *
 * 1. Malformed and unsafe packages (not a ZIP, no manifest, traversal entry,
 *    remote CSS import) are rejected with the localized error and leave no
 *    theme card behind.
 * 2. A theme with settings+variable tokens emits persisted settings as CSS
 *    custom properties on the document root and survives a reload.
 * 3. Declarative shell layout can restore the floating management-tab cloud.
 * 4. Deleting the active theme clears its document overrides.
 *
 * The happy path (install, apply, safe mode, persistence) is covered by
 * release.spec.ts; this file focuses on the rejection and settings contract.
 */
import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations, zipBuffer } from '../helpers.js';

const THEME_INVALID_TEXT = 'The theme package is invalid.';

async function installArchive(page: Page, archive: Buffer, name: string) {
  await page.getByLabel('Install theme package').setInputFiles({
    name,
    mimeType: 'application/zip',
    buffer: archive,
  });
}

test('rejects malformed and unsafe theme packages with localized errors', async ({ page }) => {
  const suffix = Date.now().toString(36);
  await page.goto('/themes');
  // Bundled themes are pre-seeded, so the manager is not empty. Rejected
  // installs must not change the existing card set.
  const cards = page.locator('[data-component="theme-card"]');
  await expect(cards.first()).toBeVisible();
  const baselineCount = await cards.count();

  await page.getByLabel('Install theme package').setInputFiles({
    name: 'not-a-zip.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('definitely not a zip archive'),
  });
  await expect(page.getByRole('alert')).toHaveText('The request was invalid.');

  await installArchive(
    page,
    zipBuffer({ 'skin.css': 'body { color: red; }' }),
    'no-manifest.sttheme',
  );
  await expect(page.getByRole('alert')).toHaveText(THEME_INVALID_TEXT);

  await installArchive(
    page,
    zipBuffer({ '../evil.css': 'body { color: red; }' }),
    'traversal.sttheme',
  );
  // Traversal entries are rejected by the package extractor with BAD_REQUEST.
  await expect(page.getByRole('alert')).toHaveText('The request was invalid.');

  const remote = zipBuffer({
    'theme.json': JSON.stringify({
      id: `e2e.remote-${suffix}`,
      name: `Remote Theme ${suffix}`,
      version: '1.0.0',
      componentsCss: 'styles/components.css',
    }),
    'styles/components.css': '@import url("https://evil.example/x.css"); body {}',
  });
  await installArchive(page, remote, 'remote.sttheme');
  await expect(page.getByRole('alert')).toHaveText(THEME_INVALID_TEXT);

  await expect(page.locator('[data-component="theme-card"]')).toHaveCount(baselineCount);
  await expectNoA11yViolations(page);
});

test('emits persisted theme settings as CSS variables after a reload', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const themeId = `e2e.settings-${suffix}`;
  const themeName = `Settings Theme ${suffix}`;
  const archive = zipBuffer({
    'theme.json': JSON.stringify({
      id: themeId,
      name: themeName,
      version: '1.0.0',
      apiVersion: 1,
      tokens: {
        light: { 'color-accent': '#3157c8' },
        dark: { 'color-accent': '#3157c8' },
      },
      settings: {
        accent: {
          type: 'color',
          label: 'Accent color',
          default: '#00ff00',
          variable: '--st-color-accent',
        },
      },
    }),
  });

  await page.goto('/themes');
  await installArchive(page, archive, 'settings.sttheme');
  await expect(
    page.getByText(`Installed ${themeName}. Review it here before applying.`),
  ).toBeVisible();
  const card = page.locator('[data-component="theme-card"]').filter({ hasText: themeName });
  await card.getByRole('button', { name: 'Apply theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme-id', themeId);

  // ThemeSync fetches settings on mount; change them server-side, then reload
  // so the persisted value is emitted as --st-color-accent.
  const patch = await page.request.patch(`/api/v2/themes/${themeId}/settings`, {
    data: { accent: '#123456' },
  });
  expect(patch.ok()).toBe(true);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme-id', themeId);
  await expect(page.locator('html')).toHaveCSS('--st-color-accent', '#123456');
});

test('theme shell layout can pin desktop management tabs', async ({ page }) => {
  const themeId = 'e2e.tabs-pinned';
  await page.route('**/api/v2/themes', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        activeThemeId: themeId,
        items: [
          {
            id: themeId,
            name: 'Pinned Tabs',
            version: '1.0.0',
            enabled: true,
            manifest: {
              id: themeId,
              name: 'Pinned Tabs',
              version: '1.0.0',
              apiVersion: 1,
              shellLayout: { managementTabs: { pinned: true } },
            },
            installedAt: 1,
            componentsCssUrl: null,
            shellCssUrl: null,
            previewUrl: null,
          },
        ],
      }),
    });
  });

  await page.goto('/home');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Characters', exact: true })
    .click();

  const panel = page.getByRole('region', { name: 'Characters', exact: true });
  const tabList = panel.locator('[data-component="tabs-list"]').first();
  await expect(panel).toHaveAttribute('data-management-tabs-pinned', 'true');
  await expect(tabList).toHaveCSS('position', 'sticky');

  const geometry = await tabList.evaluate((element) => {
    const panelElement = element.closest('[data-component="navigation-panel"]');
    const header = panelElement?.querySelector('[data-component="sidebar-panel-header"]');
    const activeContent = element.parentElement?.querySelector(
      '[data-component="tabs-content"][data-state="active"]',
    );
    if (!(header instanceof HTMLElement) || !(activeContent instanceof HTMLElement)) {
      throw new Error('Management tabs must stay paired with their panel header and content');
    }
    const tabBox = element.getBoundingClientRect();
    return {
      headerBottom: header.getBoundingClientRect().bottom,
      tabTop: tabBox.top,
      contentOverlap: tabBox.bottom - activeContent.getBoundingClientRect().top,
    };
  });
  expect(geometry.tabTop).toBeGreaterThan(geometry.headerBottom);
  expect(geometry.contentOverlap).toBeLessThanOrEqual(0);
  // Audit the pinned-tabs panel only: a whole-page audit would also flag the
  // plugin toolbar tray that floats over the chat header search (a separate
  // app defect), which only renders when a sibling test in the same process
  // has installed a toolbar plugin.
  await expectNoA11yViolations(page, '[data-component="navigation-panel"]');
});

test('deleting the active theme clears its document overrides', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const themeId = `e2e.delete-${suffix}`;
  const themeName = `Delete Theme ${suffix}`;
  const archive = zipBuffer({
    'theme.json': JSON.stringify({
      id: themeId,
      name: themeName,
      version: '1.0.0',
      tokens: {
        light: { 'color-accent': '#ff0000' },
        dark: { 'color-accent': '#ff0000' },
      },
    }),
  });

  await page.goto('/themes');
  await installArchive(page, archive, 'delete.sttheme');
  const card = page.locator('[data-component="theme-card"]').filter({ hasText: themeName });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Apply theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme-id', themeId);
  await expect(page.locator('html')).toHaveCSS('--st-color-accent', '#ff0000');

  await card.getByRole('button', { name: `Delete theme ${themeName}` }).click();
  const deleteDialog = page.getByRole('dialog', { name: 'Remove theme' });
  await expect(deleteDialog).toBeVisible();
  await deleteDialog.getByRole('button', { name: 'Delete' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme-id');
  await expect(page.locator('link[data-neotavern-theme-style]')).toHaveCount(0);
});
