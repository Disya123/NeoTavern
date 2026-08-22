import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { captureAnnotatedUi } from '../../scripts/ui-oracle/capture.mjs';

async function loadPresentationBlueprint() {
  return import('../../packages/contracts/dist/presentation/blueprint.js');
}

async function waitForApp(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}

async function openCharacterManager(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Characters', exact: true })
    .click();
  await expect(page.locator('[data-ui-root="character-manager"]')).toBeVisible();
}

async function captureCards(
  page: Page,
  viewportClass: 'compact' | 'medium' | 'expanded',
  width: number,
  height: number,
) {
  await page.setViewportSize({ width, height });
  await page.goto('/home');
  await waitForApp(page);
  await openCharacterManager(page);

  const panel = page.locator('[data-ui-root="character-manager"]');
  const png = await panel.screenshot({ animations: 'disabled', caret: 'hide' });
  const raster = {
    width,
    height,
    sha256: createHash('sha256').update(png).digest('hex'),
  };
  const { SUPPORTED_CAPTURE_STYLE_PROPERTIES } = await loadPresentationBlueprint();
  return captureAnnotatedUi(page, {
    rootSelector: '[data-ui-root="character-manager"]',
    fixtureId: `character-manager.populated.${viewportClass}`,
    viewportClass,
    state: 'populated',
    viewport: {
      width,
      height,
      deviceScaleFactor: 1,
      orientation: width > height ? 'landscape' : 'portrait',
      ime: 'closed',
    },
    computedStyleProperties: SUPPORTED_CAPTURE_STYLE_PROPERTIES,
    actionTrace: [],
    raster,
  });
}

test('Character Manager Cards emits a deterministic Chromium CaptureBundle', async ({ page }) => {
  const capture = await captureCards(page, 'expanded', 1_280, 800);

  expect(capture.rootNodeId).toBe('character-manager');
  expect(capture.nodes.map((node) => node.component)).toContain('CharacterManager');
  expect(capture.nodes.map((node) => node.component)).toContain('CharacterCards');
  expect(capture.nodes.map((node) => node.component)).toContain('CharacterCard');
  expect(capture.raster?.sha256).toMatch(/^[a-f0-9]{64}$/);
});

test.fixme('strictly imports compact/medium/expanded React capture once every authored CSS declaration is in the v1 support matrix', async ({
  page,
}) => {
  const captures = [
    await captureCards(page, 'compact', 360, 800),
    await captureCards(page, 'medium', 720, 800),
    await captureCards(page, 'expanded', 1_280, 800),
  ];
  const { normalizeCharacterManagerCaptureMatrix } = await loadPresentationBlueprint();
  const result = normalizeCharacterManagerCaptureMatrix({ captures });
  expect(result.ok).toBe(true);
});
