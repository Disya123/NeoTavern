// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Card, Separator, Spinner, ScrollArea, Tooltip, TooltipProvider } from '../src/index.js';
import { render, cleanup, focusIn, focusOut, q } from './helpers.js';
import { act } from 'react';

afterEach(cleanup);

describe('Card', () => {
  it('renders a div with the card hook, merged classes and children', () => {
    const { container } = render(
      <Card id="profile" className="tight">
        <span>body</span>
      </Card>,
    );
    const card = container.querySelector('[data-component="card"]')!;
    expect(card.tagName).toBe('DIV');
    expect(card.id).toBe('profile');
    expect(card.className).toBe('st-card tight');
    expect(card.textContent).toBe('body');
  });
});

describe('Separator', () => {
  it('is horizontal and decorative by default', () => {
    const { container } = render(<Separator />);
    const sep = container.querySelector('[data-component="separator"]')!;
    expect(sep.getAttribute('data-orientation')).toBe('horizontal');
    // decorative separators must not be exposed as content dividers
    expect(sep.getAttribute('role')).toBe('none');
    expect(sep.classList.contains('st-separator')).toBe(true);
  });

  it('reflects vertical orientation', () => {
    const { container } = render(<Separator orientation="vertical" />);
    expect(
      container.querySelector('[data-component="separator"]')!.getAttribute('data-orientation'),
    ).toBe('vertical');
  });
});

describe('Spinner', () => {
  it('renders a status role carrying the optional label', () => {
    const { container } = render(<Spinner label="Loading characters" />);
    const spinner = container.querySelector('[data-component="spinner"]')!;
    expect(spinner.getAttribute('role')).toBe('status');
    expect(spinner.getAttribute('aria-label')).toBe('Loading characters');
    expect(spinner.classList.contains('st-spinner')).toBe(true);
  });
});

describe('ScrollArea', () => {
  it('places children in the viewport and renders scrollbar parts', () => {
    const { container } = render(
      <ScrollArea className="grow">
        <ul>
          <li>entry</li>
        </ul>
      </ScrollArea>,
    );
    const root = container.firstElementChild!;
    expect(root.classList.contains('st-scroll-root')).toBe(true);
    expect(root.classList.contains('grow')).toBe(true);
    const viewport = container.querySelector('[data-component="scroll-viewport"]')!;
    expect(viewport.textContent).toBe('entry');
    expect(container.querySelector('[data-component="scroll-scrollbar"]')).not.toBeNull();
    expect(container.querySelector('[data-component="scroll-thumb"]')).not.toBeNull();
  });
});

describe('Tooltip', () => {
  function Tip() {
    return (
      <TooltipProvider>
        <Tooltip content="Helpful tip">
          <button type="button">Target</button>
        </Tooltip>
      </TooltipProvider>
    );
  }

  it('wraps the trigger via asChild and hides content while closed', () => {
    const { container } = render(<Tip />);
    // asChild: exactly the child button, no extra wrapper element.
    expect(container.children.length).toBe(1);
    expect(container.firstElementChild!.tagName).toBe('BUTTON');
    expect(q('[data-component="tooltip-content"]')).toBeNull();
  });

  it('shows the content when the trigger is focused and hides it on blur', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<Tip />);
      const trigger = container.querySelector('button')!;
      act(() => {
        vi.advanceTimersByTime(500);
      });
      focusIn(trigger);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const content = q('[data-component="tooltip-content"]');
      expect(content).not.toBeNull();
      expect(content!.getAttribute('role')).toBe('tooltip');
      expect(content!.textContent).toBe('Helpful tip');
      focusOut(trigger);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(q('[data-component="tooltip-content"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
