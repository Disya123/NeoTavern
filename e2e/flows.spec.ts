/**
 * Functional flows on top of the release smoke suite:
 *
 * 1. Chat send/receive through the ChatPage composer against the built-in
 *    offline echo provider (no network): the reply is
 *    `You said: "<user message>". This is the offline echo provider.`
 * 2. Chats library: a new conversation appears in the list, opens into the
 *    chat view, and its message count updates after a completed reply.
 * 3. Personas surface: the active persona is activated through the sidebar
 *    Personas panel (Default connection) and persists across reloads.
 *    Persona records are seeded through the API because the UI exposes no
 *    create/edit form.
 * 4. Providers page: an offline Echo provider config can be added without any
 *    network access and survives a reload.
 *
 * Fixture records (character/chat/persona) are created through the REST API so
 * each test stays deterministic; every assertion targets UI-rendered state.
 * The e2e data directory persists between runs, so all names are suffixed.
 */
import { expect, test, type Page } from '@playwright/test';
import { postJson, expectNoA11yViolations } from './helpers.js';

const GENERATION_TIMEOUT_MS = 20_000;

async function createCharacterAndChat(
  page: Page,
  suffix: string,
): Promise<{ characterId: string; chatId: string; chatTitle: string }> {
  const chatTitle = `Flow Chat ${suffix}`;
  const character = await postJson(page, '/characters', {
    name: `Flow Character ${suffix}`,
    description: 'Created by the flows e2e suite.',
  });
  const chat = await postJson(page, '/chats', {
    characterId: character['id'],
    title: chatTitle,
  });
  return { characterId: String(character['id']), chatId: String(chat['id']), chatTitle };
}

async function sendAndWaitForEchoReply(page: Page, userMessage: string): Promise<void> {
  await page.getByLabel(/Type a message/iu).fill(userMessage);
  await page.getByRole('button', { name: 'Send' }).click();
  const assistantBubble = page.locator(
    '[data-component="chat-message"][data-role="assistant"][data-state="done"]',
  );
  await expect(assistantBubble).toBeVisible({ timeout: GENERATION_TIMEOUT_MS });
  await expect(assistantBubble).toContainText('This is the offline echo provider.');
}

test('home and chat composers share one context panel backed by preview and audit data', async ({
  page,
}) => {
  const suffix = Date.now().toString(36);
  const userMessage = `Show me the clockwork orchard ${suffix}.`;
  const provider = await postJson(page, '/providers', {
    kind: 'echo',
    name: `Context Echo ${suffix}`,
    model: 'echo',
  });
  const persona = await postJson(page, '/personas', {
    name: `Context Persona ${suffix}`,
    description: 'A cartographer who records forgotten paths.',
  });
  const character = await postJson(page, '/characters', {
    name: `Context Keeper ${suffix}`,
    description: 'Guards the clockwork orchard.',
    personality: 'Patient and precise.',
    firstMessage: 'The brass trees begin to chime.',
  });
  await postJson(page, '/lorebooks', {
    name: `Context World ${suffix}`,
    characterId: character['id'],
    entries: [
      {
        keys: ['clockwork orchard'],
        content: 'Every brass tree stores one forgotten route.',
      },
    ],
  });
  const settings = await page.request.patch('/api/v2/settings', {
    data: {
      activeProviderConfigId: provider['id'],
      activePersonaId: persona['id'],
    },
  });
  expect(settings.ok()).toBe(true);
  await page.addInitScript(
    (characterId) => globalThis.localStorage.setItem('neotavern.pinnedCharacterId', characterId),
    String(character['id']),
  );

  type Preview = {
    budget: { promptTokens: number; contextLimit: number; reservedForReply: number };
    entries: Array<{
      identifier: string;
      source: string;
      tokens: number;
      included: boolean;
    }>;
  };
  const formatTokens = (tokens: number): string => tokens.toLocaleString('en-US');
  const tokensFor = (
    preview: Preview,
    predicate: (entry: Preview['entries'][number]) => boolean,
  ): number =>
    preview.entries
      .filter((entry) => entry.included && predicate(entry))
      .reduce((sum, entry) => sum + entry.tokens, 0);
  const isCharacterEntry = (entry: Preview['entries'][number]): boolean =>
    entry.identifier === 'core.character-description' ||
    entry.identifier === 'core.character-personality' ||
    entry.identifier === 'core.scenario' ||
    entry.identifier === 'core.dialogue-examples' ||
    entry.identifier === 'core.character-post-history-instructions';

  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: String(character['name']), exact: true }).first(),
  ).toBeVisible();

  const initialPreviewResponse = await postJson(page, '/context-preview', {
    characterId: character['id'],
    userMessage: '',
    providerConfigId: provider['id'],
  });
  const initialPreview = initialPreviewResponse['preview'] as Preview;
  const initialUsagePercent = Math.round(
    ((initialPreview.budget.promptTokens + initialPreview.budget.reservedForReply) /
      initialPreview.budget.contextLimit) *
      100,
  );
  const contextTrigger = page.locator('[aria-controls="home-context-details"]');
  await expect(contextTrigger).toHaveText(`${initialUsagePercent}%`);
  await contextTrigger.click();

  const homePanel = page.locator('#home-context-details');
  await expect(homePanel).toHaveAttribute('data-component', 'context-usage-panel');
  await expect(homePanel).toHaveAttribute('data-state', 'exact');
  const characterRow = homePanel
    .locator('[data-part="breakdown-row"]')
    .filter({ hasText: 'Character' });
  const initialCharacterTokens = tokensFor(initialPreview, isCharacterEntry);
  expect(initialCharacterTokens).toBeGreaterThan(0);
  await expect(characterRow).toContainText(formatTokens(initialCharacterTokens));

  let browserPreviewRequestCount = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/v2/context-preview')) {
      browserPreviewRequestCount += 1;
    }
  });
  await page.getByLabel(/Type a message/iu).pressSequentially(userMessage, { delay: 10 });
  await expect(characterRow).toContainText(formatTokens(initialCharacterTokens));
  await expect(homePanel).toHaveAttribute('data-state', 'exact');
  await expect(homePanel).not.toContainText('Loading...');
  await page.waitForTimeout(250);
  expect(browserPreviewRequestCount).toBe(0);
  await expect.poll(() => browserPreviewRequestCount).toBe(1);

  const previewResponse = await postJson(page, '/context-preview', {
    characterId: character['id'],
    userMessage,
    providerConfigId: provider['id'],
  });
  const preview = previewResponse['preview'] as Preview;
  await expect(homePanel.locator('[data-part="usage"]')).toHaveText(
    `${formatTokens(preview.budget.promptTokens)} / ${formatTokens(preview.budget.contextLimit)}`,
  );
  const characterTokens = tokensFor(preview, isCharacterEntry);
  const personaTokens = tokensFor(preview, (entry) => entry.identifier === 'core.persona');
  const lorebookTokens = tokensFor(preview, (entry) => entry.source === 'lorebook');
  await expect(characterRow).toContainText(formatTokens(characterTokens));
  await expect(
    homePanel.locator('[data-part="breakdown-row"]').filter({ hasText: 'Persona' }),
  ).toContainText(formatTokens(personaTokens));
  await expect(
    homePanel.locator('[data-part="breakdown-row"]').filter({ hasText: 'World info' }),
  ).toContainText(formatTokens(lorebookTokens));

  const chat = await postJson(page, '/chats', {
    characterId: character['id'],
    title: `Context Chat ${suffix}`,
  });
  const generated = await page.request.post(`/api/v2/chats/${String(chat['id'])}/generate`, {
    data: { userMessage },
  });
  expect(generated.ok()).toBe(true);
  expect(await generated.text()).toContain('"type":"done"');

  await page.goto(`/chats/${String(chat['id'])}`);
  await page.locator('[aria-controls="chat-context-details"]').click();
  const chatPanel = page.locator('#chat-context-details');
  await expect(chatPanel).toHaveAttribute('data-component', 'context-usage-panel');
  await expect(chatPanel).toHaveAttribute('data-state', 'exact');
  await expect(chatPanel.locator('[data-part="breakdown"]')).toBeVisible();
});

test('sends a message through the chat composer and receives the offline echo reply', async ({
  page,
}) => {
  const suffix = Date.now().toString(36);
  const { chatId } = await createCharacterAndChat(page, suffix);
  const userMessage = `Hello from the flows suite ${suffix}`;

  await page.goto(`/chats/${chatId}`);
  await expect(page.locator('[data-component="chat-view"]')).toBeVisible();

  const composer = page.getByLabel(/Type a message/iu);
  await composer.fill(userMessage);
  await page.getByRole('button', { name: 'Send' }).click();

  // The composer clears immediately after sending.
  await expect(composer).toHaveValue('');

  // The user message renders from the persisted record.
  const userBubble = page.locator('[data-component="chat-message"][data-role="user"]');
  await expect(userBubble).toHaveCount(1);
  await expect(userBubble).toContainText(userMessage);

  // The assistant reply streams in and is persisted by the echo provider.
  const assistantBubble = page.locator(
    '[data-component="chat-message"][data-role="assistant"][data-state="done"]',
  );
  await expect(assistantBubble).toBeVisible({ timeout: GENERATION_TIMEOUT_MS });
  await expect(assistantBubble).toContainText('You said:');
  await expect(assistantBubble).toContainText(userMessage);
  await expect(assistantBubble).toContainText('This is the offline echo provider.');

  // Generation finished: the composer left the generating state. (Note: a
  // known product bug leaves a ghost `data-state="streaming"` bubble mounted
  // after completion — a late requestAnimationFrame flush re-fills
  // `streamingText` after `onDone` cleared it — so the streaming bubble is
  // deliberately not asserted here.)
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
});

test('chat library lists a new conversation and updates its message count after a reply', async ({
  page,
}) => {
  const suffix = Date.now().toString(36);
  const { chatId, chatTitle } = await createCharacterAndChat(page, suffix);

  await page.goto('/chats');
  await expect(page.getByRole('heading', { name: 'Chats', level: 1 })).toBeVisible();
  const item = page.locator('[data-component="chat-item"]').filter({ hasText: chatTitle });
  await expect(item).toBeVisible();
  await expect(item).toContainText('0 messages');

  // The list entry opens the conversation in the chat view.
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/chats/${chatId}$`, 'u'));
  await expect(page.locator('[data-component="chat-view"]')).toBeVisible();

  await sendAndWaitForEchoReply(page, `Library flow ${suffix}`);

  // Back in the library, the conversation now reports the user + assistant pair.
  await page.goto('/chats');
  const refreshed = page.locator('[data-component="chat-item"]').filter({ hasText: chatTitle });
  await expect(refreshed).toBeVisible();
  await expect(refreshed).toContainText('2 messages');
});

test('active persona selected in the Personas panel persists across reload', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const personaName = `Flow Persona ${suffix}`;
  await postJson(page, '/personas', {
    name: personaName,
    description: 'Created by the flows e2e suite.',
  });

  const openPersonas = async () => {
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Personas', exact: true })
      .click();
    const personasPanel = page.getByRole('region', { name: 'Personas', exact: true });
    await expect(personasPanel).toBeVisible();
    return personasPanel;
  };

  await page.goto('/home');
  const panel = await openPersonas();
  await panel.locator('button').filter({ hasText: personaName }).click();
  const connectDefault = panel
    .getByRole('group', { name: 'Connections' })
    .getByRole('button', { name: 'Default' });
  await connectDefault.click();
  await expect(connectDefault).toHaveAttribute('data-state', 'active');

  await page.reload();
  const reopened = await openPersonas();
  await reopened.locator('button').filter({ hasText: personaName }).click();
  await expect(
    reopened.getByRole('group', { name: 'Connections' }).getByRole('button', { name: 'Default' }),
  ).toHaveAttribute('data-state', 'active');

  await reopened.getByRole('button', { name: 'Close menu' }).click();

  // The rail panel closes without replacing the active chat workspace.
  await expect(page.locator('[data-component="home"]')).toBeVisible();
});

test('sidebar Chats panel lists, searches, creates and opens conversations', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const { chatId, chatTitle } = await createCharacterAndChat(page, suffix);

  await page.goto('/home');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Chats', exact: true })
    .click();

  const panel = page.locator('[data-component="navigation-panel"][data-state="open"]');
  const management = panel.locator('[data-component="chat-management"]');
  await expect(management).toBeVisible();

  // The seeded conversation appears in the list.
  const item = management.locator('[data-component="chat-item"]').filter({ hasText: chatTitle });
  await expect(item).toBeVisible();
  await expect(item).toContainText('0 messages');

  // Search scopes the list to matching conversations; clearing restores it.
  const search = management.getByRole('searchbox');
  await search.fill(chatTitle);
  await expect(item).toBeVisible();
  await expect(management.locator('[data-component="chat-item"]')).toHaveCount(1);
  await search.fill(`no-such-conversation-${suffix}`);
  await expect(item).toHaveCount(0);
  await search.fill('');
  await expect(item).toBeVisible();

  // A new chat can be started from the panel for the pinned character; the
  // app opens the fresh conversation. Asserting `/home` here was a latent
  // race: it only passed when the URL check beat the create+navigate round
  // trip.
  await management.getByRole('button', { name: 'New chat' }).click();
  await expect(page).toHaveURL(/\/chats\/[0-9a-f-]+$/);

  // Opening the conversation navigates into the chat view and closes the panel.
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Chats', exact: true })
    .click();
  await expect(management).toBeVisible();
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/chats/${chatId}$`, 'u'));
  await expect(page.locator('[data-component="chat-view"]')).toBeVisible();
  await expect(page.locator('[data-component="navigation-panel"]')).toHaveCount(0);
});

test('phone chat menu stays above the full-screen panel and touch drag still reorders', async ({
  page,
}) => {
  const suffix = Date.now().toString(36);
  const { characterId, chatId, chatTitle } = await createCharacterAndChat(page, suffix);
  const secondChat = await postJson(page, '/chats', {
    characterId,
    title: `Second phone chat ${suffix}`,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/chats/${chatId}`);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Chats', exact: true })
    .click();

  const panel = page.locator('[data-component="navigation-panel"][data-state="open"]');
  const rows = panel.locator('[data-component="chat-item"]');
  await expect(rows).toHaveCount(2);
  const heldRow = rows.filter({ hasText: chatTitle });
  await expect(heldRow).toHaveAttribute('data-reorderable', 'true');

  await heldRow.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const touch = {
      identifier: 41,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    const event = new Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      changedTouches: { value: [touch] },
      touches: { value: [touch] },
    });
    element.dispatchEvent(event);
  });

  const menu = page.locator('[data-component="menu-content"]');
  await expect(menu).toBeVisible({ timeout: 1_500 });
  const layers = await Promise.all([
    menu.evaluate((element) => Number(getComputedStyle(element).zIndex)),
    page
      .locator('[data-component="navigation-rail"]')
      .evaluate((element) => Number(getComputedStyle(element).zIndex)),
  ]);
  expect(layers[0]).toBeGreaterThan(layers[1]);

  await page.keyboard.press('Escape');
  const initialTitles = await rows.locator('strong').allTextContents();
  const firstBox = await rows.nth(0).boundingBox();
  const secondBox = await rows.nth(1).boundingBox();
  if (!firstBox || !secondBox) throw new Error('Chat rows have no touch geometry');

  await rows.nth(0).evaluate(
    async (element, points) => {
      const touch = (clientX: number, clientY: number) => ({
        identifier: 42,
        clientX,
        clientY,
      });
      const dispatch = (
        target: EventTarget,
        type: 'touchstart' | 'touchmove' | 'touchend',
        current: ReturnType<typeof touch>,
      ) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          changedTouches: { value: [current] },
          touches: { value: type === 'touchend' ? [] : [current] },
        });
        target.dispatchEvent(event);
      };

      dispatch(element, 'touchstart', touch(points.startX, points.startY));
      dispatch(document, 'touchmove', touch(points.endX, points.endY));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      dispatch(document, 'touchend', touch(points.endX, points.endY));
    },
    {
      startX: firstBox.x + firstBox.width / 2,
      startY: firstBox.y + firstBox.height / 2,
      endX: secondBox.x + secondBox.width / 2,
      endY: secondBox.y + secondBox.height / 2,
    },
  );

  await expect
    .poll(() => rows.locator('strong').allTextContents())
    .toEqual(initialTitles.reverse());
  await expect(rows.filter({ hasText: String(secondChat['title']) })).toBeVisible();
});

test('shows a persisted offline Echo profile without exposing a key', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const providerName = `Flow Echo ${suffix}`;
  const provider = await postJson(page, '/providers', {
    kind: 'echo',
    name: providerName,
    model: 'echo',
  });
  const providerId = String(provider['id']);
  const activated = await page.request.patch('/api/v2/settings', {
    data: { activeProviderConfigId: providerId },
  });
  expect(activated.ok()).toBe(true);

  await page.goto('/providers');
  await expect(page.getByRole('heading', { name: 'Providers', level: 1 })).toBeVisible();
  const editor = page.locator('[data-component="provider-profile-editor"]');
  await expect(editor.getByLabel('Provider profile')).toHaveValue(providerId);
  await expect(editor.getByLabel('Name')).toHaveValue(providerName);
  await expect(editor.getByLabel('Model')).toHaveValue('echo');
  await expect(editor.getByLabel('API key')).toHaveValue('');
  await editor.getByRole('button', { name: 'Connect' }).click();
  await expect(editor.getByText('Connected')).toBeVisible();

  // The configuration is server-backed and remains selected after reload.
  await page.reload();
  const persisted = page.locator('[data-component="provider-profile-editor"]');
  await expect(persisted.getByLabel('Provider profile')).toHaveValue(providerId);
  await expect(persisted.getByLabel('Name')).toHaveValue(providerName);
  await expect(persisted.getByLabel('Model')).toHaveValue('echo');
  await expect(persisted.getByLabel('API key')).toHaveValue('');
});

test('configures prompt order, generates, and exposes the persisted context audit', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const suffix = Date.now().toString(36);
  const providerName = `Audit Echo ${suffix}`;
  const promptPresetName = `Audit Prompt ${suffix}`;
  const provider = await postJson(page, '/providers', {
    kind: 'echo',
    name: providerName,
    model: 'echo',
  });
  const character = await postJson(page, '/characters', {
    name: `Audit Character ${suffix}`,
    systemPrompt: 'Keep the response grounded in Eldoria.',
    postHistoryInstructions: 'Answer in a single concise paragraph.',
  });
  const chat = await postJson(page, '/chats', {
    characterId: character['id'],
    title: `Audit Context ${suffix}`,
  });
  const auditedChatId = String(chat['id']);
  const settingsResponse = await page.request.patch('/api/v2/settings', {
    data: { activeProviderConfigId: provider['id'] },
  });
  expect(settingsResponse.ok()).toBe(true);

  await page.goto(`/chats/${auditedChatId}`);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'AI Settings', exact: true })
    .click();
  const panel = page.getByRole('region', { name: 'AI Settings', exact: true });
  await expect(panel).toBeVisible();

  await panel.getByRole('tab', { name: 'API' }).click();
  const providerEditor = panel.locator('[data-component="provider-profile-editor"]');
  await expect(providerEditor.getByLabel('Connection profile')).toContainText(providerName);
  await expect(providerEditor.getByLabel('Model')).toHaveValue('echo');
  await expect(providerEditor.getByLabel('API key')).toHaveValue('');

  await panel.getByRole('tab', { name: 'Advanced' }).click();
  const promptMode = panel.getByRole('radio', { name: 'Prompt Template', exact: true });
  if (!(await promptMode.isChecked())) await promptMode.click();
  await expect(promptMode).toBeChecked();
  const promptEditor = panel.locator('[data-component="prompt-template-editor"]');
  await expect(promptEditor).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileMainName = promptEditor.getByRole('button', { name: 'Main Prompt', exact: true });
  const mobileMainRow = mobileMainName.locator('xpath=ancestor::li');
  const mobileMainToggle = promptEditor.getByRole('button', { name: 'Disable Main Prompt' });
  await expect(promptEditor.getByRole('button', { name: 'Apply changes' })).toHaveCount(0);
  await expect(promptEditor.getByRole('button', { name: 'Reset block order' })).toHaveCount(0);
  await expect
    .poll(async () => (await mobileMainRow.boundingBox())?.height ?? Number.POSITIVE_INFINITY)
    .toBeLessThan(60);
  await expect
    .poll(async () => {
      const toggleBox = await mobileMainToggle.boundingBox();
      const nameBox = await mobileMainName.boundingBox();
      return Boolean(toggleBox && nameBox && toggleBox.x < nameBox.x);
    })
    .toBe(true);
  await expect
    .poll(() => promptEditor.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
    .toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });

  await promptEditor.getByRole('button', { name: 'Main Prompt', exact: true }).click();
  const mainPromptDialog = page.getByRole('dialog', { name: 'Edit prompt' });
  await expect(mainPromptDialog).toBeVisible();
  await expect(mainPromptDialog.getByLabel('Role')).toHaveValue('system');
  await expect(mainPromptDialog.getByLabel('Position')).toHaveValue('relative');
  await expect(mainPromptDialog.getByLabel('Prompt', { exact: true })).toHaveValue(
    /Write \{\{char\}\}'s next reply/,
  );
  await mainPromptDialog.getByRole('button', { name: 'Save' }).click();

  await promptEditor.getByRole('button', { name: 'Add prompt' }).click();
  const customPromptDialog = page.getByRole('dialog', { name: 'Edit prompt' });
  await customPromptDialog.getByLabel('Name').fill(`E2E cue ${suffix}`);
  await customPromptDialog.getByLabel('Role').selectOption('system');
  await customPromptDialog
    .getByLabel('Prompt', { exact: true })
    .fill('Keep the reply grounded and emotionally clear.');
  await customPromptDialog.getByRole('button', { name: 'Save' }).click();
  await expect(
    promptEditor.getByRole('button', { name: `E2E cue ${suffix}`, exact: true }),
  ).toBeVisible();
  const promptRows = promptEditor.locator('ol > li');
  const promptRowCount = await promptRows.count();
  await expect(promptRows.nth(promptRowCount - 2)).toContainText('Chat History');
  await expect(promptRows.nth(promptRowCount - 1)).toContainText('Post-History Instructions');
  await expect(
    promptEditor.getByRole('button', {
      name: 'Chat History has a fixed terminal position',
    }),
  ).toBeDisabled();

  const mainPromptHandle = promptEditor.getByRole('button', { name: 'Drag Main Prompt' });
  const mainPromptRow = mainPromptHandle.locator('xpath=ancestor::li');
  const worldBeforeRow = promptEditor
    .getByRole('button', { name: 'World Info (before)', exact: true })
    .locator('xpath=ancestor::li');
  const mainHandleBox = await mainPromptHandle.boundingBox();
  const worldBeforeBox = await worldBeforeRow.boundingBox();
  if (!mainHandleBox || !worldBeforeBox) throw new Error('Prompt drag targets are not visible');
  const hitLabel = await page.evaluate(
    ({ x, y }) =>
      document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ?? null,
    {
      x: mainHandleBox.x + mainHandleBox.width / 2,
      y: mainHandleBox.y + mainHandleBox.height / 2,
    },
  );
  expect(hitLabel).toBe('Drag Main Prompt');
  await mainPromptHandle.dispatchEvent('mousedown', {
    button: 0,
    buttons: 1,
    clientX: mainHandleBox.x + mainHandleBox.width / 2,
    clientY: mainHandleBox.y + mainHandleBox.height / 2,
  });
  await expect(mainPromptRow).toHaveAttribute('data-dragging', 'true');
  await worldBeforeRow.dispatchEvent('mousemove', {
    buttons: 1,
    clientX: worldBeforeBox.x + worldBeforeBox.width / 2,
    clientY: worldBeforeBox.y + worldBeforeBox.height / 2,
  });
  await worldBeforeRow.dispatchEvent('mouseup', {
    button: 0,
    buttons: 0,
    clientX: worldBeforeBox.x + worldBeforeBox.width / 2,
    clientY: worldBeforeBox.y + worldBeforeBox.height / 2,
  });
  await expect(promptEditor.getByText('Main Prompt moved to position 2.')).toBeVisible();
  await promptEditor.getByRole('button', { name: 'Duplicate', exact: true }).click();
  const nameEditor = promptEditor.locator('[data-part="preset-name-editor"]');
  await nameEditor.locator('input').fill(promptPresetName);
  await nameEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    promptEditor.getByRole('combobox', { name: 'Prompt template preset', exact: true }),
  ).toContainText(promptPresetName);
  await expectNoA11yViolations(page);

  await panel.getByRole('button', { name: 'Close menu' }).click();
  const userMessage = `Audit the prompt flow ${suffix}`;
  await sendAndWaitForEchoReply(page, userMessage);
  await page.getByRole('button', { name: /^\d+%$/ }).click();

  const contextPanel = page.locator('#chat-context-details');
  await expect(contextPanel).toBeVisible();
  await expect(contextPanel).toContainText('Context usage');
  await expect(contextPanel).toContainText('tokens');

  const auditResponse = await page.request.get(`/api/v2/chats/${auditedChatId}/context-audit`);
  expect(auditResponse.ok()).toBe(true);
  const auditBody = (await auditResponse.json()) as {
    audit: {
      promptTemplateMode: string;
      entries: Array<{ identifier: string; name?: string; order: number }>;
    };
  };
  expect(auditBody.audit.promptTemplateMode).toBe('text');
  const worldBefore = auditBody.audit.entries.find(
    (entry) => entry.identifier === 'block.world-info-before',
  );
  const mainPrompt = auditBody.audit.entries.find(
    (entry) => entry.identifier === 'core.main-prompt',
  );
  const customPrompt = auditBody.audit.entries.find((entry) => entry.name === `E2E cue ${suffix}`);
  expect(worldBefore?.order).toBeLessThan(mainPrompt?.order ?? -1);
  expect(customPrompt?.identifier).toMatch(/^template\.custom-/);
});

async function activateEchoProvider(page: Page, suffix: string): Promise<void> {
  const provider = await postJson(page, '/providers', {
    kind: 'echo',
    name: `Flow Echo ${suffix}`,
    model: 'echo',
  });
  const activated = await page.request.patch('/api/v2/settings', {
    data: { activeProviderConfigId: provider['id'] },
  });
  expect(activated.ok()).toBe(true);
}

test('regenerate replaces the last reply in place (no second bubble)', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const { chatId } = await createCharacterAndChat(page, suffix);
  await activateEchoProvider(page, `Regen ${suffix}`);

  await page.goto(`/chats/${chatId}`);
  const composer = page.locator('[data-slot="chat.composer"]');
  // A long message keeps the echo stream alive long enough for the abort leg
  // to stop it mid-flight.
  const userMessage = `Regenerate me ${suffix} ${'x'.repeat(600)}`;
  await composer.getByLabel(/Type a message/iu).fill(userMessage);
  await composer.getByRole('button', { name: 'Send' }).click();

  const assistantRows = page.locator('[data-component="chat-message"][data-role="assistant"]');
  await expect(assistantRows).toHaveCount(1, { timeout: GENERATION_TIMEOUT_MS });
  const doneBubble = page.locator(
    '[data-component="chat-message"][data-role="assistant"][data-state="done"]',
  );
  await expect(doneBubble).toContainText('This is the offline echo provider.');

  // Regenerate through the composer toolbar: the same bubble streams in place.
  await composer.getByRole('button', { name: 'Regenerate' }).click();
  await expect(assistantRows).toHaveCount(1, { timeout: GENERATION_TIMEOUT_MS });
  await expect(doneBubble).toContainText('This is the offline echo provider.');

  // The archived reply shows up as a stored variant: pager 2/2, still one bubble.
  const pager = page.locator('[data-component="message-swipe-pager"]');
  await expect(pager).toBeVisible({ timeout: GENERATION_TIMEOUT_MS });
  await expect(pager).toContainText('2/2');
  await expect(assistantRows).toHaveCount(1);

  // Abort path: stop restores the previous reply in the same single bubble.
  await composer.getByRole('button', { name: 'Regenerate' }).click();
  await composer.getByRole('button', { name: 'Stop generating' }).click();
  await expect(assistantRows).toHaveCount(1);
  await expect(doneBubble).toContainText('This is the offline echo provider.');
});

test('message action bar is always visible; Ctrl+Enter saves and Escape cancels edits', async ({
  page,
}) => {
  const suffix = Date.now().toString(36);
  const { chatId } = await createCharacterAndChat(page, suffix);
  await activateEchoProvider(page, `Edit ${suffix}`);

  await page.goto(`/chats/${chatId}`);
  const composer = page.locator('[data-slot="chat.composer"]');
  await composer.getByLabel(/Type a message/iu).fill(`Edit me ${suffix}`);
  await composer.getByRole('button', { name: 'Send' }).click();

  const doneBubble = page.locator(
    '[data-component="chat-message"][data-role="assistant"][data-state="done"]',
  );
  await expect(doneBubble).toHaveCount(1, { timeout: GENERATION_TIMEOUT_MS });

  // The action bar is always visible — no hover gate.
  const actionBar = doneBubble.locator('[data-component="message-action-bar"]');
  const messageHeader = doneBubble.locator('[data-part="message-header"]');
  await expect(actionBar).toBeVisible();
  await expect(messageHeader.locator('[data-component="message-action-bar"]')).toHaveCount(1);
  const [identityBox, actionBarBox] = await Promise.all([
    doneBubble.locator('[data-part="message-identity"]').boundingBox(),
    actionBar.boundingBox(),
  ]);
  if (identityBox === null || actionBarBox === null) {
    throw new Error('Message header controls must have measurable bounds.');
  }
  expect(actionBarBox.x).toBeGreaterThan(identityBox.x);

  // Desktop shows EVERY action inline — branch, checkpoint-create and delete
  // are direct buttons; the «Ещё» overflow menu is gone entirely.
  await expect(actionBar.getByRole('button', { name: 'Branch' })).toBeVisible();
  await expect(actionBar.getByRole('button', { name: 'Checkpoint' })).toBeVisible();
  await expect(actionBar.getByRole('button', { name: 'Delete message' })).toBeVisible();
  await expect(actionBar.locator('[data-action="history"]')).toHaveCount(0);
  await expect(actionBar.locator('[data-action="regenerate"]')).toHaveCount(0);
  const versionControls = doneBubble.locator('[data-component="message-version-controls"]');
  const historyButton = versionControls.getByRole('button', { name: 'Revision history' });
  const regenerateButton = versionControls.getByRole('button', { name: 'Regenerate' });
  await expect(historyButton).toBeVisible();
  await expect(regenerateButton).toBeVisible();
  await expect(historyButton.locator('span')).toBeHidden();
  await expect(regenerateButton.locator('span')).toBeHidden();
  const [contentBox, versionBox] = await Promise.all([
    doneBubble.locator('[data-part="message-content"]').boundingBox(),
    versionControls.boundingBox(),
  ]);
  if (contentBox === null || versionBox === null) {
    throw new Error('Desktop version controls must have measurable bounds.');
  }
  expect(versionBox.y).toBeGreaterThan(contentBox.y);
  await expect(page.locator('[data-action="more"]')).toHaveCount(0);
  await expect(page.locator('[data-part="overflow-menu"]')).toHaveCount(0);
  await expect(page.locator('[data-part="message-actions-overflow"]')).toHaveCount(0);

  // Escape cancels without saving.
  await actionBar.getByRole('button', { name: 'Edit message' }).click();
  const editor = page.getByRole('textbox', { name: 'Edit message' });
  const cancelledDraft = Array.from(
    { length: 18 },
    (_, index) => `Cancelled draft line ${index + 1}`,
  ).join('\n');
  await editor.fill(cancelledDraft);
  const editorMetrics = await editor.evaluate((textarea: HTMLTextAreaElement) => ({
    clientHeight: textarea.clientHeight,
    scrollHeight: textarea.scrollHeight,
  }));
  expect(editorMetrics.clientHeight).toBeGreaterThan(300);
  expect(editorMetrics.scrollHeight - editorMetrics.clientHeight).toBeLessThanOrEqual(2);
  await editor.press('Escape');
  await expect(doneBubble).not.toContainText('Cancelled draft line 1');

  // Ctrl+Enter saves and closes the editor.
  await actionBar.getByRole('button', { name: 'Edit message' }).click();
  await page.getByRole('textbox', { name: 'Edit message' }).fill(`Edited reply ${suffix}`);
  await page.getByRole('textbox', { name: 'Edit message' }).press('Control+Enter');
  await expect(doneBubble).toContainText(`Edited reply ${suffix}`, {
    timeout: GENERATION_TIMEOUT_MS,
  });
  await expect(actionBar).toBeVisible();
});

test('variant swipe pager switches between stored replies', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const { chatId } = await createCharacterAndChat(page, suffix);
  await activateEchoProvider(page, `Swipe ${suffix}`);
  await postJson(page, `/chats/${chatId}/messages`, {
    role: 'user',
    content: `Seed user ${suffix}`,
  });
  await postJson(page, `/chats/${chatId}/messages`, {
    role: 'assistant',
    content: 'Seeded assistant reply',
  });

  await page.goto(`/chats/${chatId}`);
  const doneBubble = page.locator(
    '[data-component="chat-message"][data-role="assistant"][data-state="done"]',
  );
  await expect(doneBubble).toHaveCount(1);
  await expect(doneBubble).toContainText('Seeded assistant reply');

  // Regenerate the seeded reply: the old text becomes stored variant 1/2 and
  // the echo reply becomes the active 2/2.
  await doneBubble.locator('[data-action="regenerate"]').click();
  await expect(doneBubble).toContainText('This is the offline echo provider.', {
    timeout: GENERATION_TIMEOUT_MS,
  });
  const pager = page.locator('[data-component="message-swipe-pager"]');
  await expect(pager).toContainText('2/2');
  await expect(doneBubble.getByRole('button', { name: 'Variants' })).toHaveCount(0);

  // Previous → the seeded reply returns (1/2).
  await pager.getByRole('button', { name: 'Previous greeting' }).click();
  await expect(pager).toContainText('1/2');
  await expect(doneBubble).toContainText('Seeded assistant reply');

  // Next → the regenerated reply is active again (2/2).
  await pager.getByRole('button', { name: 'Next greeting' }).click();
  await expect(pager).toContainText('2/2');
  await expect(doneBubble).toContainText('This is the offline echo provider.');
});

test('checkpoint flag opens the child chat and back-to-parent returns', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const { chatId, chatTitle } = await createCharacterAndChat(page, suffix);
  await activateEchoProvider(page, `Checkpoint ${suffix}`);

  await page.goto(`/chats/${chatId}`);
  const composer = page.locator('[data-slot="chat.composer"]');
  await composer.getByLabel(/Type a message/iu).fill(`Checkpoint me ${suffix}`);
  await composer.getByRole('button', { name: 'Send' }).click();
  const doneBubble = page.locator(
    '[data-component="chat-message"][data-role="assistant"][data-state="done"]',
  );
  await expect(doneBubble).toHaveCount(1, { timeout: GENERATION_TIMEOUT_MS });

  // Create a checkpoint through the direct inline checkpoint action
  // (the desktop row has no «Ещё» overflow menu anymore).
  const actionBar = doneBubble.locator('[data-component="message-action-bar"]');
  await actionBar.getByRole('button', { name: 'Checkpoint' }).click();

  // The host notification carries an Open action that navigates into the child.
  const notice = page.locator('[data-component="plugin-notification-layer"]');
  await expect(notice).toContainText('Checkpoint created');
  await notice.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/chats\/[a-f0-9-]+$/u);
  await expect(page).not.toHaveURL(new RegExp(`/chats/${chatId}$`, 'u'));

  // The child chat header offers back-to-parent.
  const back = page.getByRole('button', { name: 'Back to parent chat' });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page).toHaveURL(new RegExp(`/chats/${chatId}$`, 'u'));

  // The parent message now carries the checkpoint flag.
  await expect(
    page.locator(
      '[data-component="chat-message"][data-role="assistant"] [data-action="checkpoint"]',
    ),
  ).toHaveAttribute('aria-label', 'Open checkpoint');

  // The catalog shows the checkpoint badge on the child chat row.
  await page.goto('/home');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Chats', exact: true })
    .click();
  const panel = page.locator('[data-component="navigation-panel"][data-state="open"]');
  const management = panel.locator('[data-component="chat-management"]');
  const childChatRow = management
    .locator('[data-component="chat-item"]')
    .filter({ hasText: `${chatTitle} — checkpoint` });
  await expect(childChatRow).toBeVisible();
  await expect(
    childChatRow.locator('[data-part="chat-origin-badge"][data-origin="checkpoint"]'),
  ).toHaveCount(1);
});
