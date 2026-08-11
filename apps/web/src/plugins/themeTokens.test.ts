import { describe, expect, it, vi } from 'vitest';
import { PLUGIN_UI_TOKENS, snapshotPluginUiTokens } from './themeTokens.js';

describe('snapshotPluginUiTokens', () => {
  it('resolves allow-listed tokens from the root computed style', () => {
    const values = new Map<string, string>([
      ['--st-color-surface-elevated', 'rgb(1, 2, 3)'],
      ['--st-radius-control', '6px'],
      ['--st-color-border', '#abc'],
    ]);
    const getComputedStyle = vi.spyOn(window, 'getComputedStyle');
    getComputedStyle.mockReturnValue({
      getPropertyValue: (name: string) => values.get(name) ?? '',
    } as unknown as CSSStyleDeclaration);

    const tokens = snapshotPluginUiTokens(document.documentElement);
    expect(tokens).toEqual({
      '--st-color-surface-elevated': 'rgb(1, 2, 3)',
      '--st-radius-control': '6px',
      '--st-color-border': '#abc',
    });
  });

  it('drops empty and unset values', () => {
    const getComputedStyle = vi.spyOn(window, 'getComputedStyle');
    getComputedStyle.mockReturnValue({
      getPropertyValue: () => '  ',
    } as unknown as CSSStyleDeclaration);

    expect(snapshotPluginUiTokens(document.documentElement)).toEqual({});
  });

  it('never leaks tokens outside the allow list', () => {
    const getComputedStyle = vi.spyOn(window, 'getComputedStyle');
    getComputedStyle.mockReturnValue({
      getPropertyValue: (name: string) =>
        name === '--st-color-surface-elevated' ? 'rgb(9, 9, 9)' : '',
    } as unknown as CSSStyleDeclaration);

    const tokens = snapshotPluginUiTokens(document.documentElement);
    expect(Object.keys(tokens)).toEqual(['--st-color-surface-elevated']);
    for (const name of Object.keys(tokens)) {
      expect(PLUGIN_UI_TOKENS).toContain(name);
    }
  });

  it('unwraps aliased tokens so the sandbox gets a plain literal', () => {
    const values = new Map<string, string>([
      ['--st-color-accent', 'var(--st-color-accent-base)'],
      ['--st-color-accent-base', 'oklch(0.5 0.1 30)'],
      ['--st-color-danger', 'var(--st-color-unset, #ff0000)'],
    ]);
    const getComputedStyle = vi.spyOn(window, 'getComputedStyle');
    getComputedStyle.mockReturnValue({
      getPropertyValue: (name: string) => values.get(name) ?? '',
    } as unknown as CSSStyleDeclaration);

    const tokens = snapshotPluginUiTokens(document.documentElement);
    expect(tokens['--st-color-accent']).toBe('oklch(0.5 0.1 30)');
    expect(tokens['--st-color-danger']).toBe('#ff0000');
  });
});
