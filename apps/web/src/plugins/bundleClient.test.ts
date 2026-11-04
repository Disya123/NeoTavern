import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import {
  hasBundleHost,
  parseBundleChunk,
  readBundleFile,
  createBundleUrl,
  entryPathFor,
  resolveEntryUrl,
  installBundle,
  installPackage,
} from './bundleClient.js';
import { UnsupportedError } from '@neotavern/neobackend';

const encode = (text: string) => btoa(text);

function chunk(size: number, eof: boolean, text: string): string {
  return `${size}|${eof ? 1 : 0}|${encode(text)}`;
}

beforeEach(() => {
  invoke.mockReset();
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
});

describe('bundle client', () => {
  it('refuses without a host instead of returning empty bytes', async () => {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
    expect(hasBundleHost()).toBe(false);
    await expect(readBundleFile('author.plugin', '1.0.0', 'ui/app.js')).rejects.toBeInstanceOf(
      UnsupportedError,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('decodes the host frame and stops at eof', async () => {
    const parsed = parseBundleChunk(chunk(5, true, 'hello'));
    expect(parsed.size).toBe(5);
    expect(parsed.eof).toBe(true);
    expect(new TextDecoder().decode(parsed.bytes)).toBe('hello');
  });

  it('assembles a file from several ranges', async () => {
    invoke
      .mockResolvedValueOnce(chunk(10, false, 'hello'))
      .mockResolvedValueOnce(chunk(10, true, 'world'));
    const bytes = await readBundleFile('author.plugin', '1.0.0', 'ui/app.js');
    expect(new TextDecoder().decode(bytes)).toBe('helloworld');
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({ offset: 0, length: 4 * 1024 * 1024 });
    expect(invoke.mock.calls[1]?.[1]).toMatchObject({ offset: 5 });
  });

  it('refuses a range that overshoots the declared size', async () => {
    invoke.mockResolvedValueOnce(chunk(3, false, 'toolong'));
    await expect(readBundleFile('author.plugin', '1.0.0', 'ui/app.js')).rejects.toThrow(
      /declared size/u,
    );
  });

  it('creates an object URL the frame can import', async () => {
    invoke.mockResolvedValueOnce(chunk(3, true, 'abc'));
    const createObjectURL = vi.fn(() => 'blob:neotavern/1');
    vi.stubGlobal('URL', { ...URL, createObjectURL });
    await expect(createBundleUrl('author.plugin', '1.0.0', 'ui/app.js')).resolves.toBe(
      'blob:neotavern/1',
    );
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('bundle entry resolution', () => {
  it('understands the flat, runtime and ui declaration styles', () => {
    expect(entryPathFor({ frontend: 'ui/app.js' })).toEqual({
      path: 'ui/app.js',
      kind: 'frontend',
    });
    expect(entryPathFor({ runtime: { frontend: 'ui/main.js' } })).toEqual({
      path: 'ui/main.js',
      kind: 'frontend',
    });
    expect(entryPathFor({ ui: { panel: { entry: 'ui/panel.js' } } })).toEqual({
      path: 'ui/panel.js',
      kind: 'frontend',
    });
    expect(entryPathFor({ runtime: { wasm: 'wasm/plugin.wasm' } })).toEqual({
      path: 'wasm/plugin.wasm',
      kind: 'wasm',
    });
  });

  it('returns nothing rather than guessing when the manifest is silent', () => {
    expect(entryPathFor({})).toBeNull();
    expect(entryPathFor(null)).toBeNull();
    expect(entryPathFor({ runtime: { host: 'sandbox' } })).toBeNull();
  });

  it('does not hand a frame a URL it cannot load', async () => {
    await expect(resolveEntryUrl('author.plugin', '1.0.0', {})).resolves.toBeNull();
    invoke.mockResolvedValueOnce(chunk(3, true, 'abc'));
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:neotavern/2' });
    await expect(
      resolveEntryUrl('author.plugin', '1.0.0', { frontend: 'ui/app.js' }),
    ).resolves.toBe('blob:neotavern/2');
    vi.unstubAllGlobals();
  });
});

describe('bundle install', () => {
  it('refuses a package with no digests before calling the host', async () => {
    await expect(installBundle('author.plugin', '1.0.0', 'C:/pkg', {})).rejects.toThrow(
      /at least one checksum/u,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('passes the manifest digests through and reads the host report', async () => {
    invoke.mockResolvedValueOnce('3|4096');
    await expect(
      installBundle('author.plugin', '1.0.0', 'C:/pkg', { 'ui/app.js': 'a'.repeat(64) }),
    ).resolves.toEqual({ files: 3, totalBytes: 4096 });
    expect(invoke.mock.calls[0]?.[0]).toBe('plugin_bundle_install');
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      pluginId: 'author.plugin',
      version: '1.0.0',
      sourceDir: 'C:/pkg',
      checksums: [['ui/app.js', 'a'.repeat(64)]],
    });
  });
});

describe('package install', () => {
  it('records the manifest the host actually verified', async () => {
    invoke.mockResolvedValueOnce(
      JSON.stringify({
        manifest: JSON.stringify({ id: 'author.plugin', version: '1.0.0' }),
        files: 2,
        totalBytes: 512,
      }),
    );
    await expect(installPackage('C:/pkg')).resolves.toEqual({
      manifest: { id: 'author.plugin', version: '1.0.0' },
      files: 2,
      totalBytes: 512,
    });
    expect(invoke.mock.calls[0]?.[0]).toBe('plugin_package_install');
  });

  it('refuses to invent a manifest when the host reports none', async () => {
    invoke.mockResolvedValueOnce(JSON.stringify({ files: 1 }));
    await expect(installPackage('C:/pkg')).rejects.toThrow(/no manifest/u);
  });

  it('refuses a manifest that is not an object', async () => {
    invoke.mockResolvedValueOnce(JSON.stringify({ manifest: '[1,2]' }));
    await expect(installPackage('C:/pkg')).rejects.toThrow(/not an object/u);
  });
});
