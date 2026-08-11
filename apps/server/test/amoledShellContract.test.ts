import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shellCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../assets/themes/neotavern.amoled/shell.css'),
  'utf8',
);
const componentsCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../assets/themes/neotavern.amoled/components.css'),
  'utf8',
);
const nordShellCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../assets/themes/neotavern.nord/shell.css'),
  'utf8',
);

const LEGACY_AMOLED_LAYOUT =
  /\[data-component='chat-panel'\]\s*>\s*\[data-slot='chat\.composer'\]|grid-template-rows:\s*auto minmax\(0,\s*1fr\)\s*auto|padding-block-end:\s*calc\(var\(--st-control-height-large\)/;

describe('AMOLED shell.css', () => {
  it('never reintroduces the legacy overlay composer layout', () => {
    expect(shellCss).not.toMatch(LEGACY_AMOLED_LAYOUT);
    expect(shellCss).not.toMatch(/\[data-part='composer-sticky'\]/);
    expect(shellCss).not.toMatch(/\[data-slot='chat\.composer'\]/);
    expect(shellCss).not.toMatch(/\[data-component='chat-panel'\]/);
  });

  it('matches other bundled themes: shell skin only, no chat layout', () => {
    expect(shellCss).toMatch(/\[data-slot='app\.shell'\]/);
    expect(nordShellCss).not.toMatch(/\[data-component='chat-panel'\]/);
    expect(shellCss).not.toMatch(/\[data-component='chat-panel'\]/);
  });
});

describe('AMOLED components.css composer contract', () => {
  it('uses one elevated glass shell with transparent inner parts', () => {
    expect(componentsCss).toMatch(
      /\[data-slot='chat\.composer'\][\s\S]*background:\s*color-mix\(in srgb, var\(--st-color-surface-elevated\) 92%, transparent\)/,
    );
    expect(componentsCss).toMatch(/\[data-slot='chat\.composer'\][\s\S]*backdrop-filter:/);
    expect(componentsCss).toMatch(
      /\[data-slot='chat\.composer'\] \[data-part='toolbar'\][\s\S]*background:\s*transparent/,
    );
    expect(componentsCss).toMatch(
      /\[data-slot='chat\.composer'\] \[data-part='field'\][\s\S]*background:\s*transparent/,
    );
    expect(componentsCss).toMatch(
      /\[data-slot='chat\.composer'\] \[data-component='textarea'\][\s\S]*background:\s*transparent/,
    );
  });

  it('does not override composer geometry', () => {
    expect(componentsCss).not.toMatch(LEGACY_AMOLED_LAYOUT);
    expect(componentsCss).not.toMatch(/\[data-part='composer-sticky'\]/);
    expect(componentsCss).not.toMatch(/inset-block-end:\s*0/);
    expect(componentsCss).not.toMatch(/::after/);
  });

  it('keeps context usage inside the composer glass instead of a second shell', () => {
    expect(componentsCss).toMatch(
      /\[data-slot='chat\.composer'\] \[data-component='context-usage-panel'\][\s\S]*background:\s*transparent/,
    );
    expect(componentsCss).toMatch(
      /\[data-component='context-usage-panel'\] \[data-part='metric'\][\s\S]*color-mix/,
    );
    expect(componentsCss).toMatch(
      /\[data-slot='chat\.composer'\] \[data-component='context-usage-panel'\][\s\S]*backdrop-filter:\s*none/,
    );
  });
});
