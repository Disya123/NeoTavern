import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'ContextUsagePanel.module.css'),
  'utf8',
);

describe('ContextUsagePanel shell contract', () => {
  it('stays transparent inside the glass composer shell', () => {
    expect(css).toMatch(/\.panel\s*\{[^}]*background:\s*transparent/);
    expect(css).toMatch(
      /\.metric\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--st-color-surface-secondary\) 40%, transparent\)/,
    );
  });
});
