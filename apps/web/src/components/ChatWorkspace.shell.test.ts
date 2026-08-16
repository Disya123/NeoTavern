import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'ChatWorkspace.module.css'),
  'utf8',
);

describe('ChatWorkspace shell contract', () => {
  it('uses a sticky glass composer inside the scroll viewport with hidden scrollbar', () => {
    const viewportBlock = css.match(/\.viewport\s*\{[^}]*\}/)?.[0] ?? '';
    const toolbarBlock = css.match(/\.composerToolbar\s*\{[^}]*\}/)?.[0] ?? '';

    expect(css).toContain('--chat-composer-edge-inset: var(--st-space-lg)');
    expect(css).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.chatHeader[\s\S]*position:\s*absolute/);
    expect(css).toMatch(/\.chatHeader[\s\S]*padding-block-start:\s*var\(--nt-inset-top\)/);
    expect(css).toMatch(
      /\.scrollBody[\s\S]*var\(--st-control-height-large\)\s*\+\s*var\(--nt-inset-top\)/,
    );
    expect(css).not.toContain('--composer-h');
    expect(css).not.toContain('ResizeObserver');
    expect(css).not.toContain('mask-image');
    expect(viewportBlock).toMatch(/grid-row:\s*1/);
    expect(viewportBlock).toMatch(/overflow-y:\s*auto/);
    expect(viewportBlock).toMatch(/scrollbar-width:\s*none/);
    expect(viewportBlock).not.toMatch(/scrollbar-gutter/);
    expect(viewportBlock).not.toMatch(/padding/);
    expect(css).toContain('--st-chat-markdown-column-width');
    expect(css).toMatch(/\.scrollBody[\s\S]*padding-inline:\s*var\(--chat-content-inline-inset\)/);
    expect(css).toMatch(/\.composerWrapper[\s\S]*position:\s*sticky/);
    expect(css).toMatch(
      /\.composerWrapper > :global\(\[data-slot='chat\.composer'\]\)[\s\S]*width:\s*100%/,
    );
    expect(css).toMatch(
      /\.chatPanel :global\(\[data-component='chat-message'\] \.chat-message-markdown\)[\s\S]*width:\s*min\(100%, var\(--st-chat-markdown-column-width,\s*75ch\)\)/,
    );
    expect(css).toMatch(/\.composer[\s\S]*backdrop-filter:/);
    expect(css).toMatch(/\.contextPanelSlot\s*\{[^}]*transition:[^;]*max-height/);
    expect(css).toMatch(
      /\.contextPanelSlot\[data-state='visible'\][\s\S]*var\(--context-panel-measured-height/,
    );
    expect(toolbarBlock).toMatch(
      /background:\s*color-mix\(\s*in srgb,\s*var\(--st-color-surface-canvas\)\s+var\(--st-custom-ui-opacity,\s*70%\),\s*transparent\s*\)/,
    );
    expect(css).toMatch(
      /\.composerField[\s\S]*background:\s*color-mix\(\s*in srgb,\s*var\(--st-color-surface-secondary\)\s+var\(--st-custom-ui-opacity,\s*75%\),\s*transparent\s*\)/,
    );
  });

  it('keeps the default layered composer surfaces in the host shell', () => {
    const composerBlock = css.match(/\.composer\s*\{[^}]*\}/)?.[0] ?? '';
    expect(composerBlock).toMatch(
      /background:\s*color-mix\(\s*in srgb,\s*var\(--st-color-surface-canvas\)\s+var\(--st-custom-ui-opacity,\s*75%\),\s*transparent\s*\)/,
    );
  });
});
