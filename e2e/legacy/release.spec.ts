import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations, postJson, zipBuffer } from '../helpers.js';

async function openRailPanel(page: Page, label: string) {
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('button', { name: label, exact: true }).click();
  const panel = page.getByRole('region', { name: label, exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

async function openSettingsPanel(page: Page) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  const panel = page.getByRole('region', { name: 'Settings', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

test('creates a character and keeps primary navigation functional', async ({ page }) => {
  const characterName = `E2E Character ${Date.now()}`;
  await page.goto('/');

  await expect(page).toHaveURL(/\/home$/);
  const panel = await openRailPanel(page, 'Characters');

  await panel.getByRole('button', { name: 'New', exact: true }).click();
  const createDialog = page.getByRole('dialog', { name: 'New character' });
  await createDialog.getByLabel('Name').fill(characterName);
  await createDialog.getByLabel('Description').fill('Created by the release smoke test.');
  await createDialog.getByRole('button', { name: 'Create' }).click();

  // Creating a character switches the panel to the Edit tab; return to Cards.
  await panel.getByRole('tab', { name: 'Cards' }).click();

  // The created character appears in the Cards list and becomes the pinned one.
  const createdCard = panel
    .locator('[data-part="character-cards"] button')
    .filter({ hasText: characterName });
  await expect(createdCard).toBeVisible();
  await expect(createdCard).toHaveAttribute('data-pinned', 'true');

  await panel.getByRole('button', { name: 'Close menu' }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('heading', { name: characterName }).first()).toBeVisible();
  await expect(page.getByLabel(/Type a message/i)).toBeVisible();

  const settingsPanel = await openSettingsPanel(page);
  await expect(settingsPanel.getByLabel('Language')).toBeVisible();
  await expect(
    settingsPanel.getByRole('heading', { name: 'Diagnostics and recovery' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/home$/);
});

test('character sidebar follows the ST1 cards, edit, advanced and gallery workflow', async ({
  page,
}) => {
  const characterName = `ST1 Panel ${Date.now()}`;
  await page.goto('/home');

  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('button', { name: 'Characters', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Characters', exact: true });

  await expect(panel.getByText('Character Management')).toBeVisible();
  await expect(panel.getByRole('tab')).toHaveText(['Cards', 'Edit', 'Advanced', 'Gallery']);
  await panel.getByRole('button', { name: 'New', exact: true }).click();

  const createDialog = page.getByRole('dialog', { name: 'New character' });
  await createDialog.getByLabel('Name').fill(characterName);
  await createDialog.getByLabel('Description').fill('Created through the ST1-style sidebar.');
  await createDialog.getByLabel('First message').fill('Welcome from the sidebar.');
  await createDialog.getByRole('button', { name: 'Create', exact: true }).click();

  await expect(panel.getByRole('tab', { name: 'Edit' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('[data-component="character-card-viewer"]')).toBeVisible();
  await expect(panel.locator('[data-part="character-viewer-actions"]')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Edit character card' }).click();
  await expect(panel.getByLabel('Name')).toHaveValue(characterName);
  await panel
    .getByLabel("Creator's notes")
    .fill(
      '## Creator heading\n\nMarkdown **copy**.\n\n<style>body { min-height: 3840px; } article { color: teal; min-height: 720px; }</style><article>Authored preview.</article>',
    );
  await panel.getByRole('button', { name: 'View character card' }).click();
  const viewer = panel.getByTitle(`Read-only card for ${characterName}`);
  await expect(viewer).toHaveAttribute('sandbox', 'allow-same-origin');
  await expect(viewer).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(viewer).toHaveAttribute('srcdoc', /Authored preview\./);
  await expect(
    viewer.contentFrame().getByRole('heading', { name: 'Creator heading' }),
  ).toBeVisible();
  await expect(viewer.contentFrame().getByText('Markdown')).toBeVisible();
  await expect(viewer.contentFrame().getByText('Authored preview.')).toBeVisible();
  await expect
    .poll(() => viewer.evaluate((frame) => frame.clientHeight))
    .toBeGreaterThanOrEqual(720);
  await expect.poll(() => viewer.evaluate((frame) => frame.clientHeight)).toBeLessThan(1000);
  await expect(panel.locator('[data-part="character-viewer-identity"]')).toBeVisible();
  const descriptionPreview = panel.locator('[data-part="character-viewer-description"]');
  await expect(descriptionPreview).not.toHaveAttribute('open');

  await panel.getByText('Description', { exact: true }).click();
  await expect(panel.getByText('Created through the ST1-style sidebar.')).toBeVisible();
  const greetingsPreview = panel.locator('[data-part="character-viewer-greetings"]');
  await expect(greetingsPreview).not.toHaveAttribute('open');
  await panel.getByText('Greetings', { exact: true }).click();
  await expect(panel.getByText('First message', { exact: true })).toBeVisible();
  await panel.getByText('First message', { exact: true }).click();
  await expect(panel.getByText('Welcome from the sidebar.')).toBeVisible();
  await expect(panel.getByLabel('Name')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Edit character card' }).click();
  await expect(panel.getByLabel('Name')).toHaveValue(characterName);
  await panel.getByRole('button', { name: 'Add', exact: true }).click();
  await panel.getByLabel(/^Greeting 1/).fill('Alternate welcome.');
  await panel.getByRole('button', { name: /Greeting 1/ }).click();
  await expect(panel.getByLabel(/^Greeting 1/)).toHaveCount(0);
  await panel.getByLabel('New tag').fill('e2e-tag');
  await panel.getByLabel('New tag').press('Enter');
  await expect(panel.getByText('e2e-tag', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Delete character' })).toHaveCount(1);

  await panel.getByLabel('Export character card').click();
  // The menu renders in a portal (Radix) at document level, not inside the
  // sidebar region.
  const exportMenu = page.getByRole('menu');
  await expect(exportMenu.getByRole('menuitem', { name: /PNG/ })).toHaveAttribute(
    'href',
    /export\?format=png$/,
  );
  await expect(exportMenu.getByRole('menuitem', { name: /JSON/ })).toHaveAttribute(
    'href',
    /export\?format=json$/,
  );
  await page.keyboard.press('Escape');
  // The portal content animates out; wait for it to unmount so it cannot
  // intercept the next click.
  await expect(exportMenu).toBeHidden();

  await panel.getByRole('tab', { name: 'Advanced' }).click();
  await panel.getByText('Prompt Overrides').click();
  const savePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      /\/api\/v2\/characters\/[^/]+$/.test(response.url()) &&
      response.ok(),
  );
  await panel.getByLabel(/^System prompt/).fill('Stay in character.');
  await savePromise;

  await panel.getByRole('tab', { name: 'Gallery' }).click();
  await expect(panel.getByRole('heading', { name: 'Image Gallery' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Add image' }).first()).toBeVisible();
  await panel.getByLabel('Gallery columns').selectOption('2');
  await expect(panel.getByLabel('Gallery columns')).toHaveValue('2');
  await expectNoA11yViolations(page);

  await panel.getByRole('tab', { name: 'Edit' }).click();
  await panel.getByRole('button', { name: 'Delete character' }).first().click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete character' });
  await deleteDialog.getByRole('button', { name: 'Delete character' }).click();
  await expect(panel.getByRole('tab', { name: 'Cards' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('button', { name: new RegExp(characterName) })).toHaveCount(0);
});

test('opens AI settings inline and centers chat in the remaining desktop space', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/home');

  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('button', { name: 'AI Settings', exact: true }).click();
  const panel = page.getByRole('region', { name: 'AI Settings', exact: true });
  await expect(panel.getByRole('tab', { name: 'Config' })).toBeVisible();
  await expect(panel.getByRole('slider', { name: 'Context size (tokens)' })).toBeVisible();
  await expect(panel.getByRole('slider', { name: 'Max tokens' })).toBeVisible();
  await expect(panel.getByRole('slider', { name: 'Frequency penalty' })).toBeVisible();
  await expect(panel.getByRole('slider', { name: 'Seed' })).toBeVisible();
  await panel.getByRole('tab', { name: 'API' }).click();
  const providerEditor = panel.locator('[data-component="provider-profile-editor"]');
  await expect(providerEditor.getByLabel('Connection profile')).toBeVisible();
  // Start from a blank profile: a previously activated plugin profile renders a
  // summary instead of the Source select, so the test must not depend on state
  // left by earlier tests in this shared server.
  await providerEditor.getByLabel('Connection profile').selectOption('');
  await expect(providerEditor.getByLabel('Model')).toBeVisible();
  await expect(providerEditor.getByLabel('API key')).toBeVisible();
  await providerEditor.getByLabel('Provider source').selectOption('openai-compatible');
  await expect(providerEditor.getByText('/v1/models')).toBeVisible();
  await panel.getByRole('tab', { name: 'Advanced' }).click();
  // The prompt mode persists server-side and earlier suites may leave it on
  // "Prompt Template"; make the chat-template assertions independent of it.
  const chatMode = panel.getByRole('radio', { name: 'Chat Template', exact: true });
  if (!(await chatMode.isChecked())) await chatMode.click();
  await expect(chatMode).toBeChecked();
  await expect(panel.getByLabel(/Chat serialization/u)).toHaveValue('native');
  await expect(panel.getByRole('radio', { name: 'Prompt Template' })).toBeVisible();
  await expect(panel.getByRole('slider', { name: 'Frequency penalty' })).toHaveCount(0);
  await expectNoA11yViolations(page);
  await expect(page).toHaveURL(/\/home$/);
  await page.waitForTimeout(350);

  const geometry = await page.evaluate(() => {
    const panelBox = document
      .querySelector('[data-component="navigation-panel"]')
      ?.getBoundingClientRect();
    const mainBox = document.querySelector('[data-component="main-area"]')?.getBoundingClientRect();
    const chatBox = document.querySelector('[data-slot="chat.viewport"]')?.getBoundingClientRect();
    if (!panelBox || !mainBox || !chatBox) return null;
    return {
      panelRight: panelBox.right,
      mainLeft: mainBox.left,
      centerDelta: Math.abs(
        (mainBox.left + mainBox.right) / 2 - (chatBox.left + chatBox.right) / 2,
      ),
    };
  });

  expect(geometry).not.toBeNull();
  expect(Math.abs((geometry?.panelRight ?? 0) - (geometry?.mainLeft ?? 0))).toBeLessThan(1);
  expect(geometry?.centerDelta).toBeLessThan(1);
});

test('management tabs share geometry and pin full-height desktop panels', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/home');

  const navigation = page.getByRole('navigation', { name: 'Main navigation' });

  const readTabGeometry = async (
    label: string,
  ): Promise<{
    start: number;
    end: number;
    position: string;
    backdropFilter: string;
    contentOverlap: number;
    scrollWrapperInset: number;
    top: number;
    headerBottom: number;
    menuInset: number;
    panelPinned: boolean;
    headerHeight: number;
    standardHeaderHeight: number;
    hasEyebrow: boolean;
    headerLayer: number;
    panelLayer: number;
    boundaryOwnedByHeader: boolean;
    usesOverlaySeparator: boolean;
    usesBaseSeparatorColor: boolean;
    scrollableAncestorCount: number;
  }> => {
    await navigation.getByRole('button', { name: label, exact: true }).click();
    const panel = page.getByRole('region', { name: label, exact: true });
    const tabList = panel.locator('[data-component="tabs-list"]').first();
    await expect(tabList).toBeVisible();
    // The panel slides in with `navigation-panel-enter`; boundary probes via
    // elementFromPoint during the translation hit the rail beneath instead of
    // the header. Measure only after the transform settles.
    await expect
      .poll(async () =>
        tabList.evaluate((element) => {
          const panelElement = element.closest('[data-component="navigation-panel"]');
          return panelElement instanceof HTMLElement
            ? new DOMMatrixReadOnly(getComputedStyle(panelElement).transform).e
            : Number.NaN;
        }),
      )
      .toBe(0);

    return tabList.evaluate((element) => {
      const panelElement = element.closest('[data-component="navigation-panel"]');
      if (!(panelElement instanceof HTMLElement)) {
        throw new Error('Tabs must remain inside the navigation panel');
      }
      const activeContent = element.parentElement?.querySelector(
        '[data-component="tabs-content"][data-state="active"]',
      );
      if (!(activeContent instanceof HTMLElement)) {
        throw new Error('Active tab content must remain mounted beside the tab list');
      }
      const scrollFrame = activeContent.querySelector('[data-radix-scroll-area-viewport] > div');
      const header = panelElement.querySelector('[data-component="sidebar-panel-header"]');
      if (!(header instanceof HTMLElement)) {
        throw new Error('Navigation panels must use the shared panel header');
      }
      const panelBox = panelElement.getBoundingClientRect();
      const headerBox = header.getBoundingClientRect();
      const tabsRoot = element.closest('[data-component="tabs"]');
      if (!(tabsRoot instanceof HTMLElement)) {
        throw new Error('Management tab list must remain inside its tabs root');
      }
      const borderProbe = document.createElement('span');
      borderProbe.style.color = 'var(--st-color-border)';
      header.append(borderProbe);
      const baseBorderColor = getComputedStyle(borderProbe).color;
      borderProbe.remove();
      const headerStyle = getComputedStyle(header);
      const separatorStyle = getComputedStyle(header, '::after');
      const tabsBox = element.getBoundingClientRect();
      const contentBox = activeContent.getBoundingClientRect();
      const style = getComputedStyle(element);
      const frameStyle = scrollFrame ? getComputedStyle(scrollFrame) : null;
      const contentOverlap = tabsBox.bottom - contentBox.top;
      let scrollableAncestorCount = 0;
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor);
        // Count potential scroll containers; whether content overflows
        // depends on the panel data, not on the layout contract.
        if (/(auto|scroll)/u.test(ancestorStyle.overflowY)) {
          scrollableAncestorCount += 1;
        }
      }
      return {
        start: tabsBox.left - panelBox.left,
        end: panelBox.right - tabsBox.right,
        position: style.position,
        backdropFilter: style.backdropFilter,
        contentOverlap,
        scrollWrapperInset:
          Number.parseFloat(frameStyle?.paddingBlockStart ?? '0') +
          Number.parseFloat(frameStyle?.paddingInlineStart ?? '0') +
          Number.parseFloat(frameStyle?.paddingBlockEnd ?? '0'),
        top: tabsBox.top,
        headerBottom: headerBox.bottom,
        menuInset: Number.parseFloat(
          getComputedStyle(tabsRoot).getPropertyValue('--management-tabs-edge-inset'),
        ),
        panelPinned: panelElement.dataset['managementTabsPinned'] === 'true',
        headerHeight: header.getBoundingClientRect().height,
        standardHeaderHeight: Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--st-control-height-large'),
        ),
        hasEyebrow: header.querySelector('[data-part="eyebrow"]') !== null,
        headerLayer: Number.parseFloat(headerStyle.zIndex),
        panelLayer: Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--st-layer-panel'),
        ),
        boundaryOwnedByHeader:
          document
            .elementFromPoint(headerBox.left + headerBox.width / 2, headerBox.bottom - 0.5)
            ?.closest('[data-component="sidebar-panel-header"]') === header,
        usesOverlaySeparator:
          headerStyle.borderBottomWidth === '0px' &&
          separatorStyle.position === 'absolute' &&
          separatorStyle.content !== 'none' &&
          Number.parseFloat(separatorStyle.blockSize) === 1,
        usesBaseSeparatorColor: separatorStyle.backgroundColor === baseBorderColor,
        scrollableAncestorCount,
      };
    });
  };

  const aiSettingsTabs = await readTabGeometry('AI Settings');
  const personaTabs = await readTabGeometry('Personas');
  await expectNoA11yViolations(page);
  const characterTabs = await readTabGeometry('Characters');

  for (const tabs of [aiSettingsTabs, personaTabs, characterTabs]) {
    expect(tabs.headerHeight).toBeCloseTo(tabs.standardHeaderHeight, 1);
    expect(tabs.hasEyebrow).toBe(false);
    expect(tabs.headerLayer).toBeGreaterThan(tabs.panelLayer);
    expect(tabs.boundaryOwnedByHeader).toBe(true);
    expect(tabs.usesOverlaySeparator).toBe(true);
    expect(tabs.usesBaseSeparatorColor).toBe(true);
  }

  for (const tabs of [personaTabs, characterTabs]) {
    expect(Math.abs(tabs.start - aiSettingsTabs.start)).toBeLessThan(1);
    expect(Math.abs(tabs.end - aiSettingsTabs.end)).toBeLessThan(1);
    expect(tabs.panelPinned).toBe(false);
    expect(tabs.position).toBe('relative');
    expect(tabs.backdropFilter).not.toBe('none');
    expect(tabs.contentOverlap).toBeLessThanOrEqual(0);
    expect(tabs.scrollWrapperInset).toBe(0);
    expect(tabs.scrollableAncestorCount).toBe(1);
    expect(tabs.top - tabs.headerBottom).toBeCloseTo(tabs.menuInset, 1);
  }

  const characterPanel = page.getByRole('region', { name: 'Characters', exact: true });
  await characterPanel
    .locator('[data-part="character-cards"] button')
    .filter({ hasText: 'Hazel' })
    .click();
  await expect(characterPanel.locator('[data-component="character-card-viewer"]')).toBeVisible();

  const characterTabList = characterPanel.locator('[data-component="tabs-list"]').first();
  const characterViewport = characterPanel
    .locator('[data-component="tabs"][data-scroll-mode="root"] [data-radix-scroll-area-viewport]')
    .first();
  const pinnedTopBeforeScroll = await characterTabList.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  const scrollTop = await characterViewport.evaluate((element) => {
    element.scrollTop = 240;
    return element.scrollTop;
  });
  expect(scrollTop).toBeGreaterThan(0);
  const pinnedTopAfterScroll = await characterTabList.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  expect(pinnedTopAfterScroll).toBeLessThan(pinnedTopBeforeScroll);
});

test('mobile navigation panel fills the viewport after the rail', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('neotavern-panel-width', '340px');
  });
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto('/home');

  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Characters', exact: true })
    .click();

  const panel = page.getByRole('region', { name: 'Characters', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-state', 'open');
  await page.waitForTimeout(350);
  const geometry = await panel.evaluate((element) => {
    const style = getComputedStyle(element);
    const header = element.querySelector('[data-component="sidebar-panel-header"]');
    if (!(header instanceof HTMLElement)) {
      throw new Error('Navigation panels must use the shared panel header');
    }
    return {
      right: element.getBoundingClientRect().right,
      paddingStart: Number.parseFloat(style.paddingBlockStart),
      paddingEnd: Number.parseFloat(style.paddingBlockEnd),
      headerHeight: header.getBoundingClientRect().height,
      standardHeaderHeight: Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--st-control-height-large'),
      ),
      hasEyebrow: header.querySelector('[data-part="eyebrow"]') !== null,
    };
  });

  expect(Math.abs(geometry.right - 430)).toBeLessThan(1);
  expect(geometry.paddingStart).toBe(0);
  expect(geometry.paddingEnd).toBe(0);
  expect(geometry.headerHeight).toBeCloseTo(geometry.standardHeaderHeight, 1);
  expect(geometry.hasEyebrow).toBe(false);
});

test('saves and reloads a provider profile from the API tab', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const providerName = `Release Echo ${suffix}`;
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

  await page.goto('/home');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'AI Settings' })
    .click();
  const panel = page.getByRole('region', { name: 'AI Settings' });
  await panel.getByRole('tab', { name: 'API' }).click();
  const editor = page.locator('[data-component="provider-profile-editor"]');
  await expect(editor.getByLabel('Connection profile')).toHaveValue(providerId);
  await expect(editor.getByLabel('Model', { exact: true })).toHaveValue('echo');
  await expect(editor.getByLabel('API key', { exact: true })).toHaveValue('');
  await editor.getByRole('button', { name: 'Connect' }).click();
  await expect(editor.getByText('Connected')).toBeVisible();

  await page.reload();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'AI Settings' })
    .click();
  await page.getByRole('region', { name: 'AI Settings' }).getByRole('tab', { name: 'API' }).click();
  const reloadedEditor = page.locator('[data-component="provider-profile-editor"]');
  await expect(reloadedEditor.getByLabel('Connection profile')).toHaveValue(providerId);
  await expect(reloadedEditor.getByLabel('Model', { exact: true })).toHaveValue('echo');
  await expect(reloadedEditor.getByLabel('API key', { exact: true })).toHaveValue('');
  await expectNoA11yViolations(page);
});

test('exposes documented legacy globals and unmanaged DOM islands', async ({ page }) => {
  await page.goto('/home');
  await expect(page.locator('#legacy-modal')).toBeAttached();
  const compatibility = await page.evaluate(() => {
    const legacy = window as typeof window & {
      SillyTavern?: { getContext(): unknown };
      eventSource?: unknown;
      event_types?: unknown;
      extension_settings?: unknown;
      jQuery?: unknown;
      $?: unknown;
    };
    return {
      context: typeof legacy.SillyTavern?.getContext === 'function',
      eventSource: typeof legacy.eventSource === 'object',
      eventTypes: typeof legacy.event_types === 'object',
      extensionSettings: typeof legacy.extension_settings === 'object',
      jquery: typeof legacy.jQuery === 'function' && legacy.$ === legacy.jQuery,
      islands: [
        'legacy-extensions-settings',
        'legacy-chat-actions',
        'legacy-character-actions',
        'legacy-toolbar',
        'legacy-drawer',
        'legacy-modal',
      ].every((id) => document.getElementById(id) !== null),
    };
  });
  expect(compatibility).toEqual({
    context: true,
    eventSource: true,
    eventTypes: true,
    extensionSettings: true,
    jquery: true,
    islands: true,
  });
});

for (const route of ['/home', '/characters', '/chats', '/providers', '/themes', '/plugins']) {
  test(`has no automatic WCAG A/AA violations on ${route}`, async ({ page }) => {
    await page.goto(route);
    await expect(page.locator('[data-component="main-area"]')).toBeVisible();
    await expectNoA11yViolations(page);
  });
}

test('installs, persists and recovers from a declarative theme package', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const themeId = `e2e.release-${suffix}`;
  const themeName = `Release Theme ${suffix}`;
  const archive = zipBuffer({
    'theme.json': JSON.stringify({
      id: themeId,
      name: themeName,
      version: '1.0.0',
      apiVersion: 1,
      tokens: {
        light: {
          'color-accent': '#3157c8',
          'radius-card': '18px',
        },
        dark: {
          'color-accent': '#3157c8',
          'radius-card': '18px',
        },
      },
      componentsCss: 'styles/components.css',
      shell: 'styles/shell.css',
    }),
    'styles/components.css':
      '[data-component="theme-card"] { outline-color: var(--st-color-accent); }',
    'styles/shell.css': '[data-component="app-shell"] { min-width: 0; }',
  });

  await page.goto('/themes');
  await page.getByLabel('Install theme package').setInputFiles({
    name: 'release-theme.sttheme',
    mimeType: 'application/zip',
    buffer: archive,
  });
  await expect(
    page.getByText(`Installed ${themeName}. Review it here before applying.`),
  ).toBeVisible();
  const card = page.locator('[data-component="theme-card"]').filter({ hasText: themeName });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Apply theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme-id', themeId);
  await expect(page.locator('html')).toHaveCSS('--st-color-accent', '#3157c8');
  await expect(page.locator(`link[data-neotavern-theme-style="${themeId}"]`)).toHaveCount(2);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme-id', themeId);
  await expect(page.locator('html')).toHaveCSS('--st-color-accent', '#3157c8');

  await page.goto('/themes?safe=1');
  await expect(page.getByText('Safe mode is active')).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme-id');
  await expect(page.locator('link[data-neotavern-theme-style]')).toHaveCount(0);
  await expectNoA11yViolations(page);

  const exitThemeSafeMode = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Exit safe mode' }).click();
  await exitThemeSafeMode;
  await expect(page).toHaveURL(/\/themes$/u);
  await expect(page.locator('html')).toHaveAttribute('data-theme-id', themeId);
  await card.getByRole('button', { name: 'Use built-in theme' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme-id');

  await card.getByRole('button', { name: `Delete theme ${themeName}` }).click();
  const deleteThemeDialog = page.getByRole('dialog', { name: 'Remove theme' });
  await expect(deleteThemeDialog).toBeVisible();
  await deleteThemeDialog.getByRole('button', { name: 'Delete' }).click();
  await expect(card).toHaveCount(0);
});

test('installs, consents to and isolates a frontend plugin package', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const pluginId = `e2e.release-${suffix}`;
  const pluginName = `Release Plugin ${suffix}`;
  const archive = zipBuffer({
    'plugin.json': JSON.stringify({
      id: pluginId,
      name: pluginName,
      version: '1.0.0',
      apiVersion: 2,
      frontend: 'dist/frontend.js',
      i18n: { en: 'locales/en.json' },
      permissions: [
        'characters.read',
        'chat.read',
        'notifications',
        'ui.shell',
        'ui.sidebar',
        'ui.toolbar',
      ],
    }),
    'locales/en.json': JSON.stringify({
      page: { title: 'Release plugin surface' },
      toolbar: { title: 'Run release plugin' },
      command: { title: 'Run release command' },
      settings: { title: 'Release plugin settings' },
      sidebar: { title: 'Release plugin sidebar' },
      dialog: { title: 'Open release dialog' },
      characterTab: { title: `Release character tab ${suffix}` },
    }),
    'dist/frontend.js': `
      export default {
        activate(api) {
          api.ui.pages.register({
            id: 'release-surface',
            path: '/release',
            title: api.i18n.t('page.title'),
            mount(root) {
              const heading = document.createElement('h2');
              heading.textContent = api.i18n.t('page.title');
              root.replaceChildren(heading);
              return () => root.replaceChildren();
            }
          });
          api.ui.toolbarActions.register({
            id: 'release-action',
            title: api.i18n.t('toolbar.title'),
            run() {
              document.documentElement.dataset.action = 'ran';
            }
          });
          api.ui.commands.register({
            id: 'release-command',
            title: api.i18n.t('command.title'),
            run() {
              document.documentElement.dataset.command = 'ran';
            }
          });
          api.ui.hotkeys.register({
            id: 'release-hotkey',
            combo: 'mod+shift+y',
            title: 'Release hotkey',
            run() {
              document.documentElement.dataset.hotkey = 'ran';
            }
          });
          api.ui.settingsPanels.register({
            id: 'release-settings',
            title: api.i18n.t('settings.title'),
            mount(root) {
              const heading = document.createElement('h2');
              heading.textContent = api.i18n.t('settings.title');
              root.replaceChildren(heading);
              return () => root.replaceChildren();
            }
          });
          api.ui.sidebarPanels.register({
            id: 'release-sidebar',
            slot: 'left',
            title: api.i18n.t('sidebar.title'),
            mount(root) {
              root.textContent = api.i18n.t('sidebar.title');
              return () => root.replaceChildren();
            }
          });
          api.ui.dialogs.register({
            id: 'release-dialog',
            title: api.i18n.t('dialog.title'),
            mount(root) {
              const heading = document.createElement('h2');
              heading.textContent = 'Release dialog surface';
              root.replaceChildren(heading);
              return () => root.replaceChildren();
            }
          });
          api.ui.characterTabs.register({
            id: 'release-character-tab',
            title: api.i18n.t('characterTab.title'),
            mount(root, context) {
              const heading = document.createElement('h2');
              heading.textContent = 'Character context ' + context.characterId;
              root.replaceChildren(heading);
              return () => root.replaceChildren();
            }
          });
          api.ui.messageRenderers.register({
            id: 'release-message-renderer',
            title: 'Release message annotation',
            render(message) {
              return { text: 'Rendered: ' + message.content, placement: 'after' };
            }
          });
          api.notify({ title: 'Release plugin activated', variant: 'success' });
        },
        deactivate() {
          document.documentElement.dataset.deactivated = 'yes';
        }
      };
    `,
  });

  await page.goto('/plugins');
  await page.getByLabel('Install plugin package').setInputFiles({
    name: 'release-plugin.stplugin',
    mimeType: 'application/zip',
    buffer: archive,
  });
  await expect(
    page.getByText(`Installed ${pluginName}. Review its permissions before activation.`),
  ).toBeVisible();

  const card = page.locator('[data-component="plugin-card"]').filter({ hasText: pluginName });
  await expect(card).toHaveAttribute('data-state', 'needs-consent');
  const activate = card.getByRole('button', { name: 'Approve and activate' });
  await expect(activate).toBeDisabled();
  await card.getByRole('checkbox', { name: /ui\.shell/u }).check();
  await card.getByRole('checkbox', { name: /ui\.sidebar/u }).check();
  await card.getByRole('checkbox', { name: /ui\.toolbar/u }).check();
  await card.getByRole('checkbox', { name: /notifications/u }).check();
  await card.getByRole('checkbox', { name: /characters\.read/u }).check();
  await card.getByRole('checkbox', { name: /chat\.read/u }).check();
  await activate.click();
  await expect(card).toHaveAttribute('data-state', 'active');
  await expect(page.getByText(`Activated ${pluginName}.`)).toBeVisible();

  const sandbox = page.locator(`iframe[data-plugin-id="${pluginId}"]`);
  await expect(sandbox).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(sandbox).not.toHaveAttribute('sandbox', /allow-same-origin/u);
  await expect(card.getByRole('link', { name: 'Open plugin page' })).toBeVisible();
  await card.getByRole('link', { name: 'Open plugin page' }).click();
  await expect(page).toHaveURL(new RegExp(`/plugins/${pluginId}/release$`, 'u'));
  await expect(
    page.frameLocator(`iframe[data-plugin-id="${pluginId}"]`).getByRole('heading', {
      name: 'Release plugin surface',
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close Plugins and return to chat' }).click();
  await page
    .locator('[data-component="plugin-toolbar"]')
    .getByRole('button', { name: 'Open release dialog', description: pluginName })
    .click();
  await expect(
    page.frameLocator(`iframe[data-plugin-id="${pluginId}"]`).getByRole('heading', {
      name: 'Release dialog surface',
    }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page
    .locator('[data-component="plugin-toolbar"]')
    .getByRole('button', { name: 'Run release plugin', description: pluginName })
    .click();
  await expect(
    page.frameLocator(`iframe[data-plugin-id="${pluginId}"]`).locator('html'),
  ).toHaveAttribute('data-action', 'ran');
  await page
    .locator('[data-component="plugin-toolbar"]')
    .getByRole('button', { name: 'Run release command', description: pluginName })
    .click();
  await expect(
    page.frameLocator(`iframe[data-plugin-id="${pluginId}"]`).locator('html'),
  ).toHaveAttribute('data-command', 'ran');
  await page.keyboard.press('Control+Shift+Y');
  await expect(
    page.frameLocator(`iframe[data-plugin-id="${pluginId}"]`).locator('html'),
  ).toHaveAttribute('data-hotkey', 'ran');

  await page.goto('/home');
  const settingsPanel = await openSettingsPanel(page);
  await settingsPanel
    .getByRole('tab', { name: 'Release plugin settings', description: pluginName })
    .click();
  await expect(
    page.frameLocator(`iframe[data-plugin-id="${pluginId}"]`).getByRole('heading', {
      name: 'Release plugin settings',
    }),
  ).toBeVisible();

  const characterResponse = await page.request.post('/api/v2/characters', {
    data: { name: `Plugin character ${suffix}` },
  });
  expect(characterResponse.ok()).toBe(true);
  const pluginCharacter = (await characterResponse.json()) as { id: string };

  await page.goto('/characters');
  await page.getByRole('button', { name: 'Extensions' }).first().click();
  await page.getByRole('tab', { name: `Release character tab ${suffix}` }).click();
  await expect(
    page
      .frameLocator(`iframe[data-plugin-id="${pluginId}"]`)
      .getByRole('heading', { name: /^Character context /u }),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  const renderedMessage = `Plugin renderer ${suffix}`;
  const chatResponse = await page.request.post('/api/v2/chats', {
    data: { characterId: pluginCharacter.id },
  });
  expect(chatResponse.ok()).toBe(true);
  const pluginChat = (await chatResponse.json()) as { id: string };
  const messageResponse = await page.request.post(`/api/v2/chats/${pluginChat.id}/messages`, {
    data: { role: 'user', content: renderedMessage },
  });
  expect(messageResponse.ok()).toBe(true);
  await page.goto(`/chats/${pluginChat.id}`);
  await expect(
    page
      .locator(`[data-component="plugin-message-renderer"][data-plugin="${pluginName}"]`)
      .filter({ hasText: `Rendered: ${renderedMessage}` }),
  ).toBeVisible();

  await page.goto('/plugins?safe=1');
  await expect(page.getByText('Plugin safe mode is active')).toBeVisible();
  await expect(page.locator(`iframe[data-plugin-id="${pluginId}"]`)).toHaveCount(0);
  await expectNoA11yViolations(page);

  const exitedSafeMode = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Exit plugin safe mode' }).click();
  await exitedSafeMode;
  await expect(page).toHaveURL(/\/plugins$/u);
  await expect(card).toHaveAttribute('data-state', 'active');
  await card.getByRole('button', { name: `Delete plugin ${pluginName}` }).click();
  const deletePluginDialog = page.getByRole('dialog', { name: 'Remove plugin' });
  await expect(deletePluginDialog).toBeVisible();
  await deletePluginDialog.getByRole('button', { name: 'Delete' }).click();
  await expect(card).toHaveCount(0);
});

test('loads a trusted legacy frontend only after explicit consent and bypasses it in safe mode', async ({
  page,
}) => {
  const suffix = Date.now().toString(36);
  const pluginId = `e2e.legacy-${suffix}`;
  const pluginName = `Legacy Plugin ${suffix}`;
  const legacyMarker = `Trusted legacy loaded ${suffix}`;
  const archive = zipBuffer({
    'plugin.json': JSON.stringify({
      id: pluginId,
      name: pluginName,
      version: '1.0.0',
      apiVersion: 2,
      legacy: { frontend: 'legacy.js' },
      permissions: ['legacy.trusted'],
    }),
    'legacy.js': `
      window.__neotavernLegacyE2e = '${pluginId}';
      const island = document.getElementById('legacy-toolbar');
      if (island) island.textContent = '${legacyMarker}';
    `,
  });

  // App-level legacy frontend opt-in (`extensions.legacyFrontend`, default
  // off, ТЗ §10/§87): legacy entries inject into the main document, so the
  // app gate must be on IN ADDITION to the per-plugin `legacy.trusted`
  // consent. PATCH before the page load so the app fetches the gate fresh.
  const legacyGate = await page.request.patch('/api/v2/settings', {
    data: { 'extensions.legacyFrontend': true },
  });
  expect(legacyGate.ok()).toBe(true);

  await page.goto('/plugins');
  await page.getByLabel('Install plugin package').setInputFiles({
    name: 'legacy-plugin.stplugin',
    mimeType: 'application/zip',
    buffer: archive,
  });
  const card = page.locator('[data-component="plugin-card"]').filter({ hasText: pluginName });
  await expect(card.getByText('Trusted legacy compatibility')).toBeVisible();
  await expect(page.locator('#legacy-toolbar').getByText(legacyMarker)).toHaveCount(0);
  await card.getByRole('checkbox', { name: /legacy\.trusted/u }).check();
  await card.getByRole('button', { name: 'Approve and activate' }).click();
  await expect(page.locator('#legacy-toolbar')).toHaveText(legacyMarker);
  await expect
    .poll(() =>
      page.evaluate(
        (expected) =>
          (window as typeof window & { __neotavernLegacyE2e?: string }).__neotavernLegacyE2e === expected,
        pluginId,
      ),
    )
    .toBe(true);

  await page.goto('/plugins?safe=1');
  await expect(page.getByText('Plugin safe mode is active')).toBeVisible();
  await expect(page.locator('#legacy-toolbar')).toBeEmpty();
  await expect(
    page.evaluate(() => (window as typeof window & { __neotavernLegacyE2e?: string }).__neotavernLegacyE2e),
  ).resolves.toBeUndefined();

  const legacySafeModeExit = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Exit plugin safe mode' }).click();
  await legacySafeModeExit;
  await expect(page).toHaveURL(/\/plugins$/u);
  await expect(page.locator(`script[data-plugin-id="${pluginId}"]`)).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(
        (expected) =>
          (window as typeof window & { __neotavernLegacyE2e?: string }).__neotavernLegacyE2e === expected,
        pluginId,
      ),
    )
    .toBe(true);
  await card.getByRole('button', { name: `Delete plugin ${pluginName}` }).click();
  const deleteLegacyPluginDialog = page.getByRole('dialog', { name: 'Remove plugin' });
  await expect(deleteLegacyPluginDialog).toBeVisible();
  await deleteLegacyPluginDialog.getByRole('button', { name: 'Delete' }).click();
  await expect(card).toHaveCount(0);
});

test('system surfaces keep the chat mounted and restore focus to their opener', async ({
  page,
}) => {
  await page.goto('/home');
  const workspace = page.locator('[data-component="home"]');
  await expect(workspace).toBeVisible();

  // The Settings panel links to the Themes surface; the surface opens over
  // the mounted workspace and closing it restores focus to the opener link.
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  const settingsPanel = page.getByRole('region', { name: 'Settings' });
  await settingsPanel.getByRole('tab', { name: 'Themes' }).click();
  const opener = settingsPanel.getByRole('link', { name: 'Open theme manager' });
  await opener.click();
  await expect(page).toHaveURL(/\/themes$/);
  await expect(workspace).toBeAttached();
  await expect(page.getByRole('button', { name: 'Close Themes and return to chat' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/home$/);
  await expect(workspace).toBeVisible();
  await expect(opener).toBeFocused();
});

test('settings panel hides conversation defaults and workspace density', async ({ page }) => {
  await page.goto('/home');
  const settings = await openSettingsPanel(page);
  await expect(settings.getByRole('heading', { name: 'Conversation defaults' })).toHaveCount(0);
  await expect(settings.getByRole('group', { name: 'Workspace density' })).toHaveCount(0);
  const startup = settings.getByRole('group', { name: 'Open Home when the app starts' });
  await expect(startup.getByRole('button', { name: 'Home' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await startup.getByRole('button', { name: 'Current screen' }).click();
  await expect(startup.getByRole('button', { name: 'Current screen' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('neotavern.openHomeOnLoad')))
    .toBe('false');
  await expect(settings.getByRole('heading', { name: 'Diagnostics and recovery' })).toBeVisible();
  await expectNoA11yViolations(page);
});

test('settings theme selection uses a compact dropdown', async ({ page }) => {
  await page.goto('/home');
  const settings = await openSettingsPanel(page);
  await settings.getByRole('tab', { name: 'Themes', exact: true }).click();

  const themeSelect = settings.getByRole('combobox', { name: 'Theme' });
  await expect(themeSelect).toBeVisible();
  await expect(settings.locator('[data-part="theme-select"]')).toHaveCount(1);

  const customThemeOption = themeSelect.locator('option').nth(1);
  const customThemeId = await customThemeOption.getAttribute('value');
  if (!customThemeId) throw new Error('Expected a bundled theme option.');

  await themeSelect.selectOption(customThemeId);
  await expect(page.locator('html')).toHaveAttribute('data-theme-id', customThemeId);
  await expect(settings.locator('[role="status"]')).toHaveCount(0);
  await themeSelect.selectOption('');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme-id');
});

test('interface preferences apply immediately and persist through reload', async ({ page }) => {
  await page.goto('/home');
  const settings = await openSettingsPanel(page);
  const scale = settings.getByRole('group', { name: 'Text and controls' });
  await scale.getByRole('button', { name: 'Large' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-ui-scale', 'large');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-ui-scale', 'large');
  const reopened = await openSettingsPanel(page);
  await expect(
    reopened
      .getByRole('group', { name: 'Text and controls' })
      .getByRole('button', { name: 'Large' }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('round-trips frontend prompt interceptor results before provider generation', async ({
  page,
}) => {
  await page.goto('/home');
  const result = await page.evaluate(async () => {
    const requestJson = async (path: string, init: RequestInit) => {
      const response = await fetch(`/api/v2${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      });
      if (!response.ok) throw new Error(`${path}:${response.status}`);
      return response.json() as Promise<Record<string, unknown>>;
    };
    const character = await requestJson('/characters', {
      method: 'POST',
      body: JSON.stringify({
        name: `Interceptor fixture ${Date.now()}`,
        description: 'Frontend interceptor release test.',
      }),
    });
    const chat = await requestJson('/chats', {
      method: 'POST',
      body: JSON.stringify({ characterId: character['id'] }),
    });
    const response = await fetch(`/api/v2/chats/${String(chat['id'])}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userMessage: 'before frontend interceptor',
        frontendInterceptors: true,
      }),
    });
    if (!response.ok || !response.body) throw new Error(`generate:${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let doneText = '';
    let intercepted = false;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      buffer += decoder.decode(item.value, { stream: true });
      let separator: number;
      while ((separator = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const line = chunk.split('\n').find((candidate) => candidate.startsWith('data:'));
        if (!line) continue;
        const event = JSON.parse(line.slice(5).trim()) as {
          type: string;
          requestId?: string;
          responseToken?: string;
          text?: string;
          messages?: Array<{
            id?: string;
            role: string;
            content: string;
            name?: string | null;
          }>;
          meta?: Record<string, unknown>;
        };
        if (
          event.type === 'plugin_intercept' &&
          event.requestId &&
          event.responseToken &&
          event.messages
        ) {
          intercepted = true;
          const messages = event.messages.map((message) =>
            message.role === 'user'
              ? { ...message, content: 'after frontend interceptor' }
              : message,
          );
          const accepted = await fetch(
            `/api/v2/plugin-intercepts/${encodeURIComponent(event.requestId)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                responseToken: event.responseToken,
                messages,
                meta: event.meta ?? {},
              }),
            },
          );
          if (!accepted.ok) throw new Error(`intercept:${accepted.status}`);
        }
        if (event.type === 'done') doneText = event.text ?? '';
      }
    }
    return { intercepted, doneText };
  });
  expect(result.intercepted).toBe(true);
  expect(result.doneText).toContain('after frontend interceptor');
});

test('creates a redacted diagnostic report and runs local recovery actions', async ({ page }) => {
  await page.goto('/home');
  const settings = await openSettingsPanel(page);
  await settings.getByRole('button', { name: 'Run diagnostics' }).click();
  await expect(settings.getByText('Healthy', { exact: true })).toBeVisible();
  await expect(
    settings.getByText(
      'The report excludes secrets, logs, absolute paths and user-authored content.',
      { exact: true },
    ),
  ).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await settings.getByRole('button', { name: 'Download JSON report' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^neotavern-diagnostics-.*\.json$/u);

  await settings.getByRole('button', { name: 'Rebuild search index' }).click();
  await expect(settings.getByText('The full-text search index was rebuilt.')).toBeVisible();

  await settings.getByRole('button', { name: 'Clear thumbnail cache' }).click();
  const clearCacheDialog = page.getByRole('dialog', { name: 'Clear thumbnail cache' });
  await expect(clearCacheDialog).toBeVisible();
  await clearCacheDialog.getByRole('button', { name: 'Clear thumbnail cache' }).click();
  await expect(page.getByText(/Cleared \d+ cached items/u)).toBeVisible();

  await expectNoA11yViolations(page);
});

test('migrates a SillyTavern archive from Settings without a terminal', async ({ page }) => {
  const characterName = `Migrated Guide ${Date.now()}`;
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: characterName,
      description: 'Imported through the release migration UI.',
      personality: '',
      scenario: '',
      first_mes: 'The archive is ready.',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: ['migration-e2e'],
      creator: 'Release test',
      character_version: '1',
      extensions: {},
    },
  };
  const archive = zipBuffer({
    [`data/default-user/characters/${characterName}.json`]: JSON.stringify(card),
  });

  await page.goto('/home');
  const settings = await openSettingsPanel(page);
  await settings.getByRole('tab', { name: 'Data & backups' }).click();
  await settings.getByLabel('Choose ZIP').setInputFiles({
    name: 'sillytavern-data.zip',
    mimeType: 'application/zip',
    buffer: archive,
  });
  await settings.getByRole('button', { name: 'Analyze archive' }).click();
  await expect(settings.getByRole('heading', { name: 'Archive analysis is ready' })).toBeVisible();
  await expect(settings.getByRole('checkbox', { name: /Characters/ })).toBeChecked();
  await settings.getByRole('button', { name: 'Back up and import' }).click();
  await expect(settings.getByRole('heading', { name: 'Migration complete' })).toBeVisible();
  await settings.getByRole('button', { name: 'Close menu' }).click();

  const charactersSurface = await openRailPanel(page, 'Characters');
  await expect(
    charactersSurface
      .locator('[data-part="character-cards"] button')
      .filter({ hasText: characterName }),
  ).toBeVisible();
});

test('mobile home keeps the composer reachable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');

  const viewport = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);

  const composer = page.getByLabel(/Type a message/i);
  if (await composer.count()) {
    await expect(composer).toBeVisible();
    const box = await composer.boundingBox();
    expect(box?.y ?? 1000).toBeLessThan(844);
  }
});

test('character actions remain readable in a 320px resizable side panel', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/home');

  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Characters', exact: true })
    .click();

  const panel = page.getByRole('region', { name: 'Characters', exact: true });
  const toolbar = panel.locator('[data-part="character-card-toolbar"]');
  const create = toolbar.getByRole('button', { name: 'New', exact: true });
  const importButton = toolbar.getByRole('button', { name: 'Import', exact: true });

  await expect(create).toBeVisible();
  await expect(importButton).toBeVisible();
  await expect(create.locator('[data-part="icon"]')).toBeVisible();
  await expect(importButton.locator('[data-part="label"]')).toHaveText('Import');

  await page.evaluate(async () => document.fonts.ready);
  await page.waitForTimeout(350);
  const sortControl = toolbar.getByLabel('Sort characters');
  const sortBeforeResize = await sortControl.boundingBox();
  const compactBeforeResize = await toolbar.getAttribute('data-compact');
  await page.setViewportSize({ width: 322, height: 700 });
  const sortAfterResize = await sortControl.boundingBox();
  const compactAfterResize = await toolbar.getAttribute('data-compact');
  const sortEndBefore = (sortBeforeResize?.x ?? 0) + (sortBeforeResize?.width ?? 0);
  const sortEndAfter = (sortAfterResize?.x ?? 0) + (sortAfterResize?.width ?? 0);
  expect(Math.abs(sortEndAfter - sortEndBefore)).toBeLessThanOrEqual(3);
  expect(compactAfterResize).toBe(compactBeforeResize);

  const geometry = await page.evaluate(() => {
    const actionBar = document.querySelector('[data-part="character-card-toolbar"]');
    const newButton = actionBar?.querySelector('[data-variant="primary"]');
    const importAction = Array.from(actionBar?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Import',
    );
    const newBox = newButton?.getBoundingClientRect();
    const importBox = importAction?.getBoundingClientRect();
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      panelScrollWidth: actionBar?.parentElement?.scrollWidth ?? 0,
      panelClientWidth: actionBar?.parentElement?.clientWidth ?? 0,
      newHeight: newBox?.height ?? 0,
      importHeight: importBox?.height ?? 0,
      actionsShareRow:
        Math.abs((importBox?.top ?? 0) - (newBox?.top ?? Number.POSITIVE_INFINITY)) < 1,
      newWidth: newBox?.width ?? 0,
      importWidth: importBox?.width ?? 0,
      contentAwareCompact: actionBar?.getAttribute('data-compact'),
    };
  });

  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.panelScrollWidth).toBeLessThanOrEqual(geometry.panelClientWidth);
  expect(geometry.newHeight).toBeGreaterThanOrEqual(44);
  expect(geometry.importHeight).toBeGreaterThanOrEqual(44);
  expect(geometry.actionsShareRow).toBe(true);
  expect(geometry.newWidth).toBeCloseTo(44, 2);
  expect(geometry.importWidth).toBeCloseTo(44, 2);
  expect(geometry.contentAwareCompact).toBe('true');

  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Personas', exact: true })
    .click();
  const personaPanel = page.getByRole('region', { name: 'Personas', exact: true });
  const personaToolbar = personaPanel.locator('[data-part="persona-card-toolbar"]');
  await expect(personaToolbar).toHaveAttribute('data-compact', 'false');
  await expect(
    personaToolbar.getByRole('button', { name: 'New', exact: true }).locator('[data-part="label"]'),
  ).toBeVisible();
  await expectNoA11yViolations(page);
});

test('system surfaces reflow at 320px and honor RTL logical layout', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/providers');
  await page.evaluate(() => {
    document.documentElement.dir = 'rtl';
  });
  await page.waitForTimeout(350);
  const geometry = await page.evaluate(() => {
    const dialog = document.querySelector('[data-component="dialog-content"]');
    const box = dialog?.getBoundingClientRect();
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      dialogLeft: box?.left,
      dialogRight: box?.right,
    };
  });
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.dialogLeft).toBe(0);
  expect(geometry.dialogRight).toBe(320);
  await expect(
    page.getByRole('button', { name: 'Close Providers and return to chat' }),
  ).toBeVisible();
});

test('sidebar resize keeps the visible panel and shifted chat on one clamped width', async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Older builds exposed this preference. A persisted compact value must not
    // override the inline width written by the current resize host.
    window.localStorage.setItem('neotavern.uiDensity', 'compact');
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/home');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();

  const panel = page.locator('[data-component="navigation-panel"]');
  const handle = panel.getByRole('button', { name: 'Drag to resize panel' });
  await handle.hover({ position: { x: 4, y: 200 } });
  await page.mouse.down();
  await page.waitForTimeout(50);
  await page.mouse.move(80, 200);
  await page.mouse.up();

  const geometry = await page.evaluate(() => {
    const rootStyles = getComputedStyle(document.documentElement);
    const panelBox = document
      .querySelector('[data-component="navigation-panel"]')
      ?.getBoundingClientRect();
    const railBox = document
      .querySelector('[data-component="navigation-rail"] nav')
      ?.getBoundingClientRect();
    const mainBox = document.querySelector('[data-component="main-area"]')?.getBoundingClientRect();
    return {
      panelWidth: panelBox?.width ?? 0,
      minimum: Number.parseFloat(rootStyles.getPropertyValue('--st-shell-panel-min-width')),
      stored: Number.parseFloat(localStorage.getItem('neotavern-panel-width') ?? ''),
      panelEnd: panelBox?.right ?? 0,
      mainStart: mainBox?.left ?? 0,
      railEnd: railBox?.right ?? 0,
    };
  });

  expect(geometry.panelWidth).toBeCloseTo(geometry.minimum, 2);
  expect(geometry.stored).toBeCloseTo(geometry.minimum, 2);
  expect(geometry.panelEnd).toBeCloseTo(geometry.mainStart, 2);
  expect(geometry.railEnd + geometry.panelWidth).toBeCloseTo(geometry.mainStart, 2);

  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() => panel.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThan(geometry.minimum);
});

test('sidebar exit survives rapid reopen and unmounts after the final close', async ({ page }) => {
  await page.goto('/home');

  const rail = page.locator('[data-component="navigation-rail"]');
  await expect(rail.locator('[data-part="main-items"] [data-part="item"]').first()).toHaveAttribute(
    'data-item',
    'menu-toggle',
  );
  const chats = rail.getByRole('button', { name: 'Chats', exact: true });
  await chats.click();

  const panel = page.locator('[data-component="navigation-panel"]');
  await expect(panel).toHaveAttribute('data-state', 'open');

  await chats.click();
  await expect(panel).toHaveAttribute('data-state', 'closing');
  await chats.click();
  await expect(panel).toHaveAttribute('data-state', 'open');
  await page.waitForTimeout(350);
  await expect(panel).toHaveAttribute('data-state', 'open');
  await expectNoA11yViolations(page);

  const toggle = rail.locator('nav').getByRole('button', { name: 'Close menu', exact: true });
  await toggle.click();
  await expect(rail).toHaveAttribute('data-state', 'collapsed');
  await expect(rail.locator('[data-part="item"]')).toHaveCount(1);
  await expect(rail.locator('[data-item="chats"]')).toHaveCount(0);
  await expect(panel).toHaveAttribute('data-state', 'closing');
  await expect(panel).toHaveAttribute('aria-hidden', 'true');
  await expect(panel).toHaveAttribute('inert', '');
  await expect(panel).toHaveCount(0);

  await expect(page.locator('[data-action="menu-toggle"]')).toHaveCount(1);
  const reopen = rail.getByRole('button', { name: 'Open menu', exact: true });
  await expect(reopen).toBeVisible();
  await reopen.click();

  await expect(rail).toHaveAttribute('data-state', 'expanded');
  await expect(rail.locator('nav')).toBeVisible();
  await expect(panel).toHaveCount(0);

  await rail.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(panel).toHaveAttribute('data-state', 'open');
});

test('desktop aligns the leading rail divider with panel and chat headers', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/home');

  const railNavigation = page.locator('[data-component="navigation-rail"] nav');
  const toggleItem = railNavigation.locator('[data-item="menu-toggle"]');
  const chatHeader = page.locator('[data-slot="chat.header"]');

  await railNavigation.locator('[data-item="characters"] button').click();

  const panel = page.locator(
    '[data-component="navigation-panel"][data-panel="characters"][data-state="open"]',
  );
  const panelHeader = panel.locator('[data-component="sidebar-panel-header"]');

  await expect(panelHeader).toBeVisible();
  await expect(toggleItem).toHaveCSS('border-bottom-width', '1px');
  await expect(railNavigation.locator('[data-item="chats"]')).toHaveCSS('border-top-width', '0px');

  const [toggleItemBox, panelHeaderBox, chatHeaderBox] = await Promise.all([
    toggleItem.boundingBox(),
    panelHeader.boundingBox(),
    chatHeader.boundingBox(),
  ]);
  expect(toggleItemBox).not.toBeNull();
  expect(panelHeaderBox).not.toBeNull();
  expect(chatHeaderBox).not.toBeNull();

  const toggleBoundary = (toggleItemBox?.y ?? 0) + (toggleItemBox?.height ?? 0);
  const panelBoundary = (panelHeaderBox?.y ?? 0) + (panelHeaderBox?.height ?? 0);
  const chatBoundary = (chatHeaderBox?.y ?? 0) + (chatHeaderBox?.height ?? 0);
  expect(toggleBoundary).toBeCloseTo(panelBoundary, 1);
  expect(toggleBoundary).toBeCloseTo(chatBoundary, 1);
  await expectNoA11yViolations(page);
});

test('mobile keeps the single navigation toggle in the header row', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto('/home');

  const rail = page.locator('[data-component="navigation-rail"]');
  const railNavigation = rail.locator('nav');
  const header = page.locator('[data-slot="chat.header"]');
  const main = page.locator('[data-component="main-area"]');
  const toggle = railNavigation.locator('[data-action="menu-toggle"]');
  const toggleItem = toggle.locator('..');
  const chatsItem = railNavigation.locator('[data-item="chats"]');
  const charactersItem = railNavigation.locator('[data-item="characters"]');
  const avatar = header.locator('[data-part="character-avatar"]');

  await expect(toggle).toHaveCount(1);
  await expect(toggle).toHaveAttribute('data-state', 'expanded');
  await expect(railNavigation).toHaveAttribute('data-leading-menu-toggle', 'true');
  await expect(page.locator('[data-action="menu-toggle"]')).toHaveCount(1);
  await expect(rail.locator('[data-action="menu-toggle"]')).toHaveCount(1);
  await expect(rail.locator('[data-part="main-items"] [data-part="item"]').first()).toHaveAttribute(
    'data-item',
    'menu-toggle',
  );
  await expect(avatar).toBeVisible();
  await expect(header).toHaveCSS('border-bottom-width', '0px');
  await expect(toggleItem).toHaveCSS('border-bottom-width', '1px');
  await expect(chatsItem).toHaveCSS('border-top-width', '0px');
  await expect(charactersItem).toHaveCSS('border-top-width', '0px');

  const toggleBox = await toggle.boundingBox();
  const avatarBox = await avatar.boundingBox();
  const headerBox = await header.boundingBox();
  const railBox = await railNavigation.boundingBox();
  const toggleItemBox = await toggleItem.boundingBox();
  const expandedMainBox = await main.boundingBox();
  expect(toggleBox).not.toBeNull();
  expect(avatarBox).not.toBeNull();
  expect(headerBox).not.toBeNull();
  expect(railBox).not.toBeNull();
  expect(toggleItemBox).not.toBeNull();
  expect(expandedMainBox).not.toBeNull();
  expect((toggleItemBox?.x ?? 0) + (toggleItemBox?.width ?? 0)).toBeLessThan(headerBox?.x ?? 0);
  expect(toggleItemBox?.width ?? 0).toBeLessThan(railBox?.width ?? 0);
  expect((toggleBox?.x ?? 0) + (toggleBox?.width ?? 0)).toBeLessThanOrEqual(avatarBox?.x ?? 0);
  expect(
    Math.abs((toggleBox?.x ?? 0) + (toggleBox?.width ?? 0) / 2 - (railBox?.width ?? 0) / 2),
  ).toBeLessThanOrEqual(5);
  expect(
    Math.abs(
      (toggleBox?.y ?? 0) +
        (toggleBox?.height ?? 0) / 2 -
        ((headerBox?.y ?? 0) + (headerBox?.height ?? 0) / 2),
    ),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(
      (toggleBox?.y ?? 0) +
        (toggleBox?.height ?? 0) / 2 -
        ((avatarBox?.y ?? 0) + (avatarBox?.height ?? 0) / 2),
    ),
  ).toBeLessThanOrEqual(1);
  expect(railBox?.y ?? -1).toBeCloseTo(headerBox?.y ?? 0, 1);
  expect((toggleItemBox?.y ?? 0) + (toggleItemBox?.height ?? 0)).toBeCloseTo(
    (headerBox?.y ?? 0) + (headerBox?.height ?? 0),
    1,
  );
  const headerDivider = await header.evaluate((element) => {
    const style = getComputedStyle(element, '::after');
    return {
      borderWidth: style.borderBottomWidth,
      insetStart: Number.parseFloat(style.insetInlineStart),
      insetEnd: Number.parseFloat(style.insetInlineEnd),
      content: style.content,
    };
  });
  expect(headerDivider.borderWidth).toBe('1px');
  expect(headerDivider.content).not.toBe('none');
  expect(headerDivider.insetStart).toBeGreaterThan(0);
  expect(headerDivider.insetEnd).toBe(headerDivider.insetStart);
  const railInsets = await railNavigation.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      start: Number.parseFloat(style.paddingInlineStart),
      end: Number.parseFloat(style.paddingInlineEnd),
    };
  });
  expect(headerDivider.insetStart).toBe(railInsets.start);
  expect(headerDivider.insetEnd).toBe(railInsets.end);
  expect((toggleItemBox?.x ?? 0) + (toggleItemBox?.width ?? 0)).toBeLessThan(
    (headerBox?.x ?? 0) + headerDivider.insetStart,
  );
  await expectNoA11yViolations(page);
  expect(expandedMainBox?.x ?? -1).toBeCloseTo(railBox?.width ?? 0, 1);
  await expect(main).toHaveCSS('transition-property', 'margin-inline-start');

  await toggle.click();
  await expect(rail).toHaveAttribute('data-state', 'collapsed');
  await expect(rail.getByRole('button', { name: 'Open menu', exact: true })).toBeVisible();
  await expect(page.locator('[data-action="menu-toggle"]')).toHaveCount(1);
  await expect(toggleItem).toHaveCSS('border-bottom-width', '0px');
  await expect(main).toHaveCSS('margin-inline-start', '0px');

  const collapsedToggleBox = await toggle.boundingBox();
  const collapsedHeaderBox = await header.boundingBox();
  expect(collapsedToggleBox).not.toBeNull();
  expect(collapsedHeaderBox).not.toBeNull();
  expect(
    Math.abs(
      (collapsedToggleBox?.y ?? 0) +
        (collapsedToggleBox?.height ?? 0) / 2 -
        ((collapsedHeaderBox?.y ?? 0) + (collapsedHeaderBox?.height ?? 0) / 2),
    ),
  ).toBeLessThanOrEqual(1);

  const collapsedMainBox = await main.boundingBox();
  expect(collapsedMainBox?.x ?? -1).toBeCloseTo(0, 1);

  await rail.getByRole('button', { name: 'Open menu', exact: true }).click();
  await expect(rail).toHaveAttribute('data-state', 'expanded');
  await expect(railNavigation).toBeVisible();
  await expect(main).toHaveCSS('margin-inline-start', `${railBox?.width ?? 0}px`);
});

test('chat canvas exposes a theme-controlled wallpaper layer', async ({ page }) => {
  await page.goto('/home');
  const wallpaper = page.locator('[data-part="chat-wallpaper"]');
  await expect(wallpaper).toBeAttached();
  await expect(wallpaper).toHaveCSS('background-position', /50% 50%/);
});

test('PWA caches only the app shell and remains available offline', async ({ context, page }) => {
  await page.goto('/home');
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.reload();
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Chats' }),
  ).toBeVisible();

  const cachedUrls = await page.evaluate(async () => {
    const keys = await caches.keys();
    const requests = await Promise.all(
      keys.map(async (key) =>
        (await caches.open(key)).keys().then((items) => items.map((r) => r.url)),
      ),
    );
    return requests.flat();
  });
  expect(cachedUrls.some((url) => new URL(url).pathname.startsWith('/api/'))).toBe(false);

  await context.setOffline(true);
  try {
    await page.goto('/home', { waitUntil: 'domcontentloaded' });
    const panel = await openSettingsPanel(page);
    await expect(panel.getByRole('button', { name: 'Close menu' })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
