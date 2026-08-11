import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'preferences.css'), 'utf8');

describe('clean chat style layout contract', () => {
  it('uses the full chat-panel width for the reading column', () => {
    expect(css).toMatch(
      /:root\[data-chat-style='clean'\] \[data-component='chat-panel'\][\s\S]*--st-chat-markdown-column-width:\s*100%/,
    );
    expect(css).toMatch(
      /:root\[data-chat-style\] \[data-component='chat-panel'\] \[data-slot='chat\.composer'\][\s\S]*width:\s*100%/,
    );
  });
});
