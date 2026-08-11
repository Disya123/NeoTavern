// @vitest-environment jsdom
/**
 * @neotavern/gestures core tests: right-click / long-press context menu and
 * mouse/touch drag recognition, thresholds, click suppression and cleanup.
 * Uses plain DOM events (jsdom has no TouchEvent/TouchList constructor), so
 * touch events are plain Events carrying `touches`/`changedTouches` arrays.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRowGestures,
  type RowGestureController,
  type RowGestureOptions,
} from '../src/index.js';

interface TouchStub {
  identifier: number;
  clientX: number;
  clientY: number;
}

function touchEvent(type: string, touches: TouchStub[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { configurable: true, value: touches });
  Object.defineProperty(event, 'changedTouches', { configurable: true, value: touches });
  return event;
}

function mouseEvent(type: string, init: MouseEventInit): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
}

interface Harness {
  rows: HTMLElement[];
  controller: RowGestureController;
  calls: Record<string, unknown[]>;
}

function setup(options: Partial<RowGestureOptions> = {}): Harness {
  const calls: Record<string, unknown[]> = { start: [], move: [], end: [], menu: [] };
  const controller = createRowGestures({
    indexAttribute: 'data-item-index',
    onDragStart: (itemId, index) => calls['start'].push([itemId, index]),
    onDragMove: (itemId, toIndex, point) => calls['move'].push([itemId, toIndex, point]),
    onDragEnd: (itemId, committed) => calls['end'].push([itemId, committed]),
    onOpenMenu: (itemId, at) => calls['menu'].push([itemId, at]),
    ...options,
  });
  const list = document.createElement('ul');
  const rows = Array.from({ length: 3 }, (_, index) => {
    const row = document.createElement('li');
    row.setAttribute('data-item-index', String(index));
    list.append(row);
    return row;
  });
  document.body.append(list);
  return { rows, controller, calls };
}

function mouseDown(controller: RowGestureController, row: HTMLElement, x = 0, y = 0): void {
  controller.onMouseDown(mouseEvent('mousedown', { button: 0, clientX: x, clientY: y }), 'item', 0);
}

/** Attach the row handlers the same way the React hook does (touchstart is the only row-level touch event). */
function attachTouch(
  controller: RowGestureController,
  row: HTMLElement,
  itemId = 'item',
  index = 0,
): void {
  row.addEventListener('touchstart', (event) => {
    controller.onTouchStart(event as TouchEvent, itemId, index);
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createRowGestures context menu', () => {
  it('opens the menu on right-click and prevents the browser menu', () => {
    const { controller, calls } = setup();
    const row = document.querySelector<HTMLElement>('[data-item-index="0"]');
    const event = mouseEvent('contextmenu', { button: 2, clientX: 40, clientY: 50 });
    controller.onContextMenu(event, 'item');
    expect(event.defaultPrevented).toBe(true);
    expect(calls['menu']).toEqual([['item', { x: 40, y: 50 }]]);
    expect(row).not.toBeNull();
  });

  it('opens the menu on a stationary touch hold and suppresses the next click', () => {
    vi.useFakeTimers();
    const { controller, calls } = setup();
    const row = document.querySelector<HTMLElement>('[data-item-index="0"]');
    if (!row) throw new Error('row missing');
    attachTouch(controller, row);
    const touch = { identifier: 1, clientX: 10, clientY: 20 };
    row.dispatchEvent(touchEvent('touchstart', [touch]));
    vi.advanceTimersByTime(700);
    expect(calls['menu']).toEqual([['item', { x: 10, y: 20 }]]);
    expect(controller.consumeClick()).toBe(true);
    expect(controller.consumeClick()).toBe(false);
    row.dispatchEvent(touchEvent('touchend', [touch]));
  });

  it('cancels the long-press when the finger moves (scroll intent), even without drag permission', () => {
    vi.useFakeTimers();
    const { controller, calls } = setup({ canDrag: () => false });
    const rows = document.querySelectorAll<HTMLElement>('[data-item-index]');
    attachTouch(controller, rows[0] ?? document.body);
    const touch = { identifier: 1, clientX: 10, clientY: 20 };
    rows[0]?.dispatchEvent(touchEvent('touchstart', [touch]));
    rows[2]?.dispatchEvent(touchEvent('touchmove', [{ ...touch, clientX: 60, clientY: 70 }]));
    vi.advanceTimersByTime(1000);
    expect(calls['menu']).toEqual([]);
    expect(controller.consumeClick()).toBe(false);
    rows[0]?.dispatchEvent(touchEvent('touchend', [touch]));
  });

  it('keeps the menu working for items that cannot be dragged', () => {
    vi.useFakeTimers();
    const { controller, calls } = setup({ canDrag: () => false });
    const row = document.querySelector<HTMLElement>('[data-item-index="0"]');
    if (!row) throw new Error('row missing');
    attachTouch(controller, row);
    const touch = { identifier: 1, clientX: 10, clientY: 20 };
    row.dispatchEvent(touchEvent('touchstart', [touch]));
    vi.advanceTimersByTime(700);
    expect(calls['menu']).toHaveLength(1);
    row.dispatchEvent(touchEvent('touchend', [touch]));
  });

  it('does not open the menu for disabled long-press', () => {
    vi.useFakeTimers();
    const { controller, calls } = setup({ longPressMs: null });
    const row = document.querySelector<HTMLElement>('[data-item-index="0"]');
    if (!row) throw new Error('row missing');
    attachTouch(controller, row);
    const touch = { identifier: 1, clientX: 10, clientY: 20 };
    row.dispatchEvent(touchEvent('touchstart', [touch]));
    vi.advanceTimersByTime(2000);
    expect(calls['menu']).toEqual([]);
    row.dispatchEvent(touchEvent('touchend', [touch]));
  });
});

describe('createRowGestures mouse drag', () => {
  it('does not drag below the threshold', () => {
    const { controller, calls } = setup();
    const rows = document.querySelectorAll<HTMLElement>('[data-item-index]');
    mouseDown(controller, rows[0] ?? document.body, 10, 10);
    rows[0]?.dispatchEvent(mouseEvent('mousemove', { clientX: 13, clientY: 10 }));
    expect(calls['start']).toEqual([]);
    document.dispatchEvent(mouseEvent('mouseup', { clientX: 13, clientY: 10 }));
    expect(calls['end']).toEqual([]);
  });

  it('starts dragging past the threshold and previews the row under the pointer', () => {
    const { controller, calls } = setup();
    const rows = document.querySelectorAll<HTMLElement>('[data-item-index]');
    mouseDown(controller, rows[0] ?? document.body, 10, 10);
    rows[1]?.dispatchEvent(mouseEvent('mousemove', { clientX: 30, clientY: 30 }));
    expect(calls['start']).toEqual([['item', 0]]);
    expect(calls['move']).toHaveLength(1);
    expect(calls['move'][0]).toEqual(['item', 1, { x: 30, y: 30 }]);
    document.dispatchEvent(mouseEvent('mouseup', { clientX: 30, clientY: 30 }));
    expect(calls['end']).toEqual([['item', true]]);
    expect(controller.getDraggedIndex()).toBeNull();
  });

  it('ignores non-left buttons', () => {
    const { controller, calls } = setup();
    const row = document.querySelector<HTMLElement>('[data-item-index="0"]');
    const event = mouseEvent('mousedown', { button: 2, clientX: 10, clientY: 10 });
    controller.onMouseDown(event, 'item', 0);
    row?.dispatchEvent(mouseEvent('mousemove', { clientX: 30, clientY: 30 }));
    expect(calls['start']).toEqual([]);
  });

  it('does not drag when canDrag returns false', () => {
    const { controller, calls } = setup({ canDrag: () => false });
    const rows = document.querySelectorAll<HTMLElement>('[data-item-index]');
    mouseDown(controller, rows[0] ?? document.body, 10, 10);
    rows[1]?.dispatchEvent(mouseEvent('mousemove', { clientX: 30, clientY: 30 }));
    expect(calls['start']).toEqual([]);
    document.dispatchEvent(mouseEvent('mouseup', { clientX: 30, clientY: 30 }));
    expect(calls['end']).toEqual([]);
  });

  it('activates immediately with a zero threshold', () => {
    const { controller, calls } = setup({
      mouseDragThresholdPx: 0,
      touchDragThresholdPx: 0,
      longPressMs: undefined,
    });
    const rows = document.querySelectorAll<HTMLElement>('[data-item-index]');
    mouseDown(controller, rows[0] ?? document.body, 10, 10);
    expect(calls['start']).toEqual([['item', 0]]);
    document.dispatchEvent(mouseEvent('mouseup', { clientX: 10, clientY: 10 }));
    expect(calls['end']).toEqual([['item', false]]);
  });

  it('resolves the target row via elementFromPoint when the event target is not an element', () => {
    const { controller, calls } = setup();
    const rows = document.querySelectorAll<HTMLElement>('[data-item-index]');
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => rows[2] ?? null),
    });
    mouseDown(controller, rows[0] ?? document.body, 10, 10);
    document.dispatchEvent(mouseEvent('mousemove', { clientX: 30, clientY: 30 }));
    expect(calls['move'][0]?.[1]).toBe(2);
    document.dispatchEvent(mouseEvent('mouseup', { clientX: 30, clientY: 30 }));
  });

  it('suppresses the click after a finished drag, once', () => {
    const { controller } = setup();
    const rows = document.querySelectorAll<HTMLElement>('[data-item-index]');
    mouseDown(controller, rows[0] ?? document.body, 10, 10);
    rows[1]?.dispatchEvent(mouseEvent('mousemove', { clientX: 30, clientY: 30 }));
    document.dispatchEvent(mouseEvent('mouseup', { clientX: 30, clientY: 30 }));
    expect(controller.consumeClick()).toBe(true);
    expect(controller.consumeClick()).toBe(false);
  });
});

describe('createRowGestures touch drag', () => {
  it('starts dragging past the touch threshold', () => {
    const { controller, calls } = setup();
    const rows = document.querySelectorAll<HTMLElement>('[data-item-index]');
    attachTouch(controller, rows[0] ?? document.body);
    const touch = { identifier: 7, clientX: 10, clientY: 10 };
    rows[0]?.dispatchEvent(touchEvent('touchstart', [touch]));
    expect(calls['start']).toEqual([]);
    rows[2]?.dispatchEvent(touchEvent('touchmove', [{ ...touch, clientX: 30, clientY: 30 }]));
    expect(calls['start']).toEqual([['item', 0]]);
    expect(calls['move']).toHaveLength(1);
    expect(calls['move'][0]?.[1]).toBe(2);
    rows[0]?.dispatchEvent(touchEvent('touchend', [{ ...touch, clientX: 30, clientY: 30 }]));
    expect(calls['end']).toEqual([['item', true]]);
  });

  it('follows the touch by identifier and ignores other touches', () => {
    const { controller, calls } = setup();
    const rows = document.querySelectorAll<HTMLElement>('[data-item-index]');
    attachTouch(controller, rows[0] ?? document.body);
    const touch = { identifier: 3, clientX: 10, clientY: 10 };
    rows[0]?.dispatchEvent(touchEvent('touchstart', [touch]));
    rows[1]?.dispatchEvent(
      touchEvent('touchmove', [
        { ...touch, clientX: 30, clientY: 30 },
        { identifier: 9, clientX: 500, clientY: 500 },
      ]),
    );
    expect(calls['move']).toHaveLength(1);
    expect(calls['move'][0]?.[1]).toBe(1);
    rows[0]?.dispatchEvent(touchEvent('touchend', [touch]));
  });

  it('does not start a drag when canDrag returns false', () => {
    const { controller, calls } = setup({ canDrag: () => false });
    const rows = document.querySelectorAll<HTMLElement>('[data-item-index]');
    attachTouch(controller, rows[0] ?? document.body);
    const touch = { identifier: 7, clientX: 10, clientY: 10 };
    rows[0]?.dispatchEvent(touchEvent('touchstart', [touch]));
    rows[2]?.dispatchEvent(touchEvent('touchmove', [{ ...touch, clientX: 30, clientY: 30 }]));
    expect(calls['start']).toEqual([]);
    rows[0]?.dispatchEvent(touchEvent('touchend', [touch]));
    expect(calls['end']).toEqual([]);
  });

  it('activates immediately on touchstart with a zero threshold', () => {
    const { controller, calls } = setup({
      mouseDragThresholdPx: 0,
      touchDragThresholdPx: 0,
      longPressMs: undefined,
    });
    const rows = document.querySelectorAll<HTMLElement>('[data-item-index]');
    attachTouch(controller, rows[0] ?? document.body);
    const touch = { identifier: 7, clientX: 10, clientY: 10 };
    rows[0]?.dispatchEvent(touchEvent('touchstart', [touch]));
    expect(calls['start']).toEqual([['item', 0]]);
    rows[0]?.dispatchEvent(touchEvent('touchend', [touch]));
    expect(calls['end']).toEqual([['item', false]]);
  });
});

describe('createRowGestures lifecycle', () => {
  it('tracks and syncs the dragged index', () => {
    const { controller } = setup();
    const rows = document.querySelectorAll<HTMLElement>('[data-item-index]');
    mouseDown(controller, rows[0] ?? document.body, 10, 10);
    rows[1]?.dispatchEvent(mouseEvent('mousemove', { clientX: 30, clientY: 30 }));
    controller.setDraggedIndex(1);
    expect(controller.getDraggedIndex()).toBe(1);
    expect(controller.isDragging()).toBe(true);
    document.dispatchEvent(mouseEvent('mouseup', { clientX: 30, clientY: 30 }));
    expect(controller.isDragging()).toBe(false);
  });

  it('destroy removes listeners and pending timers', () => {
    vi.useFakeTimers();
    const { controller, calls } = setup();
    const rows = document.querySelectorAll<HTMLElement>('[data-item-index]');
    attachTouch(controller, rows[0] ?? document.body);
    const touch = { identifier: 7, clientX: 10, clientY: 10 };
    rows[0]?.dispatchEvent(touchEvent('touchstart', [touch]));
    controller.destroy();
    vi.advanceTimersByTime(1000);
    expect(calls['menu']).toEqual([]);
    rows[2]?.dispatchEvent(touchEvent('touchmove', [{ ...touch, clientX: 30, clientY: 30 }]));
    expect(calls['start']).toEqual([]);
    rows[0]?.dispatchEvent(touchEvent('touchend', [touch]));
    expect(calls['end']).toEqual([]);
  });

  it('is idempotent and leaves no listeners behind after destroy', () => {
    const { controller } = setup();
    controller.destroy();
    controller.destroy();
    expect(true).toBe(true);
  });

  it('prevents default on dragstart to disable native drag-and-drop', () => {
    const { controller } = setup();
    const event = new Event('dragstart', { bubbles: true, cancelable: true });
    controller.onDragStart(event as DragEvent);
    expect(event.defaultPrevented).toBe(true);
  });
});
