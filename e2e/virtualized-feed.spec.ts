/**
 * Virtualized feed coverage for OTHER-60:
 *
 * 1. A chat with hundreds of messages mounts only the visible window of rows
 *    (`[data-index]` count stays far below the total message count).
 * 2. The oldest message is not in the DOM until the user scrolls to the top.
 * 3. Loading an older page grows the canvas (total size) while the reading
 *    position stays anchored: the message under the top edge remains visible
 *    after the prepend (scroll-delta compensation).
 *
 * Fixture messages are seeded through the REST API (deterministic, newest
 * first per page; the UI reverses them for display).
 */
import { expect, test, type Page } from '@playwright/test';
import { postJson } from './helpers.js';

const SEEDED_MESSAGES = 240;
const TEST_TIMEOUT_MS = 120_000;

async function seedCharacterChat(
  page: Page,
  suffix: string,
): Promise<{ characterId: string; chatId: string }> {
  const character = await postJson(page, '/characters', {
    name: `Feed Character ${suffix}`,
    description: 'Seeded by the virtualized-feed e2e suite.',
  });
  const chat = await postJson(page, '/chats', {
    characterId: character['id'],
    title: `Feed Chat ${suffix}`,
  });
  for (let index = 0; index < SEEDED_MESSAGES; index += 1) {
    await postJson(page, `/chats/${chat['id']}/messages`, {
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: index % 2 === 0 ? `Seed question ${index}` : `Seed answer ${index}`,
    });
  }
  await postJson(page, `/chats/${chat['id']}/messages`, {
    role: 'assistant',
    content: `Latest reply ${suffix}`,
  });
  return { characterId: String(character['id']), chatId: String(chat['id']) };
}

test('virtualizes the feed, mounts the newest window, and anchors on load-older', async ({
  page,
}) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const suffix = Date.now().toString(36);
  const { chatId } = await seedCharacterChat(page, suffix);

  await page.goto(`/chats/${chatId}`);

  const canvas = page.locator('[data-component="chat-message-list"]');
  await expect(canvas).toBeVisible();
  const rows = page.locator('[data-index]');
  await expect(rows.first()).toBeVisible();

  // The newest message is shown while the oldest loaded row is not mounted yet.
  await expect(page.getByText(`Latest reply ${suffix}`).first()).toBeVisible();
  await expect(page.locator('[data-index="0"]')).toHaveCount(0);

  // The first page sizes the canvas; only a window of rows is mounted
  // despite the full chat having hundreds of messages. Kernel
  // `chats.messages.list` defaults to 50 (legacy Fastify served 100).
  const initialCanvasHeight = (await canvas.boundingBox())?.height ?? 0;
  expect(initialCanvasHeight).toBeGreaterThan(4_000);
  const mountedBeforeScroll = await rows.count();
  expect(mountedBeforeScroll).toBeGreaterThan(0);
  expect(mountedBeforeScroll).toBeLessThan(60);

  // Scroll to the top: the oldest loaded message becomes reachable.
  await page.locator('[data-component="chat-viewport"]').evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.locator('[data-index="0"]')).toBeVisible();

  // Loading an older page prepends rows; the top-anchored content must not
  // jump away (scroll-delta compensation in ChatPage).
  const topRowBefore = rows.first();
  await expect(topRowBefore).toBeVisible();
  await page.getByRole('button', { name: 'Load older messages' }).click();

  await expect
    .poll(async () => (await canvas.boundingBox())?.height ?? 0, {
      message: 'canvas must grow after loading an older page',
    })
    .toBeGreaterThan(initialCanvasHeight + 4_000);

  const mountedAfterLoad = await rows.count();
  expect(mountedAfterLoad).toBeGreaterThan(0);
  expect(mountedAfterLoad).toBeLessThan(60);

  // The previously top-visible message must still sit near the top edge after
  // the prepend (scroll-delta compensation in ChatPage). `rows.first()` is not
  // a valid anchor: overscan rows mount before the visible window.
  const topTextBefore = await topRowBefore.innerText();
  const anchoredContent = topTextBefore.split('\n').at(-1)?.trim() ?? '';
  expect(anchoredContent).not.toBe('');
  const anchored = page.getByText(anchoredContent, { exact: false }).first();
  await expect(anchored).toBeVisible();
  const anchoredBox = (await anchored.boundingBox()) ?? { y: Infinity, height: 0 };
  const viewportBox = (await page.locator('[data-component="chat-viewport"]').boundingBox()) ?? {
    y: 0,
    height: 0,
  };
  expect(anchoredBox.y).toBeLessThan(viewportBox.y + 200);
});
