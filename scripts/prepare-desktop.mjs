/**
 * Build the web application and package the Fastify server as a self-contained
 * Node.js 24 sidecar named according to Tauri's target-triple convention.
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzip, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const NODE_DIST_BASE = 'https://nodejs.org/dist';

const gunzipAsync = promisify(gunzip);
const inflateRawAsync = promisify(inflateRaw);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = resolve(root, 'apps/desktop/src-tauri');
const resources = resolve(desktop, 'resources/web');
const pluginRuntime = resolve(desktop, 'resources/runtime');

function command(name, args, options = {}) {
  execFileSync(name, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
}

function targetTriple() {
  if (process.env['TAURI_ENV_TARGET_TRIPLE']) return process.env['TAURI_ENV_TARGET_TRIPLE'];
  try {
    return execFileSync('rustc', ['--print', 'host-tuple'], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }).trim();
  } catch {
    throw new Error(
      'Could not determine the host target triple: `rustc` was not found or failed. ' +
        'Install the Rust toolchain (https://rustup.rs) or set TAURI_ENV_TARGET_TRIPLE.',
    );
  }
}

/** Normalize a rustc/Tauri target triple into Node-style platform/arch. */
function targetInfo(triple) {
  const arch = triple.startsWith('aarch64') ? 'arm64' : 'x64';
  if (triple.includes('windows')) return { platform: 'win32', arch };
  if (triple.includes('apple-darwin')) return { platform: 'darwin', arch };
  if (triple.includes('linux')) return { platform: 'linux', arch };
  throw new Error(`Unsupported desktop target triple: ${triple}`);
}

function nodeDistName(version, target) {
  const os = { win32: 'win', darwin: 'darwin', linux: 'linux' }[target.platform];
  const extension = target.platform === 'win32' ? 'zip' : 'tar.gz';
  return `node-${version}-${os}-${target.arch}.${extension}`;
}

async function downloadBuffer(url) {
  let response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch (cause) {
    throw new Error(`Could not download the Node.js runtime from ${url}: ${cause.message}`, {
      cause,
    });
  }
  if (!response.ok) {
    throw new Error(`Could not download the Node.js runtime from ${url}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Extract the first regular file ending with `suffix` from a .tar.gz buffer. */
async function extractFileFromTarGz(archive, suffix) {
  const data = await gunzipAsync(archive);
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/su, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/su, '');
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(header.toString('utf8', 124, 136).trim() || '0', 8);
    const typeFlag = String.fromCharCode(header[156] ?? 48);
    const contentStart = offset + 512;
    if (typeFlag === '0' && fullName.endsWith(suffix)) {
      return Buffer.from(data.subarray(contentStart, contentStart + size));
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`File matching "${suffix}" was not found in the Node.js distribution archive`);
}

/** Extract a named entry from a .zip buffer (store/deflate, central directory). */
async function extractFileFromZip(archive, entryName) {
  let eocd = -1;
  for (let index = archive.length - 22; index >= 0; index -= 1) {
    if (archive.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd === -1) throw new Error('Malformed Node.js distribution archive (zip EOCD not found)');
  const entryCount = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Malformed Node.js distribution archive (zip central directory)');
    }
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name !== entryName) continue;
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('Malformed Node.js distribution archive (zip local header)');
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) return Buffer.from(compressed);
    if (method === 8) return Buffer.from(await inflateRawAsync(compressed));
    throw new Error(`Unsupported zip compression method ${method} for ${entryName}`);
  }
  throw new Error(`Entry "${entryName}" was not found in the Node.js distribution archive`);
}

/**
 * Provide `resources/runtime/node(.exe)` for the plugin worker runtime.
 * Same-platform builds reuse the running binary (no network needed, exactly
 * the runtime this toolchain was tested with); cross builds download the
 * matching official distribution for the target.
 */
async function installPluginRuntimeNode(target) {
  const binaryName = target.platform === 'win32' ? 'node.exe' : 'node';
  const destination = resolve(pluginRuntime, binaryName);
  if (process.platform === target.platform && process.arch === target.arch) {
    await cp(process.execPath, destination);
    return;
  }
  const version = process.version;
  if (!version.startsWith('v24.')) {
    throw new Error(
      `Cross-target desktop builds must run on Node 24 (the pkg sidecar target is node24); ` +
        `this host runs ${version}. Use Node 24 or build on the target platform.`,
    );
  }
  const distName = nodeDistName(version, target);
  const url = `${NODE_DIST_BASE}/${version}/${distName}`;
  console.log(`[desktop] cross-target runtime: downloading ${url}`);
  const archive = await downloadBuffer(url);
  const binary =
    target.platform === 'win32'
      ? await extractFileFromZip(archive, `node-${version}-win-${target.arch}/node.exe`)
      : await extractFileFromTarGz(archive, '/bin/node');
  await writeFile(destination, binary, { mode: 0o755 });
}

const triple = targetTriple();
const target = targetInfo(triple);

command('pnpm', ['build']);
await rm(resources, { recursive: true, force: true });
await mkdir(resources, { recursive: true });
await cp(resolve(root, 'apps/web/dist'), resources, { recursive: true });
// The plugin sandbox still runs on a Node runtime shipped next to the app: the
// worker/loader pair is the host half of the plugin boundary (ADR-0058), not the
// deleted Fastify sidecar.
await rm(pluginRuntime, { recursive: true, force: true });
await mkdir(pluginRuntime, { recursive: true });
await installPluginRuntimeNode(target);
await cp(
  resolve(root, 'apps/plugin-runtime/worker/plugin-worker.mjs'),
  resolve(pluginRuntime, 'plugin-worker.mjs'),
);
await cp(
  resolve(root, 'apps/plugin-runtime/worker/plugin-loader.mjs'),
  resolve(pluginRuntime, 'plugin-loader.mjs'),
);

console.log('[desktop] prepared resources (web bundle + plugin runtime; no Node sidecar)');
