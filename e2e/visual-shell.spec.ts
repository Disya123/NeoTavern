/**
 * Visual regression on the KERNEL plane (G10's remaining half): the existing
 * snapshots under `e2e/legacy/` only cover the Fastify sidecar, which stops
 * being the product surface at the stage-6 deletion. This suite captures the
 * shipped React shell rendered over Product Wire / `neotavern-headless`
 * (playwright.config.ts), so a visual regression on the canonical plane fails
 * the gate on its own evidence instead of inheriting the legacy one.
 *
 * Determinism rules (learned from the legacy suite):
 * - `clearChats` removes chats mutated by sibling specs, so the hero is stable;
 * - reduced motion is already forced by the config, animations/caret are also
 *   disabled per shot;
 * - fonts must be ready before the shot (otherwise the fallback face leaks in);
 * - the HIGH CONTRAST profile is captured too, because that is the profile the
 *   axe gate scans and the one users who need it actually see.
 *
 * A snapshot mismatch is a real UI change: update intentionally with
 *
 *   node "C:/Program Files/nodejs/node_modules/corepack/dist/pnpm.js" exec \
 *     playwright test e2e/visual-shell.spec.ts --update-snapshots
 *
 * Baselines are platform-specific (`-win32.png`); a Linux CI run needs its own
 * committed baselines before this gate can be enforced there.
 */
import { expect, test, type Page } from '@playwright/test';
import { clearChats } from './helpers.js';

const SCREENSHOT_OPTIONS = {
  animations: 'disabled' as const,
  caret: 'hide' as const,
  maxDiffPixels: 160,
};

async function waitForShell(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Main navigation' }).waitFor({ timeout: 45_000 });
  // Fonts decide line breaking; a shot taken before they settle is a false diff.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Array.from(document.images).every((img) => (img as HTMLImageElement).complete),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}

test('kernel shell — light home', async ({ page }) => {
  await clearChats(page);
  await page.goto('/');
  await waitForShell(page);
  await expect(page).toHaveScreenshot('kernel-home-light.png', SCREENSHOT_OPTIONS);
});

test('kernel shell — settings panel', async ({ page }) => {
  await page.goto('/');
  await waitForShell(page);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await expect(page.locator('[data-component="settings-panel"]')).toBeVisible();
  await expect(page).toHaveScreenshot('kernel-settings-light.png', SCREENSHOT_OPTIONS);
});

test('kernel shell — high contrast home', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('neotavern.uiContrast', 'high');
    window.localStorage.setItem('neotavern.uiOpacity', '100');
  });
  await clearChats(page);
  await page.goto('/');
  await waitForShell(page);
  await expect(page.locator('html')).toHaveAttribute('data-ui-contrast', 'high');
  await expect(page).toHaveScreenshot('kernel-home-high-contrast.png', SCREENSHOT_OPTIONS);
});
