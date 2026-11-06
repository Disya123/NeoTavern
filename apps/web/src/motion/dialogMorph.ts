/**
 * The window grows out of the control that opened it.
 *
 * A dialog that fades in reads as "it appeared". A dialog that starts as the pressed
 * control's box and expands into place reads as "I opened it" — the same trick macOS and
 * Material call a container transform.
 *
 * Implemented with the Web Animations API rather than a CSS transition: the start state has
 * to be computed from two live rects, and a transition started in the same frame as the
 * element's first paint does not reliably animate.
 */
import { readTriggerRect } from './pointerOrigin.js';

const DURATION = 320;
const EASING = 'cubic-bezier(0.16, 1, 0.3, 1)';

export function animateDialogFromTrigger(): void {
  const dialog = document.querySelector<HTMLElement>(
    '[data-component="dialog-content"][data-state="open"]',
  );
  if (dialog === null) return;
  const rect = dialog.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const trigger = readTriggerRect();
  const dx = trigger ? trigger.left + trigger.width / 2 - (rect.left + rect.width / 2) : 0;
  const dy = trigger ? trigger.top + trigger.height / 2 - (rect.top + rect.height / 2) : 18;
  const sx = trigger ? Math.max(trigger.width / rect.width, 0.04) : 0.96;
  const sy = trigger ? Math.max(trigger.height / rect.height, 0.04) : 0.96;

  dialog.animate(
    [
      { translate: `${dx}px ${dy}px`, scale: `${sx} ${sy}`, opacity: 0 },
      { translate: '0px 0px', scale: '1 1', opacity: 1 },
    ],
    { duration: DURATION, easing: EASING, fill: 'both' },
  );
}
