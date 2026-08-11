/**
 * Shared test utilities for @neotavern/ui.
 *
 * @testing-library/react and jsdom are intentionally NOT imported here: they
 * are devDependencies of apps/web, not of this package, and pnpm's strict
 * node_modules layout keeps them out of this package's resolution scope.
 * Components are rendered directly with react-dom/client + React.act instead.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';

// jsdom lacks ResizeObserver, which Radix (Popper, ScrollArea) requires.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

// Radix pointer handling may touch the capture APIs jsdom does not implement.
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted = new Set<Mounted>();

export interface RenderResult {
  container: HTMLDivElement;
  rerender: (next: ReactElement) => void;
  unmount: () => void;
}

export function render(ui: ReactElement): RenderResult {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  const entry: Mounted = { root, container };
  mounted.add(entry);
  return {
    container,
    rerender(next: ReactElement): void {
      act(() => {
        root.render(next);
      });
    },
    unmount(): void {
      act(() => {
        root.unmount();
      });
      container.remove();
      mounted.delete(entry);
    },
  };
}

/** Unmount everything rendered and leave a pristine document.body. */
export function cleanup(): void {
  for (const { root, container } of [...mounted]) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  mounted.clear();
  document.body.innerHTML = '';
}

export function click(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
}

export function mouseDown(target: Element): void {
  act(() => {
    target.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }),
    );
  });
}

export function pointerDown(target: Element): void {
  act(() => {
    target.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }),
    );
  });
}

export function pressKey(target: EventTarget, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

export function focusIn(target: Element): void {
  act(() => {
    target.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
}

export function focusOut(target: Element): void {
  act(() => {
    target.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

/** Let Radix's deferred work (focus rAF, positioning) flush. */
export async function settle(ms = 60): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

export function q(selector: string): Element | null {
  return document.body.querySelector(selector);
}

export function qa(selector: string): Element[] {
  return [...document.body.querySelectorAll(selector)];
}
