/**
 * Visual regression for the base theme (ТЗ §17). Golden snapshots live under
 * e2e/legacy/visual.spec.ts-snapshots/ and are regenerated intentionally with:
 *
 *   pnpm exec playwright test -c playwright.legacy.config.ts e2e/legacy/visual.spec.ts --update-snapshots
 */
import { expect, test, type Page } from '@playwright/test';
import { clearChats, expectNoA11yViolations, zipBuffer } from '../helpers.js';

const SCREENSHOT_OPTIONS = {
  animations: 'disabled' as const,
  caret: 'hide' as const,
};

async function waitForApp(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
  // The seeded avatar thumbnail is generated lazily on first request
  // (AGENTS.md §12); a screenshot taken before it loads captures the
  // letter fallback instead of the image.
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Array.from(document.images).every(
            (img) =>
              (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0,
          ),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}

test('first run seeds Hazel without replacing the chat workspace', async ({ page }) => {
  await page.goto('/');
  await waitForApp(page);
  await expect(page.getByRole('heading', { name: 'Hazel', level: 1 })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Avatar of Hazel' })).toBeVisible();
  const search = page.getByRole('button', { name: 'Search this conversation' });
  await expect(search).toBeVisible();
  const greeting = page.locator('[data-component="home-greeting-message"]');
  await expect(greeting).toBeVisible();
  await expect(
    greeting.locator('[data-component="chat-message"][data-role="assistant"]'),
  ).toContainText('Hazel');
  await expect(
    page.getByRole('heading', { name: 'Say hello to start the conversation' }),
  ).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Set up AI' })).toHaveCount(0);
  await expect(page.locator('[data-component="main-area"]')).toBeVisible();
  await search.click();
  const chatSearch = page.getByRole('searchbox', { name: 'Search this conversation' });
  await chatSearch.fill('rain');
  await expect(page.locator('[data-slot="chat.header"]').getByRole('status')).toContainText(
    '2 matches',
  );
  await expect(greeting.locator('mark')).toHaveCount(2);
});

test.describe('base theme — light', () => {
  test.use({ colorScheme: 'light' });

  test('home shell', async ({ page }) => {
    await clearChats(page);
    await page.goto('/');
    await waitForApp(page);
    await expect(page).toHaveScreenshot('home-light.png', SCREENSHOT_OPTIONS);
  });
});

test.describe('base theme — high contrast', () => {
  test.use({ colorScheme: 'light' });

  test('home shell', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('neotavern.uiContrast', 'high');
    });
    await clearChats(page);
    await page.goto('/');
    await waitForApp(page);
    await expect(page.locator('html')).toHaveAttribute('data-ui-contrast', 'high');
    await expect(page).toHaveScreenshot('home-high-contrast.png', {
      ...SCREENSHOT_OPTIONS,
      maxDiffPixels: 300,
    });
  });
});

test.describe('installed theme — light', () => {
  test.use({ colorScheme: 'light' });

  test('home shell', async ({ page }) => {
    const archive = zipBuffer({
      'theme.json': JSON.stringify({
        id: 'e2e.visual',
        name: 'Visual Theme',
        version: '1.0.0',
        apiVersion: 1,
        tokens: {
          light: {
            'color-accent': '#7c3aed',
            'color-surface-primary': '#f5f3ff',
            'color-surface-secondary': '#ece9fb',
            'radius-card': '8px',
          },
        },
      }),
    });
    const install = await page.request.post('/api/v2/themes/install', {
      multipart: {
        file: { name: 'visual-theme.sttheme', mimeType: 'application/zip', buffer: archive },
      },
    });
    expect(install.ok()).toBe(true);
    const activate = await page.request.post('/api/v2/themes/e2e.visual/activate');
    expect(activate.ok()).toBe(true);

    try {
      await clearChats(page);
      await page.goto('/');
      await waitForApp(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme-id', 'e2e.visual');
      await expect(page.locator('html')).toHaveCSS('--st-color-accent', '#7c3aed');
      await expect(page).toHaveScreenshot('home-installed-theme.png', SCREENSHOT_OPTIONS);
    } finally {
      const remove = await page.request.delete('/api/v2/themes/e2e.visual');
      expect(remove.ok()).toBe(true);
    }
  });
});

test.describe('bundled AMOLED theme — dark', () => {
  test.use({ colorScheme: 'dark' });

  test('chat composer keeps the field transparent inside one glass surface', async ({ page }) => {
    const activate = await page.request.post('/api/v2/themes/neotavern.amoled/activate');
    expect(activate.ok()).toBe(true);

    try {
      await page.setViewportSize({ width: 505, height: 850 });
      await page.addInitScript(() => {
        localStorage.setItem('neotavern.navigationRailExpanded', 'false');
      });
      await page.goto('/');
      await waitForApp(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme-id', 'neotavern.amoled');

      const composer = page.locator('[data-slot="chat.composer"]');
      const navigationRail = page.locator('[data-slot="navigation.primary"]');
      const toolbar = composer.locator('[data-part="toolbar"]');
      const field = composer.locator('[data-part="field"]');
      const textarea = field.locator('[data-component="textarea"]');
      await expect(navigationRail).toHaveAttribute('data-state', 'collapsed');
      await expect(navigationRail).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(toolbar).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(field).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(textarea).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(textarea).toHaveCSS('backdrop-filter', 'none');

      await composer.locator('button[aria-controls="home-context-details"]').click();
      const contextPanel = composer.locator('[data-component="context-usage-panel"]');
      await expect(contextPanel).toBeVisible();
      await expect(contextPanel).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const metrics = contextPanel.locator('[data-part="metric"]');
      await expect(metrics).toHaveCount(4);
      for (const metric of await metrics.all()) {
        // Theme 1.1.8: metric chips are light tints of the elevated surface,
        // never opaque second shells inside the composer glass.
        const alpha = await metric.evaluate((element) => {
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Expected a 2D canvas context.');
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = getComputedStyle(element).backgroundColor;
          context.fillRect(0, 0, 1, 1);
          return context.getImageData(0, 0, 1, 1).data[3];
        });
        expect(alpha).toBeGreaterThan(0);
        expect(alpha).toBeLessThan(255);
      }

      const viewportBox = await page.locator('[data-component="chat-viewport"]').boundingBox();
      const composerBox = await composer.boundingBox();
      expect(viewportBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      if (!viewportBox || !composerBox) throw new Error('Expected visible chat surfaces.');
      expect(composerBox.y).toBeLessThan(viewportBox.y + viewportBox.height);

      const composerAlpha = await composer.evaluate((element) => {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Expected a 2D canvas context.');
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = getComputedStyle(element).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return context.getImageData(0, 0, 1, 1).data[3];
      });
      expect(composerAlpha).toBeGreaterThan(0);
      expect(composerAlpha).toBeLessThan(255);
      await expectNoA11yViolations(page);
    } finally {
      const reset = await page.request.delete('/api/v2/themes/active');
      expect(reset.ok()).toBe(true);
    }
  });
});

test.describe('base theme — dark', () => {
  test.use({ colorScheme: 'dark' });

  test('home shell', async ({ page }) => {
    await clearChats(page);
    await page.goto('/');
    await waitForApp(page);
    await expect(page).toHaveScreenshot('home-dark.png', SCREENSHOT_OPTIONS);
  });

  test('character viewer keeps the panel separator above media', async ({ page }) => {
    await page.setViewportSize({ width: 487, height: 932 });
    await page.goto('/home');
    await waitForApp(page);
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Characters', exact: true })
      .click();

    const panel = page.getByRole('region', { name: 'Characters', exact: true });
    await panel
      .locator('[data-part="character-cards"] button')
      .filter({ hasText: 'Hazel' })
      .click();
    await expect(panel.locator('[data-component="character-card-viewer"]')).toBeVisible();
    await waitForApp(page);

    const viewport = panel
      .locator('[data-component="tabs"][data-scroll-mode="root"] [data-radix-scroll-area-viewport]')
      .first();
    await viewport.evaluate((element) => {
      element.scrollTop = 48;
    });

    await expect(page).toHaveScreenshot('character-viewer-header-dark.png', {
      ...SCREENSHOT_OPTIONS,
      maxDiffPixels: 100,
    });
  });

  test('character tabs stay pinned to the desktop panel top', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/home');
    await waitForApp(page);
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Characters', exact: true })
      .click();

    const panel = page.getByRole('region', { name: 'Characters', exact: true });
    await panel
      .locator('[data-part="character-cards"] button')
      .filter({ hasText: 'Hazel' })
      .click();
    await expect(panel.locator('[data-component="character-card-viewer"]')).toBeVisible();
    await waitForApp(page);

    const viewport = panel
      .locator('[data-component="tabs"][data-scroll-mode="root"] [data-radix-scroll-area-viewport]')
      .first();
    const scrollTop = await viewport.evaluate((element) => {
      element.scrollTop = 240;
      return element.scrollTop;
    });
    expect(scrollTop).toBeGreaterThan(0);

    await expect(panel).toHaveScreenshot('character-tabs-pinned-desktop.png', {
      ...SCREENSHOT_OPTIONS,
      maxDiffPixels: 100,
    });
  });
});

test.describe('constrained layout', () => {
  test.use({ colorScheme: 'light', viewport: { width: 390, height: 844 } });

  test('character actions reflow inside the narrow side panel', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/home');
    await waitForApp(page);
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Characters', exact: true })
      .click();
    await expect(page.locator('[data-part="character-card-toolbar"]')).toBeVisible();
    await expect(page).toHaveScreenshot('character-actions-narrow.png', {
      ...SCREENSHOT_OPTIONS,
      maxDiffPixels: 100,
    });
  });

  test('pseudo-locale remains usable in mobile RTL', async ({ page }) => {
    await clearChats(page);
    await page.goto('/');
    await waitForApp(page);
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    const panel = page.getByRole('region', { name: 'Settings', exact: true });
    const closePanel = page.locator(
      '#navigation-context-panel [data-component="sidebar-panel-header"] [data-part="close"]',
    );
    await panel.getByLabel('Language').selectOption('pseudo');
    await closePanel.click();
    await page.evaluate(() => {
      document.documentElement.dir = 'rtl';
    });
    await expect(page.locator('html')).toHaveAttribute('lang', 'pseudo');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page).toHaveScreenshot('home-pseudo-mobile-rtl.png', SCREENSHOT_OPTIONS);
  });
});
