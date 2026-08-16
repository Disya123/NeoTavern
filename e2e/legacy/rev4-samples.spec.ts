/**
 * Rev4 sample plugins — full user-cycle smoke suite.
 *
 * Installs the repository's own rev4 examples (`plugins/rev4-tools`,
 * `plugins/rev4-blocks`, `plugins/rev4-agent`) through the Plugins panel,
 * consents to their capability requests, activates them, then drives their
 * registered commands from the plugin toolbar:
 *   - rev4-tools: command palette commands rendered as toolbar buttons, plus
 *     a kernel-port `chat.opened` subscription verified by opening a chat;
 *   - rev4-agent: backend worker spawned by the host — its route is reachable
 *     over HTTP and a command round-trips JSON through `api.backend.invoke`;
 *   - rev4-blocks: a message block attaches to the last chat message and
 *     mounts its DOM into the message bubble.
 *   - rev4-jobs: background jobs — retries deliver a flaky one-shot, cron
 *     schedules list and cancel, and an exhausted budget lands the job in
 *     the DLQ until it is retried.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { postJson, zipBuffer } from '../helpers.js';

const SAMPLES_ROOT = resolve(import.meta.dirname, '../plugins');

interface SampleFiles {
  pluginId: string;
  pluginName: string;
  checks: string[];
  entries: Record<string, string>;
}

function sampleFiles(id: string, pluginName: string, checks: string[]): SampleFiles {
  const entries: Record<string, string> = {};
  for (const name of [
    'plugin.json',
    'frontend.js',
    'backend.mjs',
    'workers/double.js',
    'workers/triple.mjs',
  ]) {
    const path = resolve(SAMPLES_ROOT, id, name);
    try {
      entries[name] = readFileSync(path, 'utf8');
    } catch {
      // optional file (backend)
    }
  }
  return { pluginId: `neotavern.${id}`, pluginName, checks, entries };
}

async function installAndActivate(page: Page, sample: SampleFiles): Promise<Locator> {
  // The e2e data directory persists between runs: start from a clean slate so
  // re-running the suite is deterministic.
  await page.request.delete(`/api/v2/plugins/${sample.pluginId}`).catch(() => undefined);
  const archive = zipBuffer(sample.entries);
  await page.goto('/plugins');
  await page.getByLabel('Install plugin package').setInputFiles({
    name: `${sample.pluginId}.stplugin`,
    mimeType: 'application/zip',
    buffer: archive,
  });
  await expect(
    page.getByText(`Installed ${sample.pluginName}. Review its permissions before activation.`),
  ).toBeVisible();

  const card = page
    .locator('[data-component="plugin-card"]')
    .filter({ hasText: sample.pluginName });
  await expect(card).toHaveAttribute('data-state', 'needs-consent');
  for (const permission of sample.checks) {
    await card
      .getByRole('checkbox', { name: new RegExp(permission.replaceAll('.', '\\.'), 'u') })
      .check();
  }
  await card.getByRole('button', { name: 'Activate' }).click();
  await expect(card).toHaveAttribute('data-state', 'active');
  await expect(page.getByText(`Activated ${sample.pluginName}.`)).toBeVisible();
  return card;
}

test('rev4-tools: activates and runs palette commands from the plugin toolbar', async ({
  page,
}) => {
  const sample = sampleFiles('rev4-tools', 'Rev4 Tools Example', [
    'ui.commands',
    'notifications.show',
  ]);
  await installAndActivate(page, sample);

  await page.goto('/');
  const toolbar = page.locator('[data-component="plugin-toolbar"]');
  await expect(toolbar).toBeVisible();

  await toolbar.getByRole('button', { name: 'Rev4 tools: roll d20' }).click();
  await expect(page.locator('[data-component="plugin-notification-layer"]')).toContainText(
    /d20 = \d+/u,
  );

  await toolbar.getByRole('button', { name: 'Rev4 tools: show limits' }).click();
  await expect(page.locator('[data-component="plugin-notification-layer"]')).toContainText(
    /kvBytes=\d+/u,
  );

  // Kernel diagnostics slice (rev4 §C): the plugin reads its own runtime
  // snapshot over the kernel port — no capability required.
  await toolbar.getByRole('button', { name: 'Rev4 tools: show diagnostics' }).click();
  await expect(page.locator('[data-component="plugin-notification-layer"]')).toContainText(
    /protocol=2\.0\.0 sdk=1\.0\.0 instanceId=rev4:/u,
  );

  // Kernel events slice (rev4 §E1): the plugin subscribed to 'chat.opened'
  // during activation; opening a chat relays the event over the kernel port.
  //
  // A hard `page.goto('/chats/:id')` may emit the event before the fresh
  // sandbox frame's subscription lands (the host relay only exists once the
  // sandbox calls `events.subscribe`), so after the frame is ready we
  // re-open the chat through another GET and retry until the relayed event
  // is observed — SSE delivery is asynchronous.
  const suffix = Date.now().toString(36);
  const character = await postJson(page, '/characters', {
    name: `Events Character ${suffix}`,
    description: 'Created by the rev4 samples e2e suite.',
  });
  const chat = await postJson(page, '/chats', {
    characterId: character['id'],
    title: `Events Chat ${suffix}`,
  });
  await page.goto(`/chats/${chat['id']}`);
  await expect(toolbar.getByRole('button', { name: 'Rev4 tools: show events' })).toBeVisible();
  await expect(async () => {
    await page.request.get(`/api/v2/chats/${chat['id']}`);
    await toolbar.getByRole('button', { name: 'Rev4 tools: show events' }).click();
    await expect(page.locator('[data-component="plugin-notification-layer"]')).toContainText(
      'chat opened events: 1',
    );
  }).toPass({ timeout: 15_000 });
});

test('rev4-agent: activates a backend worker and round-trips JSON through its route', async ({
  page,
}) => {
  const sample = sampleFiles('rev4-agent', 'Rev4 Agent Example', [
    'server.routes',
    'compute.backend',
    'ui.commands',
    'chats.read.current',
    'chats.write.plugin',
    'notifications.show',
  ]);
  await installAndActivate(page, sample);

  // The backend route is live through the host dispatcher (worker spawned).
  const status = await page.request.get(`/api/plugins/${sample.pluginId}/agent/status`);
  expect(status.ok()).toBe(true);
  const statusBody = (await status.json()) as { ok: boolean; plugin: string };
  expect(statusBody.ok).toBe(true);
  expect(statusBody.plugin).toBe(sample.pluginId);

  await page.goto('/');
  const toolbar = page.locator('[data-component="plugin-toolbar"]');
  await toolbar.getByRole('button', { name: 'Rev4 agent: tick backend' }).click();
  await expect(page.locator('[data-component="plugin-notification-layer"]')).toContainText(
    /tick=1/u,
  );
});

test('rev4-blocks: attaches a message block to the last chat message', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const character = await postJson(page, '/characters', {
    name: `Blocks Character ${suffix}`,
    description: 'Created by the rev4 samples e2e suite.',
  });
  const chat = await postJson(page, '/chats', {
    characterId: character['id'],
    title: `Blocks Chat ${suffix}`,
  });
  const chatId = String(chat['id']);

  await page.goto(`/chats/${chatId}`);
  await page.getByLabel(/Type a message/iu).fill(`Seed message ${suffix}`);
  await page.getByRole('button', { name: 'Send' }).click();
  const assistantBubble = page.locator(
    '[data-component="chat-message"][data-role="assistant"][data-state="done"]',
  );
  await expect(assistantBubble).toBeVisible({ timeout: 20_000 });

  const sample = sampleFiles('rev4-blocks', 'Rev4 Blocks Example', [
    'ui.messageBlock',
    'ui.commands',
    'chats.read.current',
    'notifications.show',
  ]);
  await installAndActivate(page, sample);

  await page.goto(`/chats/${chatId}`);
  const toolbar = page.locator('[data-component="plugin-toolbar"]');
  await toolbar
    .getByRole('button', { name: 'Rev4 blocks: attach counter to last message' })
    .click();
  await expect(page.locator('[data-component="plugin-notification-layer"]')).toContainText(
    /attached/u,
  );

  // The block mounts inside the last (assistant) message bubble. The host
  // keeps a geometry-anchor slot in the message DOM; the plugin's sandbox
  // renders the actual content into its own clipped container in the frame.
  await expect(
    page.locator(
      '[data-component="chat-message"][data-role="assistant"] [data-part="plugin-block"]',
    ),
  ).toBeVisible();
  const sandboxFrame = page.frameLocator(
    `[data-component="plugin-sandbox-frame"][data-plugin-id="${sample.pluginId}"]`,
  );
  await expect(sandboxFrame.locator('[data-neotavern-registration]')).toContainText('count = 3');

  // Persistence (rev4 stage 4): the attachment is durable server data. Freeze
  // a renderer state from "another client" (the REST PATCH), reload the page
  // and the block must remount with that state restored.
  const messagePage = await page.request.get(`/api/v2/chats/${chatId}/messages?limit=5`);
  const messageItems = (await messagePage.json())['items'] as Array<{ id: string }>;
  const lastMessageId = messageItems[0]?.id;
  expect(lastMessageId).toBeTruthy();
  const blocksPage = await page.request.get(
    `/api/v2/chats/${chatId}/blocks?messageIds=${lastMessageId}`,
  );
  const blockItems = (await blocksPage.json())['items'] as Array<{ id: string }>;
  expect(blockItems).toHaveLength(1);
  const statePatch = await page.request.patch(`/api/v2/blocks/${blockItems[0]!.id}`, {
    data: { serializedState: { count: 4 } },
  });
  expect(statePatch.ok()).toBe(true);

  await page.reload();
  const reloadedFrame = page.frameLocator(
    `[data-component="plugin-sandbox-frame"][data-plugin-id="${sample.pluginId}"]`,
  );
  await expect(reloadedFrame.locator('[data-neotavern-registration]')).toContainText('count = 4', {
    timeout: 15_000,
  });
});

test('rev4-worker: spawns an isolated compute worker and round-trips a message', async ({
  page,
}) => {
  const sample = sampleFiles('rev4-worker', 'Rev4 Worker Example', [
    'ui.commands',
    'compute.worker',
    'notifications.show',
  ]);
  await installAndActivate(page, sample);

  await page.goto('/');
  const toolbar = page.locator('[data-component="plugin-toolbar"]');
  await expect(toolbar).toBeVisible();

  await toolbar.getByRole('button', { name: 'Rev4 worker: spawn + round-trip' }).click();
  await expect(page.locator('[data-component="plugin-notification-layer"]')).toContainText(
    'doubled 21 -> 42',
  );

  // Module worker (.mjs entry): constructed with { type: 'module' } inside
  // the sandbox (ADR-0018, spike 6 pins the browser capability).
  await toolbar.getByRole('button', { name: 'Rev4 worker: module spawn + round-trip' }).click();
  await expect(page.locator('[data-component="plugin-notification-layer"]')).toContainText(
    'tripled 14 -> 42',
  );

  // Capability state is visible to the plugin without a host round-trip.
  await toolbar.getByRole('button', { name: 'Rev4 worker: capability state' }).click();
  await expect(page.locator('[data-component="plugin-notification-layer"]')).toContainText(
    'compute.worker granted: true',
  );
});

test('rev4-grant: runtime capability consent round-trip (allow, deny, persist)', async ({
  page,
}) => {
  const sample = sampleFiles('rev4-grant', 'Rev4 Runtime Grant Example', [
    'ui.commands',
    'notifications.show',
  ]);
  await installAndActivate(page, sample);

  await page.goto('/');
  const toolbar = page.locator('[data-component="plugin-toolbar"]');
  await expect(toolbar.getByRole('button', { name: 'Rev4 grant: check camera' })).toBeVisible();
  const notifications = page.locator('[data-component="plugin-notification-layer"]');

  // Not granted at install time: `camera.request` is not in the manifest.
  await toolbar.getByRole('button', { name: 'Rev4 grant: check camera' }).click();
  await expect(notifications).toContainText('camera.request granted = false');

  // Deny path: the consent dialog rejects the request with CAPABILITY_DENIED.
  await toolbar.getByRole('button', { name: 'Rev4 grant: request camera' }).click();
  const consent = page.locator('[data-component="plugin-consent-dialog"]');
  const dialogContent = page.locator('[data-component="dialog-content"]');
  await expect(consent).toBeVisible();
  await expect(dialogContent).toContainText('camera.request');
  await consent.getByRole('button', { name: 'Deny' }).click();
  await expect(consent).toBeHidden();
  await expect(notifications).toContainText(/denied: CAPABILITY_DENIED/u);
  await toolbar.getByRole('button', { name: 'Rev4 grant: check camera' }).click();
  await expect(notifications).toContainText('camera.request granted = false');

  // Allow path: the grant is persisted server-side.
  await toolbar.getByRole('button', { name: 'Rev4 grant: request camera' }).click();
  await expect(consent).toBeVisible();
  await consent.getByRole('button', { name: 'Allow' }).click();
  await expect(consent).toBeHidden();
  await expect(notifications).toContainText(/granted: name=camera\.request revision=\d+/u);
  await toolbar.getByRole('button', { name: 'Rev4 grant: check camera' }).click();
  await expect(notifications).toContainText('camera.request granted = true');

  // The grant survives a reload (it lives in the database, not the frame).
  await page.reload();
  await expect(toolbar.getByRole('button', { name: 'Rev4 grant: check camera' })).toBeVisible();
  await toolbar.getByRole('button', { name: 'Rev4 grant: check camera' }).click();
  await expect(notifications).toContainText('camera.request granted = true');

  // Re-requesting after a reload resolves immediately (already granted) and
  // must not open the dialog again.
  await toolbar.getByRole('button', { name: 'Rev4 grant: request camera' }).click();
  await expect(notifications).toContainText(/granted: name=camera\.request revision=\d+/u);
  await expect(consent).toBeHidden();
});

test('rev4-overlay: proxy overlay forwards shape-gated pointer packets', async ({ page }) => {
  const sample = sampleFiles('rev4-overlay', 'Rev4 Overlay Example', ['ui.overlay', 'ui.commands']);
  await installAndActivate(page, sample);
  // The plugins panel is a modal above the overlay hit layer; leave it so
  // pointer events reach the host hit-div.
  await page.goto('/');

  const sandbox = page.frameLocator(
    `[data-component="plugin-sandbox-frame"][data-plugin-id="${sample.pluginId}"]`,
  );
  await expect(sandbox.locator('html')).toHaveAttribute('data-overlay-ready', '1', {
    timeout: 20_000,
  });

  const hitDiv = page.locator('[data-part="plugin-overlay-hit"]');
  await expect(hitDiv).toBeVisible();
  const box = await hitDiv.boundingBox();
  expect(box).not.toBeNull();
  // One click yields move+down+up packets; assert on counters, not clicks.
  const readPackets = async (): Promise<number> =>
    Number((await sandbox.locator('html').getAttribute('data-overlay-packets')) ?? '0');

  // Circle center: inside the hit shape -> packets forwarded to the plugin.
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect.poll(readPackets).toBeGreaterThan(0);
  const afterFirst = await readPackets();

  // Rect corner: inside the overlay rect but outside the circle -> silent.
  await page.mouse.click(box!.x + 5, box!.y + 5);
  await page.waitForTimeout(250);
  expect(await readPackets()).toBe(afterFirst);

  // A second center click resumes the packet flow.
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect.poll(readPackets).toBeGreaterThan(afterFirst);

  // Uninstall: the absorbing/forwarding hit-divs must vanish with the plugin
  // (cleanup contract), otherwise they keep intercepting page pointer events.
  await page.request.delete(`/api/v2/plugins/${sample.pluginId}`);
  await expect(hitDiv).toHaveCount(0);
});

test('rev4-overlay: full overlay shows host chrome and closes via sandbox Escape', async ({
  page,
}) => {
  const sample = sampleFiles('rev4-overlay', 'Rev4 Overlay Example', ['ui.overlay', 'ui.commands']);
  await installAndActivate(page, sample);
  await page.goto('/');

  // The full overlay is command-driven: nothing is on screen until the user
  // asks for it, and the host chrome appears the moment it mounts.
  const toolbar = page.locator('[data-component="plugin-toolbar"]');
  const chrome = page.locator('[data-component="plugin-overlay-chrome"]');
  await expect(chrome).toHaveCount(0);
  await expect(
    toolbar.getByRole('button', { name: 'Rev4 overlay: full overlay (host chrome)' }),
  ).toBeVisible();
  await toolbar.getByRole('button', { name: 'Rev4 overlay: full overlay (host chrome)' }).click();

  // The host chrome names the plugin and carries the host-controlled close.
  await expect(chrome).toBeVisible({ timeout: 10_000 });
  await expect(chrome).toContainText('Rev4 Overlay Example');
  const sandbox = page.frameLocator(
    `[data-component="plugin-sandbox-frame"][data-plugin-id="${sample.pluginId}"]`,
  );
  await expect(sandbox.locator('html')).toHaveAttribute('data-overlay-full-ready', '1', {
    timeout: 10_000,
  });

  // Focus inside the sandbox iframe: the host never sees the key, but the
  // sandbox relays Escape and the host tears the overlay down (rev4 §G7).
  // The sandbox body is 0-height (the canvas is position:fixed), so focus
  // lands via a click on the canvas itself.
  await sandbox.locator('canvas').click({ position: { x: 40, y: 40 } });
  await page.keyboard.press('Escape');
  await expect(chrome).toHaveCount(0, { timeout: 10_000 });

  await page.request.delete(`/api/v2/plugins/${sample.pluginId}`);
});

test('rev4-lifecycle: suspend/resume on tab visibility and update hooks via KV', async ({
  page,
}) => {
  const sample = sampleFiles('rev4-lifecycle', 'Rev4 Lifecycle Example', [
    'ui.commands',
    'storage.user',
    'notifications.show',
  ]);
  await installAndActivate(page, sample);
  await page.goto('/');

  const toolbar = page.locator('[data-component="plugin-toolbar"]');
  const notifications = page.locator('[data-component="plugin-notification-layer"]');
  const sandbox = page.frameLocator(
    `[data-component="plugin-sandbox-frame"][data-plugin-id="${sample.pluginId}"]`,
  );
  await expect(
    toolbar.getByRole('button', { name: 'Rev4 lifecycle: show hook log' }),
  ).toBeVisible();

  // Fresh activation: the KV hook log is empty.
  await toolbar.getByRole('button', { name: 'Rev4 lifecycle: show hook log' }).click();
  await expect(notifications).toContainText('hooks: (none)');

  // Tab hidden → the host suspends the sandbox; visible → resume.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(sandbox.locator('html')).toHaveAttribute('data-lifecycle-state', 'suspended');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(sandbox.locator('html')).toHaveAttribute('data-lifecycle-state', 'active');

  // Update to v2: the server announces updating/updated over SSE, the web
  // runtime forwards beforeUpdate/afterUpdate to the sandbox, and the KV
  // log (persisted per plugin) survives the sandbox replacement.
  const v2Entries = {
    ...sample.entries,
    'plugin.json': sample.entries['plugin.json']!.replace(
      '"version": "1.0.0"',
      '"version": "2.0.0"',
    ),
  };
  await page.goto('/plugins');
  await page.getByLabel('Install plugin package').setInputFiles({
    name: `${sample.pluginId}.stplugin`,
    mimeType: 'application/zip',
    buffer: zipBuffer(v2Entries),
  });
  await expect(page.getByText(new RegExp(`Updated ${sample.pluginName}`, 'u'))).toBeVisible({
    timeout: 20_000,
  });
  // The afterUpdate hook is delivered to the pre-replacement sandbox and its
  // KV write is awaited by the host before the frame swap (rev4 §J2), so the
  // log pair is durable by the time the v2 frame appears. The settle wait is
  // insurance for the SSE delivery lag behind the install response.
  await page.waitForTimeout(1000);

  // A reload brings up the v2 sandbox; the hook log shows the update pair.
  await page.goto('/');
  await expect(
    toolbar.getByRole('button', { name: 'Rev4 lifecycle: show hook log' }),
  ).toBeVisible();
  await toolbar.getByRole('button', { name: 'Rev4 lifecycle: show hook log' }).click();
  await expect(notifications).toContainText('hooks: beforeUpdate, afterUpdate', {
    timeout: 15_000,
  });

  await page.request.delete(`/api/v2/plugins/${sample.pluginId}`);
});

test('rev4-crash: a dead sandbox is restarted by the host', async ({ page }) => {
  const sample = sampleFiles('rev4-crash', 'Rev4 Crash Example', ['ui.commands']);
  await installAndActivate(page, sample);
  await page.goto('/');

  const toolbar = page.locator('[data-component="plugin-toolbar"]');
  const boomButton = toolbar.getByRole('button', {
    name: 'Rev4 crash: blow up the sandbox (host restarts it)',
  });
  await expect(boomButton).toBeVisible();

  // The command navigates the sandbox document away: the kernel session
  // port closes and the host restarts the frame under the restart budget,
  // showing a host-owned crash notification.
  await boomButton.click();
  await expect(
    page.getByText('Plugin Rev4 Crash Example stopped responding and was restarted'),
  ).toBeVisible({ timeout: 15_000 });

  // The fresh sandbox re-activates and re-registers the command.
  await expect(boomButton).toBeVisible({ timeout: 20_000 });
  await page.request.delete(`/api/v2/plugins/${sample.pluginId}`);
});

test('rev4-events: cursor replay redelivers events missed during a dropped stream', async ({
  page,
}) => {
  const sample = sampleFiles('rev4-events', 'Rev4 Events Example', [
    'ui.commands',
    'storage.user',
    'notifications.show',
  ]);
  await installAndActivate(page, sample);
  await page.goto('/');

  const toolbar = page.locator('[data-component="plugin-toolbar"]');
  const notifications = page.locator('[data-component="plugin-notification-layer"]');
  await expect(toolbar.getByRole('button', { name: 'Rev4 events: show seen log' })).toBeVisible();

  // Open a chat: the live stream delivers `chat.opened` (rev4 §J1). The
  // goto itself may emit before the fresh sandbox's subscription lands, so
  // re-open the chat (server-side, no navigation) until the stream sees one.
  const suffix = Date.now().toString(36);
  const character = await postJson(page, '/characters', {
    name: `Events Character ${suffix}`,
    description: 'Created by the rev4 samples e2e suite.',
  });
  const firstChat = await postJson(page, '/chats', {
    characterId: character['id'],
    title: `Events Chat ${suffix}`,
  });
  await page.goto(`/chats/${firstChat['id']}`);
  await expect(toolbar.getByRole('button', { name: 'Rev4 events: show seen log' })).toBeVisible();
  await expect(async () => {
    await page.request.get(`/api/v2/chats/${firstChat['id']}`);
    await toolbar.getByRole('button', { name: 'Rev4 events: show seen log' }).click();
    await expect(notifications).toContainText('(live)');
  }).toPass({ timeout: 15_000 });

  // Drop the stream: re-opening the chat (a server-side open, no page
  // navigation) emits another `chat.opened` that the plugin misses.
  await toolbar.getByRole('button', { name: 'Rev4 events: drop the stream' }).click();
  await page.request.get(`/api/v2/chats/${firstChat['id']}`);

  // Replay: the plugin resumes at its saved cursor and the host redelivers
  // the missed event from the bounded ring buffer (tagged replay).
  await toolbar.getByRole('button', { name: 'Rev4 events: resume with cursor replay' }).click();
  await expect(async () => {
    await toolbar.getByRole('button', { name: 'Rev4 events: show seen log' }).click();
    await expect(notifications).toContainText('(replay)');
  }).toPass({ timeout: 15_000 });

  await page.request.delete(`/api/v2/plugins/${sample.pluginId}`);
});

test('rev4-multiwindow: the background singleton moves to the surviving window', async ({
  page,
  context,
}) => {
  const sample = sampleFiles('rev4-multiwindow', 'Rev4 Multiwindow Example', [
    'ui.commands',
    'storage.user',
    'notifications.show',
  ]);
  await installAndActivate(page, sample);
  await page.goto('/');

  const toolbar = page.locator('[data-component="plugin-toolbar"]');
  const sandbox = (target: Page): ReturnType<Page['frameLocator']> =>
    target.frameLocator(
      `[data-component="plugin-sandbox-frame"][data-plugin-id="${sample.pluginId}"]`,
    );
  await expect(toolbar.getByRole('button', { name: 'Rev4 multiwindow: show role' })).toBeVisible();

  // A second window activates the same installation. The host election is
  // deterministic by the smallest window id — NOT by load order — so either
  // window may win; the invariant is: exactly one primary, one secondary.
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.locator('[data-component="plugin-toolbar"]')).toBeVisible();
  await expect(sandbox(second).locator('html')).toHaveAttribute(
    'data-bg-role',
    /primary|secondary/u,
    { timeout: 15_000 },
  );

  const readRole = async (target: Page): Promise<{ role: string; windowId: string }> => {
    await target
      .locator('[data-component="plugin-toolbar"]')
      .getByRole('button', { name: 'Rev4 multiwindow: show role' })
      .click();
    const text = await target.locator('[data-component="plugin-notification-layer"]').textContent();
    const matches = [...(text ?? '').matchAll(/role: (\w+) window=(\S+)/gu)];
    const latest = matches.at(-1);
    expect(latest).toBeTruthy();
    return { role: latest![1]!, windowId: latest![2]! };
  };

  // Election converges within one heartbeat round (claims exchanged over
  // BroadcastChannel); read both roles until they diverge — the leader is
  // the smaller window id, regardless of load order.
  let first = { role: 'primary', windowId: '' };
  let secondRole = { role: 'secondary', windowId: '' };
  await expect(async () => {
    first = await readRole(page);
    secondRole = await readRole(second);
    expect(first.role).not.toBe(secondRole.role);
  }).toPass({ timeout: 15_000 });
  expect(new Set([first.role, secondRole.role])).toEqual(new Set(['primary', 'secondary']));
  expect(first.windowId).not.toBe(secondRole.windowId);

  // The primary dies (tab close): the surviving window takes over — the
  // release is best-effort, so takeover lands within the lease margin.
  const survivor = first.role === 'primary' ? second : page;
  const dead = first.role === 'primary' ? page : second;
  const survivorId = first.role === 'primary' ? secondRole.windowId : first.windowId;
  await dead.close();
  await expect(sandbox(survivor).locator('html')).toHaveAttribute('data-bg-role', 'primary', {
    timeout: 20_000,
  });
  // The singleton moved: the surviving window now owns the KV counter and
  // keeps ticking it.
  await expect(async () => {
    await survivor
      .locator('[data-component="plugin-toolbar"]')
      .getByRole('button', { name: 'Rev4 multiwindow: show background owner' })
      .click();
    await expect(survivor.locator('[data-component="plugin-notification-layer"]')).toContainText(
      new RegExp(`owner=${survivorId} ticks=[1-9]`, 'u'),
    );
  }).toPass({ timeout: 20_000 });

  await survivor.request.delete(`/api/v2/plugins/${sample.pluginId}`);
  await survivor.close();
});

test('rev4-draft: streams a server-side draft, commits it, and dedupes appends by key', async ({
  page,
}) => {
  const sample = sampleFiles('rev4-draft', 'Rev4 Draft Example', [
    'ui.commands',
    'chats.draft',
    'chats.write.plugin',
    'notifications.show',
  ]);
  await installAndActivate(page, sample);

  // The sandbox needs a focused chat for drafts to resolve against.
  const suffix = Date.now().toString(36);
  const character = await postJson(page, '/characters', {
    name: `Draft Character ${suffix}`,
    description: 'Created by the rev4 samples e2e suite.',
  });
  const chat = await postJson(page, '/chats', {
    characterId: character['id'],
    title: `Draft Chat ${suffix}`,
  });
  await page.goto(`/chats/${chat['id']}`);
  const toolbar = page.locator('[data-component="plugin-toolbar"]');
  await expect(toolbar.getByRole('button', { name: 'Rev4 draft: stream & commit' })).toBeVisible();

  // Stream three chunks and commit: the final assistant message appears in
  // the chat (commit → chat.message.created → SSE → message list
  // invalidation) — no half-written plugin message is ever visible.
  await toolbar.getByRole('button', { name: 'Rev4 draft: stream & commit' }).click();
  await expect(page.locator('[data-component="plugin-notification-layer"]')).toContainText(
    /committed /u,
  );
  await expect(
    page
      .locator('[data-component="chat-message"]')
      .filter({ hasText: 'Hello from a streaming draft. Committed by rev4-draft.' }),
  ).toBeVisible();

  // Outbox: the same idempotencyKey replayed returns the original message.
  await toolbar.getByRole('button', { name: 'Rev4 draft: idempotent append' }).click();
  await expect(page.locator('[data-component="plugin-notification-layer"]')).toContainText(
    'same=true',
  );

  await page.request.delete(`/api/v2/plugins/${sample.pluginId}`);
});

test('rev4-jobs: retries deliver flaky jobs, cron cancels, DLQ roundtrips', async ({ page }) => {
  const sample = sampleFiles('rev4-jobs', 'Rev4 Jobs Example', [
    'jobs.background',
    'ui.commands',
    'notifications.show',
  ]);
  await installAndActivate(page, sample);

  await page.goto('/');
  const toolbar = page.locator('[data-component="plugin-toolbar"]');
  const notifications = page.locator('[data-component="plugin-notification-layer"]');
  await expect(
    toolbar.getByRole('button', { name: 'Rev4 jobs: flaky one-shot with retries' }),
  ).toBeVisible();

  // Flaky one-shot: two transient failures, delivered on the third dispatch.
  await toolbar.getByRole('button', { name: 'Rev4 jobs: flaky one-shot with retries' }).click();
  await expect(notifications).toContainText('flaky scheduled', { timeout: 5000 });
  await expect(notifications).toContainText('flaky delivered after 3 dispatch(es)', {
    timeout: 15_000,
  });

  // The successful one-shot is deleted server-side.
  const jobs = await page.request.get(`/api/v2/plugins/${sample.pluginId}/jobs`);
  expect(jobs.ok()).toBe(true);
  const jobsBody = (await jobs.json()) as { items: Array<{ name: string }> };
  expect(jobsBody.items.filter((entry) => entry.name === 'flaky')).toHaveLength(0);

  // Cron: scheduled with the expression, listed, then cancelled by the plugin.
  await toolbar.getByRole('button', { name: 'Rev4 jobs: cron schedule then cancel' }).click();
  await expect(notifications).toContainText('cron scheduled', { timeout: 5000 });
  await expect(notifications).toContainText('cron job cancelled', { timeout: 10_000 });

  // DLQ roundtrip: the budget is exhausted, the job lands in the DLQ with
  // the last error, `retry` re-enqueues it and the next dispatch succeeds.
  await toolbar.getByRole('button', { name: 'Rev4 jobs: DLQ roundtrip' }).click();
  await expect(notifications).toContainText('job in DLQ: lastError=transient-2 attempts=2', {
    timeout: 15_000,
  });
  await expect(notifications).toContainText('dlq delivered after 3 dispatch(es)', {
    timeout: 15_000,
  });

  // The DLQ one-shot is deleted after the successful retried dispatch.
  const after = await page.request.get(`/api/v2/plugins/${sample.pluginId}/jobs`);
  const afterBody = (await after.json()) as { items: Array<{ name: string }> };
  expect(afterBody.items.filter((entry) => entry.name === 'dlq-demo')).toHaveLength(0);

  await page.request.delete(`/api/v2/plugins/${sample.pluginId}`);
});

test('rev4-modelmenu: the model menu lists models of the active provider and commits a pick', async ({
  page,
}) => {
  // The echo provider answers /models with [{ id: 'echo', name: 'Echo (offline)' }].
  const suffix = Date.now().toString(36);
  const providerName = `Model Menu Echo ${suffix}`;
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

  const sample = sampleFiles('rev4-modelmenu', 'Rev4 Model Menu Example', [
    'models.list',
    'ui.sidebar',
  ]);
  await installAndActivate(page, sample);

  await page.goto('/home');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  const settingsPanel = page.getByRole('region', { name: 'Settings', exact: true });
  await expect(settingsPanel).toBeVisible();
  await settingsPanel
    .getByRole('tab', { name: 'Model menu', description: sample.pluginName })
    .click();

  // The sandbox widget resolves the omitted providerId to the active echo
  // provider, lists its model and commits the pick into its own document.
  const frame = page.frameLocator(`iframe[data-plugin-id="${sample.pluginId}"]`);
  const menu = frame.getByRole('combobox', { name: 'Model' });
  await expect(menu).toBeVisible();
  // The sandbox widget mirrors the host theme tokens: its input background
  // equals the host's resolved --st-color-surface-elevated and it carries the
  // same data-component marker as the host ModelMenu (no proprietary skin).
  const hostSurface = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--st-color-surface-elevated)';
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });
  await expect(menu).toHaveCSS('background-color', hostSurface);
  await expect(frame.locator('[data-component="model-menu"]')).toBeVisible();
  await menu.click();
  // Wait for discovery to settle before scrolling: the load re-renders the
  // listbox, and a click racing that rebuild would miss the option.
  await expect(frame.locator('small')).toContainText('1 models loaded.');
  // The widget sits at the bottom of the settings panel and its listbox opens
  // downward. The sandbox frame is a full-screen overlay clipped to the
  // plugin host rect, so the dropdown is initially below the app viewport —
  // scroll the panel (the host re-lays the clip out after the scroll) and
  // only then assert and click the option.
  await settingsPanel.locator('[data-radix-scroll-area-viewport]').evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  const option = frame.getByRole('option', { name: 'Echo (offline)' });
  await expect(option).toBeVisible();
  await option.click();
  await expect(frame.locator('html')).toHaveAttribute('data-model-menu-value', 'echo');

  await page.request.delete(`/api/v2/plugins/${sample.pluginId}`);
  await page.request.delete(`/api/v2/providers/${providerId}`);
});

test('rev4-translate: message action receives message content and notifies', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const character = await postJson(page, '/characters', {
    name: `Translate Character ${suffix}`,
    description: 'Created by the rev4 samples e2e suite.',
  });
  const chat = await postJson(page, '/chats', {
    characterId: character['id'],
    title: `Translate Chat ${suffix}`,
  });
  const chatId = String(chat['id']);
  // Seed an assistant message directly so the action has content to read
  // without waiting on a generation round-trip.
  const seeded = await postJson(page, `/chats/${chatId}/messages`, {
    role: 'assistant',
    content: `Bonjour le monde ${suffix}`,
  });
  expect(String(seeded['id'])).toBeTruthy();

  const sample = sampleFiles('rev4-translate', 'Rev4 Translate Action Example', [
    'chat.read',
    'ui.messageActions',
    'ui.surfaces',
    'notifications.show',
  ]);
  await installAndActivate(page, sample);

  await page.goto(`/chats/${chatId}`);
  const actions = page.locator('[data-component="plugin-message-actions"]');
  await expect(actions.getByRole('button', { name: 'Translate' })).toBeVisible();
  await actions.getByRole('button', { name: 'Translate' }).click();
  // The sandbox runner read context.message.content (chat.read granted) and
  // reported the mock translation through api.notify over the kernel port.
  await expect(page.locator('[data-component="plugin-notification-layer"]')).toContainText(
    `[TR] Bonjour le monde ${suffix}`,
    { timeout: 10_000 },
  );

  await page.request.delete(`/api/v2/plugins/${sample.pluginId}`);
});
