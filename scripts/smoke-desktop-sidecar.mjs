#!/usr/bin/env node
/**
 * Smoke-test the prepared self-contained desktop sidecar, including both
 * native runtimes. This does not launch a GUI and leaves no user data behind.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauriRoot = resolve(root, 'apps/desktop/src-tauri');
const binaries = resolve(tauriRoot, 'binaries');
const resources = resolve(tauriRoot, 'resources');
const smokeRoot = resolve(root, '.tmp-desktop-smoke');
const sidecarStartupTimeoutMs = 30_000;

if (dirname(smokeRoot) !== root) throw new Error('Unsafe desktop smoke directory');

let binaryNames;
try {
  binaryNames = (await readdir(binaries)).filter(
    (name) =>
      name.startsWith('neotavern-server-') &&
      (process.platform !== 'win32' || name.endsWith('.exe')),
  );
} catch {
  throw new Error(
    `No prepared sidecar binaries under ${binaries}. Run "pnpm desktop:prepare" first ` +
      '(it needs the Rust toolchain for the target triple).',
  );
}
if (binaryNames.length !== 1) {
  throw new Error(`Expected one prepared desktop sidecar, found ${binaryNames.length}`);
}

const binary = resolve(binaries, binaryNames[0]);
const dataDir = resolve(smokeRoot, 'data');
const stdoutPath = resolve(smokeRoot, 'stdout.log');
const stderrPath = resolve(smokeRoot, 'stderr.log');
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const output = [];
const errors = [];
const child = spawn(binary, [], {
  cwd: smokeRoot,
  windowsHide: true,
  env: {
    ...process.env,
    NEOTA_HOST: '127.0.0.1',
    NEOTA_PORT: String(port),
    NEOTA_DATA_DIR: dataDir,
    NEOTA_WEB_DIR: resolve(resources, 'web'),
    NEOTA_SHARP_MODULE: resolve(resources, 'native/node_modules/sharp/lib/index.js'),
    NEOTA_SQLITE_MODULE: resolve(resources, 'native/node_modules/better-sqlite3/lib/index.js'),
    NEOTA_PLUGIN_NODE: resolve(
      resources,
      process.platform === 'win32' ? 'runtime/node.exe' : 'runtime/node',
    ),
    NEOTA_PLUGIN_WORKER: resolve(resources, 'runtime/plugin-worker.mjs'),
    NEOTA_PLUGIN_LOADER: resolve(resources, 'runtime/plugin-loader.mjs'),
    NEOTA_CORS_ORIGIN: origin,
    NEOTA_LOG_LEVEL: 'info',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => output.push(chunk));
child.stderr.on('data', (chunk) => errors.push(chunk));
// spawn emits 'error' (ENOENT/EACCES) instead of failing the promise; surface
// it through readiness instead of waiting out the full startup timeout.
let spawnError = null;
child.once('error', (error) => {
  spawnError = new Error(`Desktop sidecar could not be started: ${error.message}`, {
    cause: error,
  });
});

let completed = false;
try {
  await waitForReady(origin, child, () => spawnError);
  const health = await getJson(`${origin}/api/v2/health`);
  assert(health.status === 'ok', 'health endpoint did not report ok');

  const html = await fetch(`${origin}/settings`).then((response) => response.text());
  assert(html.includes('<div id="root"></div>'), 'packaged SPA fallback is unavailable');

  const created = await postJson(`${origin}/api/v2/characters`, {
    name: 'Desktop SQLite smoke',
    description: 'Temporary packaged-runtime check',
  });
  assert(typeof created.id === 'string', 'packaged SQLite runtime did not create a character');

  const tokenizerProvider = await postJson(`${origin}/api/v2/providers`, {
    kind: 'echo',
    name: 'Desktop tokenizer smoke',
    model: 'gpt-4o-mini',
    enabled: true,
  });
  const tokenizerChat = await postJson(`${origin}/api/v2/chats`, {
    characterId: created.id,
    title: 'Desktop tokenizer smoke',
  });
  const generation = await fetch(`${origin}/api/v2/chats/${tokenizerChat.id}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      userMessage: 'Count this with the packaged exact tokenizer.',
      providerConfigId: tokenizerProvider.id,
    }),
  });
  assert(generation.ok, `packaged tokenizer generation returned ${generation.status}`);
  await generation.text();
  const generatedMessages = await getJson(
    `${origin}/api/v2/chats/${tokenizerChat.id}/messages?order=asc`,
  );
  const generatedReply = generatedMessages.items.at(-1);
  assert(
    generatedReply?.meta?.tokenBudget?.profile === 'openai:o200k_base',
    'packaged exact Tiktoken ranks are unavailable',
  );

  const pngCard = await createPngCharacterCard();
  const form = new FormData();
  form.append('file', new Blob([pngCard], { type: 'image/png' }), 'desktop-smoke.png');
  const importedResponse = await fetch(`${origin}/api/v2/characters/import`, {
    method: 'POST',
    body: form,
  });
  if (!importedResponse.ok) {
    throw new Error(
      `PNG import failed with ${importedResponse.status}: ${await importedResponse.text()}`,
    );
  }
  const imported = await importedResponse.json();
  assert(
    typeof imported.character?.avatar === 'string',
    'packaged Sharp runtime did not create a thumbnail',
  );
  const thumbnail = await fetch(new URL(imported.character.avatar, origin));
  assert(thumbnail.ok, 'generated thumbnail is not served');
  assert(thumbnail.headers.get('content-type') === 'image/webp', 'generated thumbnail is not WebP');

  const diagnostics = await getJson(`${origin}/api/v2/diagnostics`);
  assert(diagnostics.database?.integrity === 'ok', 'packaged database integrity check failed');
  assert(
    diagnostics.database?.entities?.characters >= 2,
    'diagnostics did not observe packaged SQLite writes',
  );
  assert(diagnostics.privacy?.secretsIncluded === false, 'diagnostics privacy invariant failed');
  assert(
    (await stat(resolve(dataDir, 'app.db'))).size > 0,
    'desktop database file was not created',
  );

  completed = true;
  console.log(
    `[desktop:smoke] OK — ${binaryNames[0]}, SQLite + Sharp + SPA + diagnostics on ${origin}`,
  );
} catch (error) {
  const stderrTail = errors.join('').trim().slice(-4000);
  if (stderrTail) {
    error.message += `\n--- sidecar stderr (tail) ---\n${stderrTail}`;
  }
  const stdoutTail = output.join('').trim().slice(-4000);
  if (stdoutTail) {
    error.message += `\n--- sidecar stdout (tail) ---\n${stdoutTail}`;
  }
  throw error;
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await waitForExit(child, 5_000);
  // Cleanup must never mask the original failure: log-capture and directory
  // removal are best-effort once the verdict is in.
  try {
    await Promise.all([
      writeFile(stdoutPath, output.join('')),
      writeFile(stderrPath, errors.join('')),
    ]);
    if (completed) await rm(smokeRoot, { recursive: true, force: true });
  } catch (cleanupError) {
    console.warn(`[desktop:smoke] cleanup failed: ${cleanupError.message}`);
  }
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback port');
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return address.port;
}

async function waitForReady(origin, processHandle, getSpawnError) {
  const deadline = Date.now() + sidecarStartupTimeoutMs;
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) throw spawnError;
    if (processHandle.exitCode !== null) {
      throw new Error(`Desktop sidecar exited during startup with ${processHandle.exitCode}`);
    }
    try {
      const response = await fetch(`${origin}/api/v2/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(
    `Desktop sidecar did not become ready within ${sidecarStartupTimeoutMs / 1_000} seconds`,
  );
}

async function waitForExit(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null) return;
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Desktop sidecar did not terminate')),
      timeoutMs,
    );
    processHandle.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function getJson(url) {
  const response = await fetch(url);
  assert(response.ok, `${url} returned ${response.status}`);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert(response.ok, `${url} returned ${response.status}`);
  return response.json();
}

async function createPngCharacterCard() {
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Desktop Sharp smoke',
      description: 'Temporary packaged-runtime image check',
      personality: '',
      scenario: '',
      first_mes: 'Ready.',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: ['desktop-smoke'],
      creator: 'release-check',
      character_version: '1',
      extensions: {},
    },
  };
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const iend = findChunk(png, 'IEND');
  const text = Buffer.concat([
    Buffer.from('chara\0', 'latin1'),
    Buffer.from(Buffer.from(JSON.stringify(card)).toString('base64'), 'ascii'),
  ]);
  return Buffer.concat([png.subarray(0, iend), pngChunk('tEXt', text), png.subarray(iend)]);
}

function findChunk(png, wanted) {
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === wanted) return offset;
    offset += 12 + length;
  }
  throw new Error(`PNG chunk ${wanted} was not found`);
}

function pngChunk(typeName, data) {
  const type = Buffer.from(typeName, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
  return chunk;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
