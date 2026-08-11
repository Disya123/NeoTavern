/**
 * Theme starter contract test (AGENTS.md §17/§19, docs/theme-sdk).
 *
 * The shipped `theme-starter.zip` (downloaded from the Themes manager) must
 * stay a valid, installable starter: a parseable ZIP containing `theme.json`
 * accepted by `validateThemeManifest`, plus a shell CSS that only uses
 * documented hooks and known tokens, with no executable/remote constructs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { validateThemeManifest, TOKEN_NAMES, TOKEN_PREFIX } from '../src/index.js';

const starterPath = resolve(import.meta.dirname, '../../../apps/web/public/theme-starter.zip');
const starterSourcePath = resolve(import.meta.dirname, '../starter');
const TOKEN_SET: ReadonlySet<string> = new Set(TOKEN_NAMES.map((name) => TOKEN_PREFIX + name));

function normalizeText(value: string): string {
  return value.replace(/\r\n?/gu, '\n');
}

/** Minimal ZIP reader: local/central directory headers, store + deflate. */
function readZipEntries(zip: Buffer): Map<string, Buffer> {
  const eocdOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocdOffset, 'EOCD signature').toBeGreaterThanOrEqual(0);
  const centralCount = zip.readUInt16LE(eocdOffset + 10);
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);

  const entries = new Map<string, Buffer>();
  let cursor = centralOffset;
  for (let i = 0; i < centralCount; i++) {
    expect(zip.readUInt32LE(cursor), `central header ${i}`).toBe(0x02014b50);
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;

    const dataStart =
      localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    expect(entries.get(name)!.length, `uncompressed size of ${name}`).toBe(uncompressedSize);
  }
  return entries;
}

describe('theme starter contract', () => {
  const zip = readFileSync(starterPath);
  const entries = readZipEntries(zip);

  it('contains theme.json and a shell CSS', () => {
    expect(entries.has('theme.json'), 'theme.json entry').toBe(true);
    const cssFiles = [...entries.keys()].filter((name) => name.toLowerCase().endsWith('.css'));
    expect(cssFiles.length, 'at least one CSS entry').toBeGreaterThan(0);
  });

  it('matches the editable Theme SDK starter source', () => {
    for (const name of ['components.css', 'shell.css', 'theme.json']) {
      const archived = entries.get(name)?.toString('utf8') ?? '';
      expect(archived, `${name} uses canonical LF line endings`).not.toContain('\r');
      expect(archived, name).toBe(
        normalizeText(readFileSync(resolve(starterSourcePath, name), 'utf8')),
      );
    }
  });

  it('theme.json passes validateThemeManifest and references existing files', () => {
    const manifestJson = entries.get('theme.json')!.toString('utf8');
    const parsed = JSON.parse(manifestJson) as Record<string, unknown>;
    const result = validateThemeManifest(parsed);
    expect(result.ok, result.error?.params?.issues?.join('; ')).toBe(true);
    const manifest = result.value!;
    for (const field of ['componentsCss', 'shell', 'preview'] as const) {
      const path = manifest[field];
      if (typeof path === 'string') {
        expect(entries.has(path), `manifest ${field} "${path}" must exist in the package`).toBe(
          true,
        );
      }
    }
  });

  it('shell CSS only uses documented hooks and known tokens', () => {
    for (const [name, content] of entries) {
      if (!name.toLowerCase().endsWith('.css')) continue;
      const css = content.toString('utf8');
      expect(css, `${name} must not use @import`).not.toMatch(/@import/u);
      expect(css, `${name} must not use remote/protocol URLs`).not.toMatch(
        /url\((?:https?:)?\/\//iu,
      );
      expect(css, `${name} must not use script-capable constructs`).not.toMatch(
        /expression\(|javascript:/iu,
      );
      const unknownTokens = [...css.matchAll(/var\(\s*(--st-[\w-]+)/gu)]
        .map((match) => match[1])
        .filter((name) => !TOKEN_SET.has(name));
      expect(unknownTokens, `${name} references unknown tokens`).toEqual([]);
    }
  });
});
