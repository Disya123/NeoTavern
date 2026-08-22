import { describe, expect, it } from 'vitest';

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const script = resolve(
  import.meta.dirname,
  '..',
  'packages',
  'contracts',
  'tools',
  'validate-document.mjs',
);
const chatFixture = resolve(
  import.meta.dirname,
  '..',
  'packages',
  'contracts',
  'src',
  'presentation',
  'fixtures',
  'ui-blueprint-document-chat-v1.json',
);

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

describe('blueprint document validator (M3)', () => {
  it('accepts the canonical chat document', () => {
    const result = run(chatFixture);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('OK (id=chat)');
  });

  it('rejects broken JSON with a diagnostic and exit code 1', () => {
    const result = run(resolve(import.meta.dirname, 'chat-golden.mjs'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/invalid JSON|INVALID/);
  });

  it('requires at least one file argument', () => {
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage:');
  });

  it('warns when an authored label references a missing i18n key (M4)', () => {
    const raw = readFileSync(chatFixture, 'utf8');
    const edited = raw.replace('"i18nKey": "chat.send"', '"i18nKey": "chat.definitelyMissingKey"');
    const dir = mkdtempSync(resolve(tmpdir(), 'neotavern-bp-'));
    const path = resolve(dir, 'edited.json');
    try {
      writeFileSync(path, edited, 'utf8');
      const result = run(path);
      // Warnings never fail validation; the structure is still valid.
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('warn:');
      expect(result.stderr).toContain('chat.definitelyMissingKey');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
