// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { ActionBar, ActionBarGroup, Button } from '../src/index.js';
import { cleanup, render } from './helpers.js';

afterEach(cleanup);

describe('ActionBar', () => {
  it('publishes alignment, collapse strategy and stable group slots', () => {
    const { container } = render(
      <ActionBar align="split" collapse="stack" aria-label="Character actions">
        <ActionBarGroup placement="primary">
          <Button>New</Button>
          <Button>Import</Button>
        </ActionBarGroup>
        <ActionBarGroup placement="secondary">
          <select aria-label="Sort">
            <option>A–Z</option>
          </select>
        </ActionBarGroup>
      </ActionBar>,
    );

    const actionBar = container.querySelector('[data-component="action-bar"]')!;
    const inner = actionBar.querySelector(':scope > [data-part="inner"]')!;
    const groups = inner.querySelectorAll(':scope > [data-part="group"]');
    expect(actionBar.getAttribute('data-align')).toBe('split');
    expect(actionBar.getAttribute('data-collapse')).toBe('stack');
    expect(actionBar.getAttribute('aria-label')).toBe('Character actions');
    expect(groups).toHaveLength(2);
    expect(groups[0]!.getAttribute('data-role')).toBe('primary');
    expect(groups[1]!.getAttribute('data-role')).toBe('secondary');
  });

  it('publishes the compact toolbar strategy without changing button labels', () => {
    const { container } = render(
      <ActionBar collapse="compact">
        <ActionBarGroup>
          <Button startIcon={<svg />}>Import</Button>
        </ActionBarGroup>
      </ActionBar>,
    );
    const actionBar = container.querySelector('[data-component="action-bar"]')!;
    expect(actionBar.getAttribute('data-collapse')).toBe('compact');
    expect(actionBar.getAttribute('data-compact')).toBe('false');
    expect(actionBar.querySelector('[data-part="label"]')!.textContent).toBe('Import');
  });
});
