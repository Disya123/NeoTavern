import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isRustSourceFile,
  parseUiDevArgs,
  seedUiDocument,
  watchRoots,
} from './ui-dev.mjs';

describe('native UI authoring launcher', () => {
  it('does not mistake option values for a document path', () => {
    expect(parseUiDevArgs(['--w', '900', '--h', '600', '--messages', '3'])).toEqual({
      width: '900',
      height: '600',
      messages: '3',
      document: null,
      watch: false,
    });
    expect(parseUiDevArgs(['--w', '900', 'my chat.json']).document).toBe('my chat.json');
  });
  it('toggles the rust watch loop without consuming a value', () => {
    expect(parseUiDevArgs(['--watch']).watch).toBe(true);
    expect(parseUiDevArgs(['--watch', 'chat.json']).document).toBe('chat.json');
  });
  it.each([
    ['--w'],
    ['--h', '--w'],
    ['--w', '0'],
    ['--messages', '-1'],
    ['--unknown'],
    ['a.json', 'b.json'],
  ])('rejects invalid arguments %j', (...args) => {
    expect(() => parseUiDevArgs(args)).toThrow();
  });
  it('preserves authored changes across repeated launches', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neota-ui-dev-test-'));
    try {
      const source = join(directory, 'canonical.json');
      const draft = join(directory, 'draft', 'chat.json');
      writeFileSync(source, '{"label":"original"}');
      seedUiDocument(source, draft);
      expect(readFileSync(draft, 'utf8')).toBe('{"label":"original"}');
      writeFileSync(draft, '{"label":"my edits"}');
      seedUiDocument(source, draft);
      expect(readFileSync(draft, 'utf8')).toBe('{"label":"my edits"}');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('rust watch roots', () => {
  it('lists only existing presentation-* src trees', () => {
    const crates = mkdtempSync(join(tmpdir(), 'neota-ui-dev-crates-'));
    try {
      mkdirSync(join(crates, 'presentation-chat', 'src', 'desktop_host'), { recursive: true });
      mkdirSync(join(crates, 'runtime-kernel', 'src'), { recursive: true });
      mkdirSync(join(crates, 'presentation-empty'), { recursive: true });
      const roots = watchRoots(crates);
      expect(roots).toEqual([join(crates, 'presentation-chat', 'src')]);
    } finally {
      rmSync(crates, { recursive: true, force: true });
    }
  });
  it.each(['frame.rs', 'mod.rs', 'lib.rs'])('treats %s as a rebuild trigger', (name) => {
    expect(isRustSourceFile(name)).toBe(true);
  });
  it.each(['chat.json', 'chat.rs.tmp', '.rs', 'notes'])('ignores %s', (name) => {
    expect(isRustSourceFile(name)).toBe(false);
  });
  it('does not treat non-string watcher names as triggers', () => {
    expect(isRustSourceFile(null)).toBe(false);
    expect(isRustSourceFile(42)).toBe(false);
  });
});

