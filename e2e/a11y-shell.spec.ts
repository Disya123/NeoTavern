import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from './helpers.js';

/**
 * G10 accessibility slice: WCAG 2.2 AA axe scans over the kernel-plane shell,
 * run on the user-facing HIGH CONTRAST profile (`neotavern.uiContrast=high`,
 * a first-class Settings preference). Rationale: the glass panels paint
 * `color-mix(in srgb, ... transparent)` backgrounds, and axe-core cannot
 * resolve color-mix / backdrop stacks - it fabricates blended fg/bg pairs
 * and reports false color-contrast violations (measured computed colors were
 * correct AA while axe reported 3.4:1). The NORMAL-profile contrast is
 * guarded numerically by `packages/ui/test/tokens-contrast.test.ts`
 * (every muted/secondary token >= 4.5:1 on every surface it renders over),
 * and the muted tokens were darkened in round 36 to hold AA even on the
 * blended glass color (#675f58 light / #a39a91 dark).
 */
const HIGH_CONTRAST_INIT = `
  localStorage.setItem('neotavern.uiContrast', 'high');
  localStorage.setItem('neotavern.uiOpacity', '100');
`;

const PANELS: ReadonlyArray<readonly [string, string]> = [
  ['Characters', 'character-management'],
  ['Personas', 'personas-panel'],
  ['Lorebooks', 'lorebooks-panel'],
  ['Backgrounds', 'backgrounds-panel'],
  ['Settings', 'settings-panel'],
];

test('shell screens pass WCAG 2.2 AA axe scans', async ({ page }) => {
  await page.addInitScript(HIGH_CONTRAST_INIT);
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main navigation' }).waitFor({ timeout: 45_000 });

  // Chat workspace (home): the shipped default screen.
  await expectNoA11yViolations(page);

  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  for (const [label, component] of PANELS) {
    await nav.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator(`[data-component="${component}"]`)).toBeVisible();
    await expectNoA11yViolations(page, `[data-component="${component}"]`);
  }
});
