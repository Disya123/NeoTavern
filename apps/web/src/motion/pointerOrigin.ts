/**
 * Where the last pointer press landed.
 *
 * A dialog that scales in from its own centre reads as "it appeared". One that grows out of
 * the control that opened it reads as "I opened it". The position has to be captured before
 * the dialog mounts, so this listens once at pointerdown and keeps the last point.
 */

export interface PointerOrigin {
  x: number;
  y: number;
}

let last: PointerOrigin | null = null;
let lastTrigger: Element | null = null;
let installed = false;

export function installPointerOrigin(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener(
    'pointerdown',
    (event) => {
      last = { x: event.clientX, y: event.clientY };
      const target = event.target;
      lastTrigger =
        target instanceof Element
          ? (target.closest('button, a[href], [role="button"]') ?? target)
          : null;
    },
    { capture: true, passive: true },
  );
  // A keyboard activation has no pointer: fall back to the focused control's centre.
  window.addEventListener('keydown', () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      const rect = active.getBoundingClientRect();
      last = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      lastTrigger = active;
    }
  });
}

export function readPointerOrigin(): PointerOrigin | null {
  return last;
}

/** The control that was pressed, so a window can morph out of it. */
export function readTriggerRect(): DOMRect | null {
  return lastTrigger?.isConnected === true ? lastTrigger.getBoundingClientRect() : null;
}
