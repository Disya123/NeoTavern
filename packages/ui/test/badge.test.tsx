// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { Badge } from '../src/index.js';
import { render, cleanup } from './helpers.js';

afterEach(cleanup);

describe('Badge', () => {
  it('renders children inside the badge hook with default tone', () => {
    const { container } = render(<Badge>Active</Badge>);
    const badge = container.querySelector('[data-component="badge"]')!;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('Active');
    expect(badge.getAttribute('data-tone')).toBe('default');
    expect(badge.hasAttribute('data-has-icon')).toBe(false);
  });

  it('renders the icon slot as a hidden decorative part', () => {
    const { container } = render(<Badge icon={<span data-testid="glyph">ok</span>}>Active</Badge>);
    const badge = container.querySelector('[data-component="badge"]')!;
    expect(badge.hasAttribute('data-has-icon')).toBe(true);
    const icon = container.querySelector('[data-part="icon"]')!;
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.querySelector('[data-testid="glyph"]')).not.toBeNull();
  });

  it('sets data-tone per tone and forwards span props', () => {
    const { container } = render(
      <Badge tone="danger" title="dangerous" className="wide">
        Danger
      </Badge>,
    );
    const badge = container.querySelector('[data-component="badge"]')!;
    expect(badge.getAttribute('data-tone')).toBe('danger');
    expect(badge.getAttribute('title')).toBe('dangerous');
    expect(badge.classList.contains('wide')).toBe(true);
  });

  it('renders the accent tone with data-tone="accent"', () => {
    const { container } = render(<Badge tone="accent">Applied</Badge>);
    const badge = container.querySelector('[data-component="badge"]')!;
    expect(badge.getAttribute('data-tone')).toBe('accent');
    expect(badge.textContent).toBe('Applied');
  });
});
