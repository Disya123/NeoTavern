import { describe, expect, it } from 'vitest';

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { GOLDEN_DIR, SIZES } from './chat-golden.mjs';

describe('chat golden gate (M0.5)', () => {
  it('targets the chat crate assets directory', () => {
    const crateAssets = resolve(import.meta.dirname, '..', 'crates', 'presentation-chat', 'assets');
    expect(GOLDEN_DIR.startsWith(crateAssets)).toBe(true);
    expect(GOLDEN_DIR.endsWith('goldens')).toBe(true);
  });

  it('covers the canonical M0 verification sizes plus the compact breakpoint', () => {
    expect(SIZES).toEqual([
      [1100, 760],
      [900, 700],
      [620, 800],
      [900, 220],
    ]);
  });

  it('has committed goldens for every size', () => {
    for (const [width, height] of SIZES) {
      const path = resolve(GOLDEN_DIR, `chat-${width}x${height}.png`);
      expect(existsSync(path), path).toBe(true);
    }
  });
});
