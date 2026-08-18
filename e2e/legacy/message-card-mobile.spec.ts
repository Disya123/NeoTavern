/**
 * Mobile message card e2e (C3): at ≤600px the assistant bubble header shows
 * ONLY pencil + ellipsis; both open the ST1-style MessageDetailsCard bottom
 * sheet. This suite covers the details surface (meta rows, horizontal action
 * panel, pinned footer, rendered content), the pencil's direct-edit mode
 * (save → refetch shows the new content), Escape/delete dismissal and the
 * Radix focus trap.
 *
 * Fixture records are created through the REST API (deterministic, suffixed
 * names — the e2e data directory persists between runs). The built-in offline
 * echo provider answers `You said: "<msg>". This is the offline echo
 * provider.` without any network.
 */
import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations, postJson } from '../helpers.js';

const GENERATION_TIMEOUT_MS = 20_000;

test.use({ viewport: { width: 390, height: 844 } });

async function createCharacterAndChat(page: Page, suffix: string): Promise<{ chatId: string }> {
  const chatTitle = `Card Chat ${suffix}`;
  const character = await postJson(page, '/characters', {
    name: `Card Character ${suffix}`,
    description: 'Created by the mobile message card e2e suite.',
  });
  const chat = await postJson(page, '/chats', {
    characterId: character['id'],
    title: chatTitle,
  });
  return { chatId: String(chat['id']) };
}

async function activateEchoProvider(page: Page, suffix: string): Promise<void> {
  const provider = await postJson(page, '/providers', {
    kind: 'echo',
    name: `Card Echo ${suffix}`,
    model: 'echo',
  });
  const activated = await page.request.patch('/api/v2/settings', {
    data: { activeProviderConfigId: provider['id'] },
  });
  expect(activated.ok()).toBe(true);
}

async function sendAndWaitForEchoReply(
  page: Page,
  userMessage: string,
): Promise<ReturnType<Page['locator']>> {
  const composer = page.locator('[data-slot="chat.composer"]');
  await composer.getByLabel(/Type a message/iu).fill(userMessage);
  await composer.getByRole('button', { name: 'Send' }).click();
  const doneBubble = page.locator(
    '[data-component="chat-message"][data-role="assistant"][data-state="done"]',
  );
  await expect(doneBubble).toBeVisible({ timeout: GENERATION_TIMEOUT_MS });
  await expect(doneBubble).toContainText('This is the offline echo provider.');
  return doneBubble;
}

test('mobile header keeps only pencil + ellipsis; details opens the card with meta, panel and footer', async ({
  page,
}) => {
  const suffix = Date.now().toString(36);
  const userMessage = `Card details ${suffix}`;
  const { chatId } = await createCharacterAndChat(page, suffix);
  await activateEchoProvider(page, `Details ${suffix}`);

  await page.goto(`/chats/${chatId}`);
  const doneBubble = await sendAndWaitForEchoReply(page, userMessage);

  // Pin the reply to a short fixed content: an earlier suite in this process
  // may have left prompt-template mode on, making the echo reply a long ChatML
  // prompt whose length changes the details sheet geometry. The rendered card
  // is asserted below; only the sheet's size must be deterministic.
  const replyList = await page.request.get(`/api/v2/chats/${chatId}/messages?order=asc&limit=50`);
  const replyBody = (await replyList.json()) as { items: Array<{ id: string; role: string }> };
  const reply = [...replyBody.items].reverse().find((message) => message.role === 'assistant');
  const replyId = reply?.id;
  if (!replyId) throw new Error('Expected the echo reply message id.');
  const pinnedReply = 'This is the offline echo provider.';
  const pinnedPatch = await page.request.patch(`/api/v2/chats/${chatId}/messages/${replyId}`, {
    data: { content: pinnedReply },
  });
  expect(pinnedPatch.ok()).toBe(true);

  // The ≤600px compact header: exactly pencil + ellipsis, nothing else.
  const actionBar = doneBubble.locator('[data-component="message-action-bar"]');
  await expect(actionBar).toHaveAttribute('data-part', 'message-actions-compact');
  await expect(actionBar.locator('[data-action]')).toHaveCount(2);
  await expect(actionBar.locator('[data-action="edit"]')).toBeVisible();
  await expect(actionBar.locator('[data-action="details"]')).toBeVisible();
  for (const absent of [
    'more',
    'context',
    'copy',
    'regenerate',
    'branch',
    'checkpoint',
    'delete',
  ]) {
    await expect(actionBar.locator(`[data-action="${absent}"]`)).toHaveCount(0);
  }

  // Ellipsis → the card in details mode.
  await actionBar.locator('[data-action="details"]').click();
  const dialog = page.getByRole('dialog', { name: 'Message details' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-component="message-details-card"]')).toHaveAttribute(
    'data-state',
    'details',
  );

  // Meta rows: Sent + Model (echo provider).
  const metaRows = dialog.locator('[data-part="details-meta-row"]');
  await expect(metaRows.first()).toContainText('Sent');
  const modelRow = metaRows.filter({ hasText: 'Model' });
  await expect(modelRow).toHaveCount(1);
  await expect(modelRow).toContainText('echo');

  // Horizontal action panel: branch / checkpoint / delete present.
  const panel = dialog.locator('[data-part="details-actions"]');
  await expect(panel.locator('[data-action="branch"]')).toBeVisible();
  await expect(panel.locator('[data-action="checkpoint"]')).toBeVisible();
  await expect(panel.locator('[data-action="delete"]')).toBeVisible();
  await expect(panel.locator('[data-action="context"]')).toBeVisible();
  await expect(panel.locator('[data-action="history"]')).toBeVisible();
  await expect(panel.locator('[data-action="regenerate"]')).toBeVisible();
  expect(await panel.evaluate((element) => element.scrollWidth >= element.clientWidth)).toBe(true);

  // Pinned footer contains only Copy / + / Edit.
  const cardFooter = dialog.locator('[data-part="details-footer"]');
  await expect(cardFooter.locator('[data-action="copy"]')).toBeVisible();
  await expect(cardFooter.locator('[data-action="actions"]')).toBeVisible();
  await expect(cardFooter.locator('[data-action="edit"]')).toBeVisible();
  await expect(cardFooter.locator('[data-action]')).toHaveCount(3);
  await expect(cardFooter.locator('[data-action="context"]')).toHaveCount(0);
  await expect(cardFooter.locator('[data-action="history"]')).toHaveCount(0);

  // Rendered message text inside the card.
  await expect(dialog.locator('[data-part="details-content"]')).toContainText(
    'This is the offline echo provider.',
  );

  await expectNoA11yViolations(page);
  await expect(dialog).toHaveScreenshot('message-details-mobile.png', {
    animations: 'disabled',
    mask: [
      dialog.locator('[data-part="details-header"]'),
      dialog.locator('[data-part="details-meta"]'),
      dialog.locator('[data-part="details-content"]'),
    ],
    maxDiffPixels: 100,
  });
  const userBubble = page.locator('[data-component="chat-message"][data-role="user"]').last();
  await expect(userBubble.locator('[data-action="history"]')).toHaveCount(0);

  // Pulling the top handle down dismisses the sheet.
  const dragHandle = dialog.locator('[data-part="drag-handle"]');
  const handleBox = await dragHandle.boundingBox();
  if (handleBox === null) throw new Error('Drag handle must have measurable bounds.');
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height + 80, {
    steps: 4,
  });
  await page.mouse.up();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(doneBubble).toBeVisible();
});

test('pencil opens the card in edit mode; Cancel closes it, Confirm saves and the refetch shows the new content', async ({
  page,
}) => {
  const suffix = Date.now().toString(36);
  const userMessage = `Card edit ${suffix}`;
  const { chatId } = await createCharacterAndChat(page, suffix);
  await activateEchoProvider(page, `Edit ${suffix}`);

  await page.goto(`/chats/${chatId}`);
  const doneBubble = await sendAndWaitForEchoReply(page, userMessage);

  // The echo reply text depends on global settings (instruct format, persona)
  // left by earlier suites in the shared run — fetch the authoritative
  // content from the API instead of hardcoding the provider's reply format.
  const messagesRes = await page.request.get(`/api/v2/chats/${chatId}/messages?order=asc&limit=50`);
  const messages = (await messagesRes.json()) as {
    items: Array<{ role: string; content: string }>;
  };
  const assistant = [...messages.items].reverse().find((message) => message.role === 'assistant');
  expect(assistant).toBeDefined();
  const expectedReply = assistant?.content ?? '';
  // The bubble renders markdown: newlines become <br>, which contributes no
  // text content, so compare against the render-equivalent content.
  const renderedReply = expectedReply.replace(/\n/g, '');

  // Pencil → the card opens directly in edit mode with the current content.
  await doneBubble.locator('[data-action="edit"]').click();
  let dialog = page.getByRole('dialog', { name: 'Message details' });
  await expect(dialog.locator('[data-part="details-editor"] textarea')).toHaveValue(expectedReply);
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Confirm edit' })).toBeVisible();

  // Cancel from the pencil closes the card without saving.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Reopen and save a replacement: the card closes and the bubble refetches.
  await doneBubble.locator('[data-action="edit"]').click();
  dialog = page.getByRole('dialog', { name: 'Message details' });
  const replacement = `Edited reply ${suffix}`;
  await dialog.locator('[data-part="details-editor"] textarea').fill(replacement);
  await dialog.getByRole('button', { name: 'Confirm edit' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(doneBubble).toContainText(replacement, { timeout: GENERATION_TIMEOUT_MS });
  await expect(doneBubble).not.toContainText(renderedReply);

  // A second real edit creates another revision; restore the oldest one non-destructively.
  await doneBubble.locator('[data-action="edit"]').click();
  dialog = page.getByRole('dialog', { name: 'Message details' });
  const secondReplacement = `Second edited reply ${suffix}`;
  await dialog.locator('[data-part="details-editor"] textarea').fill(secondReplacement);
  await dialog.getByRole('button', { name: 'Confirm edit' }).click();
  await expect(doneBubble).toContainText(secondReplacement, { timeout: GENERATION_TIMEOUT_MS });

  const versionControls = doneBubble.locator('[data-component="message-version-controls"]');
  await versionControls.getByRole('button', { name: 'Revision history' }).click();
  const historyDialog = page.getByRole('dialog', { name: 'Revision history' });
  const archived = historyDialog.locator(
    '[data-part="revision-history-item"][data-state="archived"]',
  );
  await expect(archived).toHaveCount(2);
  const originalRevision = archived.filter({ hasText: expectedReply });
  await expect(originalRevision).toHaveCount(1);
  await originalRevision.getByRole('button', { name: 'Restore' }).click();
  await expect(doneBubble).toContainText(renderedReply, { timeout: GENERATION_TIMEOUT_MS });
  await historyDialog.getByRole('button', { name: 'Close' }).click();

  await page.reload();
  const reloadedBubble = page.locator(
    '[data-component="chat-message"][data-role="assistant"][data-state="done"]',
  );
  await expect(reloadedBubble).toContainText(renderedReply, { timeout: GENERATION_TIMEOUT_MS });
  await expect(reloadedBubble).not.toContainText(secondReplacement);
});

test('delete from the card closes it and opens the Delete confirmation; Tab stays inside the card', async ({
  page,
}) => {
  const suffix = Date.now().toString(36);
  const userMessage = `Card delete ${suffix}`;
  const { chatId } = await createCharacterAndChat(page, suffix);
  await activateEchoProvider(page, `Delete ${suffix}`);

  await page.goto(`/chats/${chatId}`);
  const doneBubble = await sendAndWaitForEchoReply(page, userMessage);
  await doneBubble.locator('[data-action="details"]').click();
  const dialog = page.getByRole('dialog', { name: 'Message details' });
  await expect(dialog).toBeVisible();

  // Radix focus trap: Tab cycles within the card, never into the page behind.
  await dialog.getByRole('button', { name: 'Edit message' }).first().focus();
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }

  // Plus switches to the grouped action menu; deletion is isolated in Danger zone.
  await dialog.locator('[data-part="details-footer"] [data-action="actions"]').click();
  await expect(dialog.locator('[data-component="message-details-card"]')).toHaveAttribute(
    'data-state',
    'actions',
  );
  await dialog.locator('[data-part="details-danger-zone"] [data-action="delete"]').click();
  await expect(page.getByRole('dialog', { name: 'Message details' })).toHaveCount(0);
  const confirm = page.getByRole('dialog', { name: 'Delete message' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(doneBubble).toBeVisible();
});
