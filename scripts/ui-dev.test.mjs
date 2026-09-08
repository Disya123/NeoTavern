import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUiDevArgs, seedUiDocument } from './ui-dev.mjs';

describe('native UI authoring launcher', () => {
  it('does not mistake option values for a document path', () => {
    expect(parseUiDevArgs(['--w', '900', '--h', '600', '--messages', '3'])).toEqual({
      width: '900',
      height: '600',
      messages: '3',
      document: null,
    });
    expect(parseUiDevArgs(['--w', '900', 'my chat.json']).document).toBe('my chat.json');
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
