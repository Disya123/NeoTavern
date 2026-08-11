// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { Tabs, type TabDefinition } from '../src/index.js';
import { render, cleanup, click, mouseDown, pressKey, qa, q, settle } from './helpers.js';

afterEach(cleanup);

const TABS: TabDefinition[] = [
  { value: 'one', label: 'Tab one', content: <p>First panel</p> },
  { value: 'two', label: 'Tab two', content: <p>Second panel</p> },
  { value: 'three', label: 'Tab three', content: <p>Third panel</p> },
];

function triggers(): Element[] {
  return qa('[data-component="tabs-trigger"]');
}

describe('Tabs', () => {
  it('renders a labelled tab list with one trigger per tab', () => {
    render(<Tabs tabs={TABS} />);
    const list = q('[data-component="tabs-list"]')!;
    expect(list.getAttribute('aria-label')).toBe('Tabs');
    expect(triggers().map((t) => t.textContent)).toEqual(['Tab one', 'Tab two', 'Tab three']);
    for (const trigger of triggers()) expect(trigger.getAttribute('role')).toBe('tab');
  });

  it('exposes the responsive layout and overflow strategy to themes', () => {
    render(<Tabs tabs={TABS} layout="equal" overflow="scroll" />);
    const root = q('[data-component="tabs"]')!;
    const list = q('[data-component="tabs-list"]')!;
    expect(root).not.toBeNull();
    expect(list.getAttribute('data-part')).toBe('list');
    expect(list.getAttribute('data-layout')).toBe('equal');
    expect(list.getAttribute('data-overflow')).toBe('scroll');
    expect(triggers()[0]!.getAttribute('data-part')).toBe('trigger');
    expect(q('[data-component="tabs-content"]')!.getAttribute('data-part')).toBe('content');
  });

  it('activates the first tab by default and shows only its panel', () => {
    render(<Tabs tabs={TABS} />);
    const [first] = triggers();
    expect(first.getAttribute('data-state')).toBe('active');
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(document.body.textContent).toContain('First panel');
    expect(document.body.textContent).not.toContain('Second panel');
  });

  it('wraps scrollable tab panels in an overlay ScrollArea', () => {
    render(<Tabs tabs={TABS} scrollable />);
    expect(q('.st-scroll-fill')).not.toBeNull();
    expect(q('[data-component="scroll-viewport"]')).not.toBeNull();
  });

  it('honours defaultValue', () => {
    render(<Tabs tabs={TABS} defaultValue="two" />);
    expect(triggers()[1].getAttribute('data-state')).toBe('active');
    expect(document.body.textContent).toContain('Second panel');
    expect(document.body.textContent).not.toContain('First panel');
  });

  it('switches panels on pointer selection and reports the change', () => {
    const onValueChange = vi.fn();
    render(<Tabs tabs={TABS} onValueChange={onValueChange} />);
    // Radix selects tabs on mousedown (mouse) rather than click.
    mouseDown(triggers()[2]);
    expect(onValueChange).toHaveBeenCalledWith('three');
    expect(triggers()[2].getAttribute('data-state')).toBe('active');
    expect(triggers()[0].getAttribute('data-state')).toBe('inactive');
    expect(document.body.textContent).toContain('Third panel');
    expect(document.body.textContent).not.toContain('First panel');
  });

  it('supports keyboard activation with arrow keys', async () => {
    render(<Tabs tabs={TABS} />);
    // Roving focus moves on a macrotask, then auto-activation selects on focus.
    pressKey(triggers()[0], 'ArrowRight');
    await settle();
    expect(triggers()[1].getAttribute('data-state')).toBe('active');
    expect(document.body.textContent).toContain('Second panel');
    // Arrow navigation wraps around the ends.
    pressKey(triggers()[1], 'ArrowLeft');
    await settle();
    pressKey(triggers()[0], 'ArrowLeft');
    await settle();
    expect(triggers()[2].getAttribute('data-state')).toBe('active');
  });

  it('renders a sliding indicator for the segment variant', async () => {
    render(<Tabs tabs={TABS} variant="segment" defaultValue="one" />);
    const indicator = q('[data-component="tabs-indicator"]') as HTMLElement;
    expect(indicator).not.toBeNull();
    expect(indicator.getAttribute('data-part')).toBe('indicator');
    expect(indicator.style.transform).toContain('translateX(calc(0 * 100%))');
    mouseDown(triggers()[2]);
    await settle();
    expect(triggers()[2].getAttribute('data-state')).toBe('active');
    expect(indicator.style.transform).toContain('translateX(calc(2 * 100%))');
  });

  it('does not render a segment indicator for underline tabs', () => {
    render(<Tabs tabs={TABS} />);
    expect(q('[data-component="tabs-indicator"]')).toBeNull();
  });

  it('does not change the visible tab when controlled from outside', () => {
    function Controlled() {
      const [value, setValue] = useState('one');
      return (
        <div>
          <button type="button" onClick={() => setValue('two')}>
            external
          </button>
          <Tabs tabs={TABS} value={value} />
        </div>
      );
    }
    render(<Controlled />);
    // Selecting another trigger reports intent but the owner decides.
    mouseDown(triggers()[1]);
    expect(triggers()[0].getAttribute('data-state')).toBe('active');
    expect(document.body.textContent).toContain('First panel');
    // Only the external state change moves the selection.
    click(document.body.querySelector('button[type="button"]')!);
    expect(triggers()[1].getAttribute('data-state')).toBe('active');
    expect(document.body.textContent).toContain('Second panel');
  });

  it('renders disabled triggers and keeps them unselectable', () => {
    render(
      <Tabs
        tabs={[
          { value: 'one', label: 'Tab one', content: <p>First panel</p> },
          { value: 'two', label: 'Locked', content: <p>Locked panel</p>, disabled: true },
        ]}
      />,
    );
    expect((triggers()[1] as HTMLButtonElement).disabled).toBe(true);
    mouseDown(triggers()[1]);
    expect(triggers()[0].getAttribute('data-state')).toBe('active');
    expect(document.body.textContent).not.toContain('Locked panel');
  });

  it('applies the title tooltip and content class', () => {
    render(
      <Tabs
        tabs={[{ value: 'one', label: 'Tab one', content: <p>First panel</p>, title: 'hint' }]}
        contentClassName="scrollable"
      />,
    );
    expect(triggers()[0].getAttribute('title')).toBe('hint');
    expect(q('[data-component="tabs-content"]')!.className).toContain('scrollable');
  });
});
