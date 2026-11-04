/**
 * UI shots: serve `apps/web/dist`, spawn `neotavern-headless`, drive it with Playwright at
 * phone and desktop widths, and drop PNGs in `.ui-shots/`. This is the visual check the
 * mobile layout needs: the desktop WebView cannot open a debug port, so the render is
 * inspected in Chromium against the same build.
 *
 *   node scripts/ui-shots.mjs [--only mobile|desktop] [--keep]
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dist = join(root, 'apps', 'web', 'dist');
const shots = join(root, '.ui-shots');
const webPort = Number.parseInt(process.env['UI_SHOTS_WEB_PORT'] ?? '4180', 10);
const headlessPort = Number.parseInt(process.env['UI_SHOTS_HOST_PORT'] ?? '18081', 10);
const hostUrl = `http://127.0.0.1:${headlessPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
};

if (!existsSync(join(dist, 'index.html'))) {
  console.error('apps/web/dist/index.html missing — run: pnpm --filter @neotavern/web build');
  process.exit(2);
}

const binaryCandidates = [
  join(root, 'crates', 'target', 'debug', 'neotavern-headless.exe'),
  join(root, 'crates', 'target', 'debug', 'neotavern-headless'),
];
const binary = binaryCandidates.find((path) => existsSync(path));
if (!binary) {
  console.error('neotavern-headless binary missing — build crates first');
  process.exit(2);
}

mkdirSync(shots, { recursive: true });
// UI_SHOTS_ROOT points the run at an existing data root (one that already has a
// character), so the shots show the real workspace instead of the first-run onboarding.
const customRoot = process.env['UI_SHOTS_ROOT'] ?? null;
const dataRoot = customRoot ?? join(tmpdir(), 'neotavern-ui-shots', String(process.pid));
mkdirSync(dataRoot, { recursive: true });

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', webOrigin);
  let file = join(dist, decodeURIComponent(url.pathname));
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  createReadStream(file).pipe(response);
});

const child = spawn(
  binary,
  [
    '--root',
    dataRoot,
    '--bind',
    `127.0.0.1:${headlessPort}`,
    '--allowed-origin',
    webOrigin,
    '--secret-backend',
    'session',
  ],
  // The host exits on stdin EOF, so keep the pipe open for the whole run.
  { stdio: ['pipe', 'pipe', 'pipe'] },
);
child.stderr.on('data', (chunk) => process.stderr.write(`[host] ${chunk}`));

const cleanup = async () => {
  child.kill();
  server.close();
  await new Promise((done) => setTimeout(done, 500));
  if (process.argv.includes('--keep') || customRoot !== null) return;
  // The host may still hold a handle on its data root for a moment after exit.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dataRoot, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 400));
    }
  }
};

await new Promise((done) => server.listen(webPort, '127.0.0.1', done));

// Wait for the host to answer before the first navigation, otherwise every RPC call in
// the page is a connection error and the screenshots show a half-built shell.
await (async () => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${hostUrl}/health`).catch(() => null);
      if (response?.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 400));
  }
  console.warn('host did not answer /health in time; continuing');
})();

// pnpm does not hoist playwright to the repo root, so resolve the versioned copy.
const pnpmPlaywright = join(
  root,
  'node_modules',
  '.pnpm',
  'playwright@1.62.0',
  'node_modules',
  'playwright',
);
const playwrightEntry = existsSync(join(pnpmPlaywright, 'package.json'))
  ? pnpmPlaywright
  : 'playwright';
const playwrightModule = await import(pathToFileURL(join(playwrightEntry, 'index.js')).href);
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;
if (!chromium) throw new Error('playwright did not expose chromium');
const browser = await chromium.launch();

async function shoot(name, width, height, steps) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: width < 700,
    hasTouch: width < 700,
  });
  await context.addInitScript(
    (entries) => {
      for (let index = 0; index < entries.length; index += 2) {
        window.localStorage.setItem(entries[index], entries[index + 1]);
      }
    },
    [
      'neotavern.hostSession',
      JSON.stringify({ kind: 'remote', url: hostUrl }),
      'neotavern.navigationRailExpanded',
      'true',
    ],
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(webOrigin, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(shots, `${name}-01-home.png`) });

  if (steps) await steps(page, name);

  for (const [index, error] of errors.entries()) console.log(`  [error ${index}] ${error}`);
  await context.close();
}

if (only !== 'desktop') {
  await shoot('mobile', 390, 844, async (page) => {
    // The menu entry lives in the composer's utility row on phones.
    const menu = page.locator('button[class*="composerMenu"]');
    if ((await menu.count()) === 0) {
      console.log('  menu button not found in the composer');
      return;
    }
    await menu.first().click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'mobile-02-menu.png') });
    const tile = page.locator('button[class*="mobileMenuTile"]').nth(1);
    if ((await tile.count()) > 0) {
      await tile.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(shots, 'mobile-03-panel.png') });
    }
  });
}

if (only !== 'mobile') {
  await shoot('desktop', 1280, 800, async (page) => {
    await page.screenshot({ path: join(shots, 'desktop-02-home.png') });
  });
}

await browser.close();
await cleanup();
console.log(`shots written to ${shots}`);
process.exit(0);
