import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

interface ThemeBlock {
  name: string;
  text: Record<string, string>;
  surfaces: Record<string, string>;
}

function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4]
    .map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (a, b) => b - a,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

function parseBlock(selector: string, name: string): ThemeBlock {
  const start = css.indexOf(selector);
  expect(start, `${selector} block exists in tokens.css`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  const close = css.indexOf('\n  }', open);
  const block = css.slice(open, close);
  const text: Record<string, string> = {};
  const surfaces: Record<string, string> = {};
  for (const match of block.matchAll(/--st-color-((?:text|surface)-[a-z]+):\s*(#[0-9a-f]{6})/g)) {
    if (match[1].startsWith('text-')) text[`--st-color-${match[1]}`] = match[2];
    else surfaces[`--st-color-${match[1]}`] = match[2];
  }
  expect(Object.keys(surfaces).length, `${name} surfaces parsed`).toBeGreaterThanOrEqual(4);
  return { name, text, surfaces };
}

const blocks: ThemeBlock[] = [
  parseBlock(':root {', 'light'),
  parseBlock(":root[data-theme-mode='dark'] {", 'dark'),
];

function blend(foreground: string, background: string, alpha: number): string {
  const fa = foreground.replace('#', '');
  const bg = background.replace('#', '');
  const out: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const channel =
      Number.parseInt(fa.slice(index * 2, index * 2 + 2), 16) * alpha +
      Number.parseInt(bg.slice(index * 2, index * 2 + 2), 16) * (1 - alpha);
    out.push(Math.round(channel));
  }
  return `#${out.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

describe('WCAG 2.2 AA token contrast contract', () => {
  it('parses both theme blocks', () => {
    expect(blocks.map((block) => block.name)).toEqual(['light', 'dark']);
  });

  for (const block of blocks) {
    const glassBackground = blend(
      block.surfaces['--st-color-surface-secondary'],
      block.surfaces['--st-color-surface-canvas'],
      0.7,
    );
    const backgrounds: ReadonlyArray<readonly [string, string]> = [
      ['surface-primary', block.surfaces['--st-color-surface-primary']],
      ['surface-secondary', block.surfaces['--st-color-surface-secondary']],
      ['surface-tertiary', block.surfaces['--st-color-surface-tertiary']],
      ['surface-canvas', block.surfaces['--st-color-surface-canvas']],
      ['glass blend (secondary@70% over canvas)', glassBackground],
    ];

    for (const token of ['--st-color-text-muted', '--st-color-text-secondary']) {
      it(`${block.name}: ${token} holds AA (>= 4.5:1) on every surface`, () => {
        const color = block.text[token];
        expect(color, `${token} is a hex color in ${block.name}`).toMatch(/^#[0-9a-f]{6}$/);
        for (const [label, background] of backgrounds) {
          const ratio = contrastRatio(color, background);
          expect(
            ratio,
            `${token} ${color} on ${label} ${background} = ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }
});
