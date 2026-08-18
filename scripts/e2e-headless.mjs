/**
 * Serve `apps/web/dist` and spawn `neotavern-headless` for the M6 remote-flow
 * Playwright spec. Stdout prints `ready <web> <headless>` once both listen;
 * stdin EOF (Playwright teardown) kills the child.
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, relative as pathRelative, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dist = join(root, 'apps', 'web', 'dist');
const webPort = Number.parseInt(process.env['E2E_HEADLESS_WEB_PORT'] ?? '4178', 10);
const headlessBind = process.env['E2E_HEADLESS_BIND'] ?? '127.0.0.1:18080';
const webOrigin = `http://127.0.0.1:${webPort}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
};

if (!existsSync(join(dist, 'index.html'))) {
  console.error('apps/web/dist/index.html missing — run pnpm --filter @neotavern/web build');
  process.exit(2);
}

const dataRoot = join(tmpdir(), 'neotavern-e2e-headless', String(process.pid));
mkdirSync(dataRoot, { recursive: true });

const binaryCandidates = [
  join(root, 'crates', 'target', 'debug', 'neotavern-headless.exe'),
  join(root, 'crates', 'target', 'debug', 'neotavern-headless'),
  join(root, 'target', 'debug', 'neotavern-headless.exe'),
  join(root, 'target', 'debug', 'neotavern-headless'),
];
const binary = binaryCandidates.find((path) => existsSync(path));

const headlessArgs = [
  '--root',
  dataRoot,
  '--bind',
  headlessBind,
  '--allowed-origin',
  webOrigin,
  '--secret-backend',
  'session',
];
const child = spawn(
  binary ?? 'cargo',
  binary
    ? headlessArgs
    : [
        'run',
        '--manifest-path',
        join(root, 'crates', 'Cargo.toml'),
        '-p',
        'neotavern-headless',
        '--',
        ...headlessArgs,
      ],
  { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
);

let headlessUrl = `http://${headlessBind}`;
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');

const server = createServer((req, res) => {
  if (req.url === '/e2e/headless-target') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ web: webOrigin, headless: headlessUrl }));
    return;
  }
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
  const assetPath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/u, '');
  const filePath = join(dist, assetPath);
  const resolved = resolve(filePath);
  const fromDist = pathRelative(dist, resolved);
  if (fromDist.startsWith('..') || fromDist.split(/[/\\]/u)[0] === '..') {
    res.writeHead(403);
    res.end();
    return;
  }
  const serve =
    existsSync(resolved) && statSync(resolved).isFile() ? resolved : join(dist, 'index.html');
  const type = MIME[extname(serve)] ?? 'application/octet-stream';
  // Vite `base: './'` (Android file://) breaks BrowserRouter deep links on an
  // HTTP origin (`/chats/:id` would load `./assets` from `/chats/assets`).
  if (basename(serve) === 'index.html') {
    let html = readFileSync(serve, 'utf8');
    if (!html.includes('<base ')) {
      html = html.replace('<head>', '<head><base href="/" />');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(200, { 'content-type': type });
  createReadStream(serve).pipe(res);
});

let webStarted = false;
const startWeb = () => {
  if (webStarted) return;
  webStarted = true;
  server.listen(webPort, '127.0.0.1', () => {
    process.stdout.write(`ready ${webOrigin} ${headlessUrl}\n`);
  });
};

child.stdout.on('data', (chunk) => {
  const text = String(chunk);
  const match = /listening\s+(\S+)/.exec(text);
  if (match?.[1]) {
    headlessUrl = `http://${match[1]}`;
    startWeb();
  }
  process.stderr.write(text);
});
child.stderr.on('data', (chunk) => process.stderr.write(String(chunk)));
child.on('exit', (code) => {
  if (code && code !== 0) {
    console.error(`neotavern-headless exited ${code}`);
    process.exit(code);
  }
});

const shutdown = () => {
  try {
    child.stdin.end();
  } catch {
    // already closed
  }
  child.kill();
  server.close();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  try {
    child.kill();
  } catch {
    // already gone
  }
});
