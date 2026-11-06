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

const DURATION = 420;
// Ease-in-out, not ease-out: an ease-out curve covers most of the distance in the first
// third of the time, so the window is already near the centre before the eye registers the
// button — it reads as "appeared in the middle". An even curve keeps it anchored to the
// control it came from for the whole travel.
const EASING = 'cubic-bezier(0.62, 0.02, 0.3, 1)';

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

  // The dialog is centred by its own transform (Radix writes translate(-50%, -50%)), so the
  // morph composes with that matrix instead of replacing it: base * translate * scale.
  // Animating individual `translate`/`scale` properties did not survive the real render —
  // the window kept its centred position and only faded, which is what "appears from the
  // middle" looked like.
  const computed = getComputedStyle(dialog).transform;
  const base = computed === 'none' ? new DOMMatrix() : new DOMMatrix(computed);
  const startMatrix = base.translate(dx, dy).scale(sx, sy);

  dialog.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: 150,
    easing: 'ease-out',
    fill: 'both',
  });
  dialog.animate([{ transform: startMatrix.toString() }, { transform: base.toString() }], {
    duration: DURATION,
    easing: EASING,
    fill: 'both',
  });
}
