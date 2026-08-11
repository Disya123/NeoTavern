/**
 * Chat viewport scroll-pin coverage (regression for the "chat opens at the
 * greeting" + "user message invisible during generation" report):
 *
 * 1. Switching chats in-app (SPA navigation, query-cache hit, equal message
 *    counts) pins the new conversation to its NEWEST message — the old
 *    `ordered.length`-keyed scroll effect never re-fired on the cache hit.
 * 2. Generation pins the viewport to the ABSOLUTE bottom (the sticky composer
 *    lives inside the scroll container, so an endRef-block-end pin parks the
 *    newest content behind it) and shows the user's message instantly via the
 *    optimistic pending bubble, with no duplicate after confirmation.
 */
import { expect, test, type Page } from '@playwright/test';
import { postJson } from './helpers.js';

const GENERATION_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 120_000;
const MESSAGES_PER_CHAT = 30;

// Both chats must belong to ONE character: the sidebar Chats panel filters by
// the current chat's character, so a per-chat character would hide the other.
async function seedChatPair(page: Page, suffix: string): Promise<{ chatA: string; chatB: string }> {
  const character = await postJson(page, '/characters', {
    name: `Scroll Character ${suffix}`,
    description: 'Seeded by the chat-scroll e2e suite.',
  });
  const chatA = await postJson(page, '/chats', {
    characterId: character['id'],
    title: `Scroll A ${suffix}`,
  });
  const chatB = await postJson(page, '/chats', {
    characterId: character['id'],
    title: `Scroll B ${suffix}`,
  });
  for (const [chat, newest] of [
    [chatA, `Newest A ${suffix}`],
    [chatB, `Newest B ${suffix}`],
  ] as const) {
    for (let index = 0; index < MESSAGES_PER_CHAT; index += 1) {
      await postJson(page, `/chats/${chat['id']}/messages`, {
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${index} of ${suffix}`,
      });
    }
    await postJson(page, `/chats/${chat['id']}/messages`, {
      role: 'assistant',
      content: newest,
    });
  }
  return { chatA: String(chatA['id']), chatB: String(chatB['id']) };
}

async function activateEchoProvider(page: Page, suffix: string): Promise<void> {
  const provider = await postJson(page, '/providers', {
    kind: 'echo',
    name: `Scroll Echo ${suffix}`,
    model: 'echo',
  });
  const activated = await page.request.patch('/api/v2/settings', {
    data: { activeProviderConfigId: provider['id'] },
  });
  expect(activated.ok()).toBe(true);
}

async function openChatsPanel(page: Page): Promise<ReturnType<Page['locator']>> {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Chats', exact: true })
    .click();
  return page
    .locator('[data-component="navigation-panel"][data-state="open"]')
    .locator('[data-component="chat-management"]');
}

async function pinnedOffset(page: Page): Promise<number> {
  return page.locator('[data-component="chat-viewport"]').evaluate((element) => {
    return element.scrollHeight - element.scrollTop - element.clientHeight;
  });
}

test('switching chats pins the new conversation to its newest message', async ({ page }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const suffix = Date.now().toString(36);
  const { chatA, chatB } = await seedChatPair(page, suffix);

  // Fresh load pins to the newest message (baseline).
  await page.goto(`/chats/${chatA}`);
  await expect(page.getByText(`Newest A ${suffix}`).first()).toBeVisible();
  await expect(page.locator('[data-index="0"]')).toHaveCount(0);

  // Switch to B (cache miss): B loads and pins.
  let management = await openChatsPanel(page);
  await management
    .locator('[data-component="chat-item"]')
    .filter({ hasText: `Scroll B ${suffix}` })
    .click();
  await expect(page).toHaveURL(new RegExp(`/chats/${chatB}$`, 'u'));
  await expect(page.getByText(`Newest B ${suffix}`).first()).toBeVisible();

  // Read history: scroll B to the top (stick-to-bottom turns off).
  await page.locator('[data-component="chat-viewport"]').evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.locator('[data-index="0"]')).toBeVisible();

  // Switch back to A: served from the query cache with an EQUAL message
  // count — the old scroll effect (keyed on ordered.length) never re-fired
  // and the chat opened at its top. The pin must now be deterministic.
  management = await openChatsPanel(page);
  await management
    .locator('[data-component="chat-item"]')
    .filter({ hasText: `Scroll A ${suffix}` })
    .click();
  await expect(page).toHaveURL(new RegExp(`/chats/${chatA}$`, 'u'));
  await expect(page.getByText(`Newest A ${suffix}`).first()).toBeVisible();
  await expect(page.locator('[data-index="0"]')).toHaveCount(0);
});

test('generation keeps the newest content above the composer and shows the user message instantly', async ({
  page,
}) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const suffix = Date.now().toString(36);
  const marker = `Opt marker ${suffix}`;
  const character = await postJson(page, '/characters', {
    name: `Stream Character ${suffix}`,
    description: 'Seeded by the chat-scroll e2e suite.',
  });
  const chat = await postJson(page, '/chats', {
    characterId: character['id'],
    title: `Stream Chat ${suffix}`,
  });
  for (let index = 0; index < 12; index += 1) {
    await postJson(page, `/chats/${chat['id']}/messages`, {
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `History ${index} of ${suffix}`,
    });
  }
  await activateEchoProvider(page, suffix);

  await page.goto(`/chats/${chat['id']}`);
  await expect(page.getByText(`History 11 of ${suffix}`).first()).toBeVisible();

  // ~320 words: the echo provider streams word-by-word at ~5ms, giving a
  // ~1.6s window for the during-streaming assertions.
  const longMessage = `${marker} ${Array.from({ length: 320 }, (_, index) => `word${index}`).join(' ')}`;
  const composer = page.locator('[data-slot="chat.composer"]');
  await composer.getByLabel(/Type a message/iu).fill(longMessage);
  await composer.getByRole('button', { name: 'Send' }).click();

  // 1. The user's own message is on screen immediately — the optimistic
  //    bubble renders on send and is replaced by the confirmed one as soon
  //    as a refetch lands (within a few hundred ms), so assert the visible
  //    contract, not the transient state. The composer switched to Stop.
  const userBubble = page
    .locator('[data-component="chat-message"][data-role="user"]')
    .filter({ hasText: marker });
  await expect(userBubble).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();

  // 2. The streaming bubble sits fully ABOVE the floating composer (no part
  //    of the generated text is hidden behind the input field).
  await expect
    .poll(
      async () => {
        const stream = page.locator('[data-component="chat-message"][data-state="streaming"]');
        const composerBox = await page.locator('[data-part="composer-sticky"]').boundingBox();
        const streamBox = await stream.boundingBox();
        if (!streamBox || !composerBox) return Number.POSITIVE_INFINITY;
        return streamBox.y + streamBox.height - composerBox.y;
      },
      { timeout: GENERATION_TIMEOUT_MS },
    )
    .toBeLessThanOrEqual(1);

  // 3. While streaming, the viewport is pinned to the absolute bottom.
  await expect
    .poll(() => pinnedOffset(page), { timeout: GENERATION_TIMEOUT_MS })
    .toBeLessThanOrEqual(2);

  // After completion: the confirmed user bubble replaced the optimistic one —
  // exactly one user bubble with the marker — and the viewport stays pinned.
  const doneReply = page
    .locator('[data-component="chat-message"][data-role="assistant"][data-state="done"]')
    .filter({ hasText: 'This is the offline echo provider.' });
  await expect(doneReply).toBeVisible({ timeout: GENERATION_TIMEOUT_MS });
  await expect(
    page.locator('[data-component="chat-message"][data-role="user"]').filter({ hasText: marker }),
  ).toHaveCount(1);
  await expect
    .poll(() => pinnedOffset(page), { timeout: GENERATION_TIMEOUT_MS })
    .toBeLessThanOrEqual(2);
});
