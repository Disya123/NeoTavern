/**
 * Bundle delivery to a plugin frame (ADR-0066 P2c).
 *
 * The frame is sandboxed with an opaque origin, so it cannot read the host's files and
 * cannot call the kernel. This module is the one bridge: it reads the plugin's staged
 * bundle in bounded ranges through the host command, assembles the bytes, and hands the
 * frame a blob URL it can import.
 *
 * Nothing here decides what a bundle contains — the kernel verified every digest at
 * install time, and this code only transports the same bytes.
 */
import { UnsupportedError } from '@neotavern/neobackend';

const SURFACE = 'plugins.bundle';
const CHUNK_BYTES = 4 * 1024 * 1024;

/** True when the desktop host can serve bundle bytes. */
export function hasBundleHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Decodes the host's `size|eof|<base64>` answer. */
export function parseBundleChunk(value: string): { size: number; eof: boolean; bytes: Uint8Array } {
  const [rawSize = '0', rawEof = '0', payload = ''] = value.split('|');
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { size: Number.parseInt(rawSize, 10) || 0, eof: rawEof === '1', bytes };
}

async function invokeHost<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!hasBundleHost()) throw new UnsupportedError(SURFACE);
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/**
 * Reads one file out of a plugin's bundle, chunk by chunk.
 *
 * `path` is package-relative; the host re-validates it against the plugin's own
 * directory, so a traversal attempt fails there rather than here.
 */
export async function readBundleFile(
  pluginId: string,
  version: string,
  path: string,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let total = 0;
  for (;;) {
    const chunk = parseBundleChunk(
      await invokeHost<string>('plugin_bundle_read', {
        pluginId,
        version,
        path,
        offset,
        length: CHUNK_BYTES,
      }),
    );
    total = chunk.size;
    parts.push(chunk.bytes);
    offset += chunk.bytes.length;
    if (chunk.eof || chunk.bytes.length === 0) break;
    if (offset > total) throw new Error('bundle read ran past the declared size');
  }
  const combined = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    combined.set(part, cursor);
    cursor += part.length;
  }
  return combined;
}

/**
 * Hands the frame a URL it can import.
 *
 * The object URL is created here and revoked by the caller when the frame goes away, so
 * a plugin cannot keep its own code alive after being disabled.
 */
export async function createBundleUrl(
  pluginId: string,
  version: string,
  path: string,
): Promise<string> {
  const bytes = await readBundleFile(pluginId, version, path);
  return URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
}

/** What a manifest says the frame should import, if it says anything. */
export interface BundleEntry {
  path: string;
  kind: 'frontend' | 'wasm';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

/**
 * Reads the importable entry out of a manifest that the kernel already stores.
 *
 * The web client receives the manifest as an opaque record, so this is where the shape
 * of three declaration styles is understood in one place: a flat `frontend`, a
 * `runtime.frontend`, and a wasm module. No manifest means no entry, and no entry means
 * nothing is posted to the frame — a missing field must not turn into a guess.
 */
export function entryPathFor(manifest: unknown): BundleEntry | null {
  const root = asRecord(manifest);
  const runtime = asRecord(root['runtime']);
  const ui = asRecord(root['ui']);

  const frontend = firstString(
    runtime['frontend'],
    root['frontend'],
    ui['entry'],
    asRecord(ui['panel'])['entry'],
  );
  if (frontend !== null) return { path: frontend, kind: 'frontend' };

  const wasm = firstString(runtime['wasm'], root['wasm']);
  if (wasm !== null) return { path: wasm, kind: 'wasm' };

  return null;
}

/**
 * Produces the URL to hand a frame, or `null` when the package has nothing to import or
 * the host cannot serve bytes. Callers post only a non-null URL, so a frame never
 * receives a placeholder that would load an empty document and look 'mounted'.
 */
export async function resolveEntryUrl(
  pluginId: string,
  version: string,
  manifest: unknown,
): Promise<string | null> {
  const entry = entryPathFor(manifest);
  if (entry === null || !hasBundleHost()) return null;
  return createBundleUrl(pluginId, version, entry.path);
}

/** What the host reports after publishing a bundle. */
export interface InstalledBundle {
  files: number;
  totalBytes: number;
}

/**
 * Installs a package's files from a directory the user picked.
 *
 * `checksums` is the manifest's own map: the host verifies every file against it and
 * refuses the whole install on a single mismatch, so a package cannot arrive half
 * verified. Passing an empty map is refused here rather than at the host, because a
 * bundle without digests is exactly the thing that would install unchecked bytes.
 */
export async function installBundle(
  pluginId: string,
  version: string,
  sourceDir: string,
  checksums: Record<string, string>,
): Promise<InstalledBundle> {
  const entries = Object.entries(checksums);
  if (entries.length === 0) throw new Error('a bundle needs at least one checksum');
  const raw = await invokeHost<string>('plugin_bundle_install', {
    pluginId,
    version,
    sourceDir,
    checksums: entries,
  });
  const [files = '0', totalBytes = '0'] = raw.split('|');
  return {
    files: Number.parseInt(files, 10) || 0,
    totalBytes: Number.parseInt(totalBytes, 10) || 0,
  };
}

/** A package that passed host verification: the exact manifest, plus what landed. */
export interface InstalledPackage {
  manifest: Record<string, unknown>;
  files: number;
  totalBytes: number;
}

/**
 * Installs a package from a directory the user picked.
 *
 * One host call installs the manifest's declared files and hands back the manifest text
 * that was verified, so the descriptor recorded afterwards is the same one the digests
 * belong to. A package whose digests do not match is refused as a whole — there is no
 * partially installed state to clean up.
 */
export async function installPackage(sourceDir: string): Promise<InstalledPackage> {
  const raw = await invokeHost<string>('plugin_package_install', { sourceDir });
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('the host returned an unreadable install report');
  }
  const report = parsed as Record<string, unknown>;
  const manifest: unknown = report['manifest'];
  if (typeof manifest === 'string') {
    const decoded: unknown = JSON.parse(manifest);
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new Error('the installed manifest is not an object');
    }
    return {
      manifest: decoded as Record<string, unknown>,
      files: Number(report['files']) || 0,
      totalBytes: Number(report['totalBytes']) || 0,
    };
  }
  throw new Error('the host reported no manifest');
}

/**
 * Reads a package's manifest without installing anything.
 *
 * Consent has to happen before bytes land, so the dialog needs the manifest on its own.
 * The host refuses a package with no digests here too: asking someone to approve a
 * package that would fail on install is worse than not asking at all.
 */
export async function readPackageManifest(sourceDir: string): Promise<Record<string, unknown>> {
  const raw = await invokeHost<string>('plugin_package_manifest', { sourceDir });
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the package manifest is not an object');
  }
  return parsed as Record<string, unknown>;
}
