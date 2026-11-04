import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import {
  hasBundleHost,
  parseBundleChunk,
  readBundleFile,
  createBundleUrl,
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
