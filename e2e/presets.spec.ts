/**
 * Preset + memory settings flows (Этап 4 slice 3): the AI Settings panel
 * exposes the Config (generation presets), API, Memories and Advanced tabs.
 * This suite exercises the generation-preset CRUD and the memory CRUD through
 * the UI against the running server:
 *
 * 1. Generation preset: create (Save with the unsaved-settings draft opens the
 *    name editor), rename, delete — the preset select and the settings draft
 *    follow the active preset.
 * 2. Memories: create a global memory (content + keys), verify the list,
 *    toggle it off, then delete it.
 *
 * Fixture records (character/chat) are created through the REST API so each
 * test stays deterministic; every assertion targets UI-rendered state. The
 * e2e data directory persists between runs, so all names are suffixed.
 */
import { expect, test, type Page } from '@playwright/test';
import { postJson, expectNoA11yViolations } from './helpers.js';

async function openAiSettings(page: Page, suffix: string): Promise<Page['locator']> {
  const chatTitle = `Preset Chat ${suffix}`;
  const character = await postJson(page, '/characters', {
    name: `Preset Character ${suffix}`,
    description: 'Created by the presets e2e suite.',
  });
  const chat = await postJson(page, '/chats', {
    characterId: character['id'],
    title: chatTitle,
  });
  await page.goto(`/chats/${chat['id']}`);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'AI Settings', exact: true })
    .click();
  const panel = page.getByRole('region', { name: 'AI Settings', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

test('generation preset CRUD through the Config tab', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const presetName = `E2E Generation ${suffix}`;
  const panel = await openAiSettings(page, suffix);

  await panel.getByRole('tab', { name: 'Config', exact: true }).click();
  const editor = panel.locator('[data-component="generation-preset-editor"]');
  await expect(editor).toBeVisible();

  // Create: the Save button on unsaved settings opens the name editor.
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  const nameEditor = editor.locator('[data-part="preset-name-editor"]');
  await nameEditor.locator('input').fill(presetName);
  await nameEditor.getByRole('button', { name: 'Save', exact: true }).click();
  const presetSelect = editor.getByRole('combobox', {
    name: 'Generation preset',
    exact: true,
  });
  await expect(presetSelect).toContainText(presetName);

  // Rename through the toolbar pencil.
  await editor.getByRole('button', { name: 'Rename', exact: true }).click();
  const renamed = `${presetName} v2`;
  await editor.locator('[data-part="preset-name-editor"]').locator('input').fill(renamed);
  await editor
    .locator('[data-part="preset-name-editor"]')
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(presetSelect).toContainText(renamed);

  // Delete through the confirm dialog.
  await editor.getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Delete generation preset/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(presetSelect).toHaveValue('');

  await expectNoA11yViolations(page, '[data-component="generation-preset-editor"]');
});

test('memory CRUD through the Memories tab', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const memoryContent = `The grand archive keeps the clockwork ledger ${suffix}.`;
  const panel = await openAiSettings(page, suffix);

  await panel.getByRole('tab', { name: 'Memories', exact: true }).click();
  const editor = panel.locator('[data-component="memory-editor"]');
  await expect(editor).toBeVisible();

  // Create a global memory.
  await editor.getByLabel('Content').fill(memoryContent);
  await editor.getByLabel('Keys (comma-separated)').fill('ledger');
  await editor.getByRole('button', { name: 'Add memory', exact: true }).click();
  await expect(editor.getByText(memoryContent)).toBeVisible();
  await expect(editor.getByText(/Global — ledger/)).toBeVisible();

  // Toggle it off through the card switch.
  const card = editor.getByText(memoryContent).locator('xpath=ancestor::li');
  await card.getByRole('switch', { name: 'Enabled', exact: true }).click();
  await expect(card).toHaveAttribute('data-state', 'disabled');

  // Delete through the confirm dialog.
  await card.getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete memory' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(editor.getByText(memoryContent)).toHaveCount(0);
  // The create form must be idle (no pending mutation) before the a11y scan —
  // axe blends a disabled primary button's opacity and flags contrast.
  await expect(editor.getByRole('button', { name: 'Add memory', exact: true })).toBeEnabled();

  await expectNoA11yViolations(page, '[data-component="memory-editor"]');
});
