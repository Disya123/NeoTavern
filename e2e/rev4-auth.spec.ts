/**
 * Rev4 OAuth sample plugin — full user-cycle smoke suite.
 *
 * Spins up a local mock OAuth IdP (plain-http loopback, allowed by the
 * manifest contract for local development), installs `plugins/rev4-auth`
 * with its real frontend.js (plugin.json templated with the IdP's actual
 * port), activates it, then walks the whole flow:
 *  1. the connection manager dialog starts an authorization-code + PKCE flow
 *     in a new tab;
 *  2. the user approves on the IdP page; the popup returns through the host
 *     callback, the server exchanges the code and stores the token;
 *  3. the manager dialog polls to `connected` without ever exposing the
 *     token value;
 *  4. the plugin's `rev4-auth.check` command runs a signed request through
 *     the host proxy (Authorization is injected server-side) and reports the
 *     verified account;
 *  5. revoke wipes the stored token and the signed request fails gracefully.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { zipBuffer } from './helpers.js';

const SAMPLES_ROOT = resolve(import.meta.dirname, '../plugins');
const PLUGIN_ID = 'neotavern.rev4-auth';
const ACCESS_TOKEN = 'mock-access-token';

interface MockIdp {
  origin: string;
  authorizePath: string;
  tokenPath: string;
  close: () => Promise<void>;
  codesIssued: () => number;
}

function startMockIdp(): Promise<MockIdp> {
  const issued: string[] = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/authorize') {
      // Render the consent page; submitting it returns to the redirect_uri.
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const code = `mock-code-${issued.length}`;
      issued.push(code);
      const html =
        '<!doctype html><html><body>' +
        '<h1>Example IdP</h1>' +
        '<form method="get" action="' +
        redirectUri.replaceAll('&', '&amp;') +
        '">' +
        '<input type="hidden" name="code" value="' +
        code +
        '"/>' +
        '<input type="hidden" name="state" value="' +
        state.replaceAll('&', '&amp;') +
        '"/>' +
        '<button type="submit" id="approve">Approve access</button>' +
        '</form></body></html>';
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html);
      return;
    }

    if (url.pathname === '/token') {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      request.on('end', () => {
        const params = new URLSearchParams(body);
        if (params.get('grant_type') !== 'authorization_code') {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'unsupported_grant_type' }));
          return;
        }
        const code = params.get('code') ?? '';
        if (!issued.includes(code)) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            access_token: ACCESS_TOKEN,
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        );
      });
      return;
    }

    if (url.pathname === '/me') {
      if (request.headers['authorization'] === `Bearer ${ACCESS_TOKEN}`) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ sub: 'demo-user', scopes: ['profile.read'] }));
        return;
      }
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    response.writeHead(404);
    response.end();
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('IdP did not bind a port'));
        return;
      }
      const origin = `http://127.0.0.1:${address.port}`;
      resolvePromise({
        origin,
        authorizePath: `${origin}/authorize`,
        tokenPath: `${origin}/token`,
        codesIssued: () => issued.length,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function pluginEntries(idp: MockIdp): Record<string, string> {
  const manifest = readFileSync(resolve(SAMPLES_ROOT, 'rev4-auth/plugin.json'), 'utf8')
    .replaceAll('http://127.0.0.1:8080', idp.origin)
    .replaceAll('network:http://127.0.0.1:8080', `network:${idp.origin}`);
  // The sample's endpoints are templated with the placeholder port; the mock
  // IdP binds a random one, so rewrite the placeholders in the code too.
  const frontend = readFileSync(resolve(SAMPLES_ROOT, 'rev4-auth/frontend.js'), 'utf8').replaceAll(
    'http://127.0.0.1:8080',
    idp.origin,
  );
  return { 'plugin.json': manifest, 'frontend.js': frontend };
}

async function installAndActivate(page: Page, entries: Record<string, string>): Promise<void> {
  await page.request.delete(`/api/v2/plugins/${PLUGIN_ID}`).catch(() => undefined);
  const archive = zipBuffer(entries);
  await page.goto('/plugins');
  await page.getByLabel('Install plugin package').setInputFiles({
    name: `${PLUGIN_ID}.stplugin`,
    mimeType: 'application/zip',
    buffer: archive,
  });
  await expect(
    page.getByText(/Installed Rev4 OAuth Example\. Review its permissions before activation\./u),
  ).toBeVisible();

  const card = page
    .locator('[data-component="plugin-card"]')
    .filter({ hasText: 'Rev4 OAuth Example' });
  await expect(card).toHaveAttribute('data-state', 'needs-consent');
  for (const permission of [
    'auth.connections',
    'network.domains',
    'ui.commands',
    'notifications.show',
  ]) {
    await card
      .getByRole('checkbox', { name: new RegExp(permission.replaceAll('.', '\\.'), 'u') })
      .check();
  }
  await card.getByRole('button', { name: 'Activate' }).click();
  await expect(card).toHaveAttribute('data-state', 'active');
}

test('rev4-auth: OAuth connect through the manager, signed proxy request, revoke', async ({
  page,
}) => {
  const idp = await startMockIdp();
  try {
    await installAndActivate(page, pluginEntries(idp));

    // Open the connection manager for the sample plugin.
    const card = page
      .locator('[data-component="plugin-card"]')
      .filter({ hasText: 'Rev4 OAuth Example' });
    await card.getByRole('button', { name: 'Connections' }).click();
    const manager = page.locator('[data-component="plugin-auth-manager"]');
    await expect(manager).toBeVisible();
    await expect(manager).toContainText('Example IdP');

    // Connect: the authorize URL opens in a new tab served by the mock IdP.
    const connectButton = manager.locator('[data-part="connect"]');
    await expect(connectButton).toBeVisible({ timeout: 15_000 });
    const popupPromise = page.context().waitForEvent('page');
    await connectButton.click();
    const popup = await popupPromise;
    await popup.getByRole('button', { name: 'Approve access' }).click();

    // The popup lands on the host result screen; the manager polls to
    // "connected" (the server stored the token — no token value in the DOM).
    await expect(popup).toHaveURL(/#\/plugin-auth-result\?.*status=connected/u, {
      timeout: 15_000,
    });
    await popup.close();
    await expect(
      manager.locator('[data-role="oauth-status"][data-status="connected"]'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(manager).not.toContainText(ACCESS_TOKEN);

    // Signed request through the host proxy: the IdP sees the injected
    // Authorization header and reports the demo account.
    await page.goto('/');
    const toolbar = page.locator('[data-component="plugin-toolbar"]');
    await toolbar.getByRole('button', { name: 'Rev4 auth: signed request' }).click();
    await expect(page.locator('[data-component="plugin-notification-layer"]')).toContainText(
      /status=200 body=\{.*"sub":"demo-user".*\}/u,
      { timeout: 15_000 },
    );
    await expect(page.locator('[data-component="plugin-notification-layer"]')).not.toContainText(
      ACCESS_TOKEN,
    );

    // Revoke wipes the token server-side; the signed request degrades.
    await page.goto('/plugins');
    await card.getByRole('button', { name: 'Connections' }).click();
    await manager.locator('[data-part="revoke"]').click();
    await expect(manager.locator('[data-role="oauth-status"][data-status="revoked"]')).toBeVisible({
      timeout: 15_000,
    });
    await page.keyboard.press('Escape');

    await page.goto('/');
    await toolbar.getByRole('button', { name: 'Rev4 auth: signed request' }).click();
    await expect(page.locator('[data-component="plugin-notification-layer"]')).toContainText(
      /no active connection/u,
    );
  } finally {
    await idp.close();
  }
});
