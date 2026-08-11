// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { StrictMode, act } from 'react';
import { useRowGestures, type UseRowGesturesResult } from '../src/hooks/useRowGestures.js';
import type { RowGestureOptions } from '@neotavern/gestures';

// React 19 needs this flag for act() under custom test runners.
// @ts-expect-error — not part of the standard DOM lib.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface RowHarness {
  cleanup: () => void;
  menu: () => unknown[];
  move: () => unknown[];
  draggedAttr: () => (string | null)[];
}

interface RowDef {
  id: string;
  index: number;
}

const ROWS: RowDef[] = [
  { id: 'a', index: 0 },
  { id: 'b', index: 1 },
  { id: 'c', index: 2 },
];

function renderRows(options: RowGestureOptions): RowHarness {
  const menu: unknown[] = [];
  const move: unknown[] = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Rows() {
    const gestures: UseRowGesturesResult = useRowGestures(options);
    return (
      <div>
        {ROWS.map((rowDef) => (
          <div
            key={rowDef.id}
            data-testid={`row-${rowDef.id}`}
            data-item-index={rowDef.index}
            data-dragging={gestures.draggedIndex === rowDef.index ? '' : undefined}
            {...gestures.handlers(rowDef.id, rowDef.index)}
          >
            {rowDef.id}
          </div>
        ))}
      </div>
    );
  }

  act(() => {
    root.render(
      <StrictMode>
        <Rows />
      </StrictMode>,
    );
  });
  if (!options.onOpenMenu) options.onOpenMenu = (id, at) => menu.push([id, at]);
  if (!options.onDragMove) options.onDragMove = (id, to) => move.push([id, to]);

  return {
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
    menu: () => menu,
    move: () => move,
    draggedAttr: () =>
      Array.from(document.querySelectorAll('[data-testid]')).map((el) =>
        el.getAttribute('data-dragging'),
      ),
  };
}

function row(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="row-${id}"]`);
  if (!el) throw new Error(`row ${id} missing`);
  return el;
}

function mouseDown(el: HTMLElement, clientX = 10, clientY = 10): void {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX, clientY }));
}

function mouseMoveOver(el: HTMLElement, clientX: number, clientY: number): void {
  // jsdom has no layout, so elementFromPoint is unusable; dispatching on the
  // row itself lets the core resolve the target via `closest()`.
  el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX, clientY }));
}

function mouseUp(): void {
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
}

function contextMenu(el: HTMLElement): void {
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 40, clientY: 40 }),
  );
}

describe('useRowGestures', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens the context menu on right-click without a drag', () => {
    const h = renderRows({ indexAttribute: 'data-item-index' });
    contextMenu(row('b'));
    expect(h.menu()).toEqual([['b', expect.anything()]]);
    expect(h.draggedAttr()).toEqual([null, null, null]);
    h.cleanup();
  });

  it('previews a reorder after dragging past the threshold', () => {
    const h = renderRows({ indexAttribute: 'data-item-index' });
    mouseDown(row('a'));
    mouseMoveOver(row('b'), 40, 40);
    mouseUp();
    expect(h.move()).toEqual([['a', 1]]);
    h.cleanup();
  });

  it('reflects the dragged index in the rows it controls', () => {
    const h = renderRows({ indexAttribute: 'data-item-index', canDrag: () => true });
    act(() => {
      mouseDown(row('a'));
      mouseMoveOver(row('b'), 40, 40);
    });
    const during = h.draggedAttr();
    act(() => mouseUp());
    expect(during).toEqual(['', null, null]);
    expect(h.draggedAttr()).toEqual([null, null, null]);
    h.cleanup();
  });

  it('cleans up document listeners on unmount', () => {
    const h = renderRows({ indexAttribute: 'data-item-index' });
    const a = row('a');
    const b = row('b');
    h.cleanup();
    act(() => {
      mouseDown(a);
      mouseMoveOver(b, 40, 40);
      mouseUp();
    });
    expect(h.move()).toEqual([]);
  });
});
