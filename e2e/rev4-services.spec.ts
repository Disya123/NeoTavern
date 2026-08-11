/**
 * Rev4 cross-plugin services sample — full user-cycle smoke suite.
 *
 * Installs two sandboxed plugins from `plugins/` with their real frontend.js
 * files (plugin.json templated with the actual ids):
 *  1. `plugins/rev4-service` (provider, capability `services.provide`);
 *  2. `plugins/rev4-service-client` (consumer, capability `services.connect`).
 *
 * The suite walks the whole flow:
 *  1. the provider publishes `neotavern.rev4-service.greeter`;
 *  2. the consumer lists it, connects and invokes `greet`/`echo` across the
 *     host-mediated boundary — the provider's sandbox answers;
 *  3. disabling the provider degrades the consumer call to a graceful
 *     "not found" notification instead of a crash.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { zipBuffer } from './helpers.js';

const SAMPLES_ROOT = resolve(import.meta.dirname, '../plugins');
const PROVIDER_ID = 'neotavern.rev4-service';
const CLIENT_ID = 'neotavern.rev4-service-client';
const SERVICE_ID = 'neotavern.rev4-service.greeter';

function pluginEntries(dir: string): Record<string, string> {
  return {
    'plugin.json': readFileSync(resolve(SAMPLES_ROOT, `${dir}/plugin.json`), 'utf8'),
    'frontend.js': readFileSync(resolve(SAMPLES_ROOT, `${dir}/frontend.js`), 'utf8'),
  };
}

async function installAndActivate(
  page: Page,
  id: string,
  entries: Record<string, string>,
  pluginName: string,
  permissions: string[],
): Promise<void> {
  await page.request.delete(`/api/v2/plugins/${id}`).catch(() => undefined);
  const archive = zipBuffer(entries);
  await page.goto('/plugins');
  await page.getByLabel('Install plugin package').setInputFiles({
    name: `${id}.stplugin`,
    mimeType: 'application/zip',
    buffer: archive,
  });
  await expect(
    page.getByText(
      new RegExp(
        `Installed ${pluginName.replaceAll('.', '\\.')}\\. Review its permissions before activation\\.`,
        'u',
      ),
    ),
  ).toBeVisible();

  const card = page.locator('[data-component="plugin-card"]').filter({ hasText: pluginName });
  await expect(card).toHaveAttribute('data-state', 'needs-consent');
  for (const permission of permissions) {
    await card
      .getByRole('checkbox', { name: new RegExp(permission.replaceAll('.', '\\.'), 'u') })
      .check();
  }
  await card.getByRole('button', { name: 'Activate' }).click();
  await expect(card).toHaveAttribute('data-state', 'active');
}

test('rev4-services: cross-plugin provide/connect/invoke and graceful provider loss', async ({
  page,
}) => {
  await installAndActivate(
    page,
    PROVIDER_ID,
    pluginEntries('rev4-service'),
    'Rev4 Service Example',
    ['services.provide', 'ui.commands', 'notifications.show'],
  );
  await installAndActivate(
    page,
    CLIENT_ID,
    pluginEntries('rev4-service-client'),
    'Rev4 Service Client Example',
    ['services.connect', 'ui.commands', 'notifications.show'],
  );

  const toolbar = page.locator('[data-component="plugin-toolbar"]');
  const notifications = page.locator('[data-component="plugin-notification-layer"]');

  // Provider publishes the service; the sandbox answers the client's calls.
  await page.goto('/');
  await toolbar.getByRole('button', { name: 'Rev4 service: provide greeter' }).click();
  await expect(notifications).toContainText(`providing ${SERVICE_ID}`, { timeout: 15_000 });

  // Consumer lists, connects and invokes across the host-mediated boundary.
  await toolbar.getByRole('button', { name: 'Rev4 service: call greeter' }).click();
  await expect(notifications).toContainText(
    /greet=\{"message":"HELLO, REV4!"\} echo=\{"value":42,"echoed":true\}/u,
    { timeout: 15_000 },
  );

  // The consumer can also enumerate the host registry.
  await toolbar.getByRole('button', { name: 'Rev4 service: list' }).click();
  await expect(notifications).toContainText(`services=1 first=${SERVICE_ID}`, {
    timeout: 15_000,
  });

  // Disabling the provider cleans its registry; the consumer degrades.
  await page.goto('/plugins');
  const providerCard = page
    .locator('[data-component="plugin-card"]')
    .filter({ hasText: 'Rev4 Service Example' });
  await providerCard.getByRole('button', { name: 'Disable' }).click();
  await expect(providerCard).toHaveAttribute('data-state', 'disabled');

  await page.goto('/');
  await toolbar.getByRole('button', { name: 'Rev4 service: call greeter' }).click();
  await expect(notifications).toContainText(/greeter not found/u, { timeout: 15_000 });
});
