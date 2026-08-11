// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Switch } from '../src/index.js';
import { render, cleanup, click } from './helpers.js';

afterEach(cleanup);

function switchEl(container: Element): HTMLElement {
  return container.querySelector('[data-component="switch"]')!;
}

describe('Switch', () => {
  it('renders an accessible unchecked switch with a thumb', () => {
    const { container } = render(<Switch aria-label="Enable autosave" />);
    const el = switchEl(container);
    expect(el.getAttribute('role')).toBe('switch');
    expect(el.getAttribute('aria-label')).toBe('Enable autosave');
    expect(el.getAttribute('aria-checked')).toBe('false');
    expect(el.getAttribute('data-state')).toBe('unchecked');
    expect(container.querySelector('[data-component="switch-thumb"]')).not.toBeNull();
    expect(el.classList.contains('st-switch')).toBe(true);
  });

  it('toggles on click when uncontrolled', () => {
    const onCheckedChange = vi.fn();
    const { container } = render(<Switch aria-label="x" onCheckedChange={onCheckedChange} />);
    click(switchEl(container));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(switchEl(container).getAttribute('data-state')).toBe('checked');
    expect(switchEl(container).getAttribute('aria-checked')).toBe('true');
    click(switchEl(container));
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
    expect(switchEl(container).getAttribute('data-state')).toBe('unchecked');
  });

  it('starts checked with defaultChecked', () => {
    const { container } = render(<Switch aria-label="x" defaultChecked />);
    expect(switchEl(container).getAttribute('data-state')).toBe('checked');
  });

  it('stays put until the owner updates a controlled checked prop', () => {
    const onCheckedChange = vi.fn();
    const view = render(
      <Switch aria-label="x" checked={false} onCheckedChange={onCheckedChange} />,
    );
    click(switchEl(view.container));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(switchEl(view.container).getAttribute('data-state')).toBe('unchecked');
    view.rerender(<Switch aria-label="x" checked onCheckedChange={onCheckedChange} />);
    expect(switchEl(view.container).getAttribute('data-state')).toBe('checked');
  });

  it('ignores clicks while disabled', () => {
    const onCheckedChange = vi.fn();
    const { container } = render(
      <Switch aria-label="x" disabled onCheckedChange={onCheckedChange} />,
    );
    click(switchEl(container));
    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(switchEl(container).getAttribute('data-state')).toBe('unchecked');
    expect(switchEl(container).hasAttribute('disabled')).toBe(true);
  });
});
