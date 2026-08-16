import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'Sidebar.module.css'),
  'utf8',
);

describe('Sidebar shell contract', () => {
  it('keeps the leading rail toggle below the Android status bar', () => {
    expect(css).toMatch(
      /\[data-leading-menu-toggle='true'\]\s*\{\s*padding-block-start:\s*var\(--nt-inset-top\)/,
    );
    expect(css).toMatch(
      /padding-block-start:\s*max\(\s*var\(--st-space-2xl\),\s*var\(--nt-inset-top\)\)/,
    );
  });

  it('lifts management tabs above the gesture pill on narrow viewports', () => {
    expect(css).toMatch(
      /--management-tabs-edge-inset:\s*max\(\s*var\(--st-space-2xl\),\s*var\(--nt-inset-bottom\)\)/,
    );
  });
});
