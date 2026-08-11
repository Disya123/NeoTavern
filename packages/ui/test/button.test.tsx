// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRef } from 'react';
import { Button, IconButton } from '../src/index.js';
import { render, cleanup, click } from './helpers.js';

afterEach(cleanup);

describe('Button', () => {
  it('renders a native button with stable data hooks and defaults', () => {
    const { container } = render(<Button>Save</Button>);
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    expect(button!.getAttribute('data-component')).toBe('button');
    expect(button!.getAttribute('data-variant')).toBe('default');
    expect(button!.getAttribute('data-size')).toBe('md');
    // Must not implicitly submit forms.
    expect(button!.getAttribute('type')).toBe('button');
    expect(button!.textContent).toBe('Save');
    expect(button!.classList.contains('st-button')).toBe(true);
  });

  it('reflects variant and size props as data attributes', () => {
    const { container } = render(
      <Button variant="danger" size="sm">
        Delete
      </Button>,
    );
    const button = container.querySelector('button')!;
    expect(button.getAttribute('data-variant')).toBe('danger');
    expect(button.getAttribute('data-size')).toBe('sm');
  });

  it('publishes stable icon and label parts without changing the accessible name', () => {
    const { container } = render(
      <Button startIcon={<svg data-testid="import-icon" />} endIcon={<span>suffix</span>}>
        Import
      </Button>,
    );
    const button = container.querySelector('button')!;
    const icons = button.querySelectorAll('[data-part="icon"]');
    expect(button.getAttribute('data-has-icon')).toBe('both');
    expect(button.textContent).toBe('Importsuffix');
    expect(icons).toHaveLength(2);
    expect(icons[0]!.getAttribute('data-position')).toBe('start');
    expect(icons[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(icons[1]!.getAttribute('data-position')).toBe('end');
    expect(button.querySelector('[data-part="label"]')!.textContent).toBe('Import');
  });

  it('merges custom classNames with the base class', () => {
    const { container } = render(<Button className="extra more">Go</Button>);
    const button = container.querySelector('button')!;
    expect(button.className).toBe('st-button extra more');
  });

  it('fires onClick when clicked', () => {
    const onClick = vi.fn();
    const { container } = render(<Button onClick={onClick}>Hit</Button>);
    click(container.querySelector('button')!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('passes through an explicit type (e.g. submit)', () => {
    const { container } = render(<Button type="submit">Go</Button>);
    expect(container.querySelector('button')!.getAttribute('type')).toBe('submit');
  });

  it('forwards its ref to the underlying button element', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Ref</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it('renders the child element instead of a button when asChild is set', () => {
    const { container } = render(
      <Button asChild variant="primary">
        <a href="/somewhere">Link</a>
      </Button>,
    );
    expect(container.querySelector('button')).toBeNull();
    const anchor = container.querySelector('a')!;
    expect(anchor.getAttribute('href')).toBe('/somewhere');
    expect(anchor.getAttribute('data-component')).toBe('button');
    expect(anchor.getAttribute('data-variant')).toBe('primary');
    expect(anchor.classList.contains('st-button')).toBe(true);
    // asChild must not leak a type attribute onto non-button elements.
    expect(anchor.hasAttribute('type')).toBe(false);
  });
});

describe('IconButton', () => {
  it('renders a ghost-variant button carrying the required label and icon hook', () => {
    const { container } = render(<IconButton aria-label="Settings">gear</IconButton>);
    const button = container.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBe('Settings');
    expect(button.getAttribute('data-variant')).toBe('ghost');
    expect(button.hasAttribute('data-icon')).toBe(true);
    expect(button.classList.contains('st-icon-button')).toBe(true);
  });

  it('fires onClick like a regular button', () => {
    const onClick = vi.fn();
    const { container } = render(
      <IconButton aria-label="Close" onClick={onClick}>
        x
      </IconButton>,
    );
    click(container.querySelector('button')!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
