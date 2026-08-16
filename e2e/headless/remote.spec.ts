import { expect, test } from '@playwright/test';

/**
 * M6: Web Client remote-flow against neotavern-headless (Product Wire
 * `/meta` + `/rpc`), not Fastify `/api/v2`. HostConnect auto-connects from
 * `?connect=` and the themed shell must appear.
 */
test('web client connects to headless over product wire', async ({ page, request, baseURL }) => {
  const failed: string[] = [];
  page.on('requestfailed', (req) => {
    failed.push(`${req.method()} ${req.url()} ${req.failure()?.errorText ?? 'unknown'}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') failed.push(`console:${msg.text()}`);
  });

  const target = await request.get(`${baseURL}/e2e/headless-target`);
  expect(target.ok()).toBeTruthy();
  const body = (await target.json()) as { headless: string };
  expect(body.headless).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);

  const meta = await request.get(`${body.headless}/meta`);
  expect(meta.ok(), `node /meta ${meta.status()}`).toBeTruthy();

  await page.goto(`/?connect=${encodeURIComponent(body.headless)}`);
  const browserMeta = await page.evaluate(async (url: string) => {
    try {
      const response = await fetch(`${url}/meta`);
      return { ok: response.ok, status: response.status, body: await response.text() };
    } catch (error) {
      return { ok: false, status: 0, body: error instanceof Error ? error.message : String(error) };
    }
  }, body.headless);

  await page.waitForFunction(
    () =>
      Boolean(document.querySelector('[data-component="app-shell"]')) ||
      Boolean(document.querySelector('[data-component="host-connect"][data-connect-error]')),
    { timeout: 45_000 },
  );
  const gate = page.locator('[data-component="host-connect"]');
  if ((await page.locator('[data-component="app-shell"]').count()) === 0) {
    const detail = (await gate.getAttribute('data-connect-detail')) ?? '';
    const code = (await gate.getAttribute('data-connect-error')) ?? '';
    throw new Error(
      `host-connect stayed open code=${code} detail=${detail} evaluateMeta=${JSON.stringify(browserMeta)} network=${failed.join(' | ')}`,
    );
  }
  await expect(gate).toHaveCount(0);
});
