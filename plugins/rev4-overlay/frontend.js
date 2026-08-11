/**
 * Rev4 overlay example plugin (T3, apiVersion 2).
 *
 * Demonstrates the proxy-regions overlay model with hit shapes (rev4 §G3,
 * `ui.overlays` feature 3):
 *  - the visual plane (canvas particles) is NOT clipped — it paints the whole
 *    sandbox document; the host keeps the proxy rect inside the clip union;
 *  - the host owns the real pointer events on its hit surface and forwards
 *    normalized packets to `overlay.onPointer` (no synthetic DOM events are
 *    dispatched, `isTrusted` is never promised);
 *  - `hitShapes` narrows the interactive region to a circle: pointers inside
 *    the rect but outside the circle never reach the plugin;
 *  - geometry updates go through `overlay.update(rect, shapes)` in overlay
 *    CSS pixels;
 *  - explicit degradation: without `ui.overlays` support the plugin simply
 *    does not render instead of faking input.
 *
 * The packet counter is mirrored onto `<html data-overlay-packets>` so e2e
 * suites can observe the pointer pipeline without plugin UI.
 *
 * Cleanup lives in `deactivate()`: the host invokes it on disable/uninstall
 * and then disposes every tracked registration anyway.
 */

const INITIAL_RECT = { x: 24, y: 24, width: 360, height: 260 };
const PARTICLES = 48;

/** Circle covering the middle of the rect; the only interactive region. */
function circleFor(rect) {
  return [
    {
      kind: 'circle',
      cx: rect.width / 2,
      cy: rect.height / 2,
      r: Math.min(rect.width, rect.height) / 2 - 20,
    },
  ];
}

const plugin = {
  async activate(api) {
    if (!api.runtime || !api.runtime.supports('ui.overlays', 3)) return;

    const canvas = document.createElement('canvas');
    canvas.style.position = 'fixed';
    canvas.style.inset = '0';
    document.body.appendChild(canvas);
    const context = canvas.getContext('2d');
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    const overlay = await api.overlays.register('proxy', {
      initialRect: INITIAL_RECT,
      hitShapes: circleFor(INITIAL_RECT),
    });
    document.documentElement.setAttribute('data-overlay-ready', '1');

    // Normalized input packets (rev4 §G3): the plugin consumes coordinates,
    // it never receives fake PointerEvents.
    let attractor = null;
    let packets = 0;
    overlay.onPointer((packet) => {
      packets += 1;
      document.documentElement.setAttribute('data-overlay-packets', String(packets));
      if (packet.type === 'down' || packet.type === 'move') {
        attractor = { x: packet.x * canvas.width, y: packet.y * canvas.height };
      }
      if (packet.type === 'up' || packet.type === 'cancel') {
        attractor = null;
      }
    });

    const particles = Array.from({ length: PARTICLES }, (_, index) => ({
      x: (index * 97) % canvas.width,
      y: (index * 61) % canvas.height,
      vx: ((index % 5) - 2) * 0.6,
      vy: ((index % 3) - 1) * 0.6,
    }));

    let running = true;
    const step = () => {
      if (!running) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = 'rgba(120, 190, 255, 0.9)';
      for (const p of particles) {
        if (attractor) {
          p.vx += (attractor.x - p.x) * 0.0015;
          p.vy += (attractor.y - p.y) * 0.0015;
        }
        p.vx *= 0.995;
        p.vy *= 0.995;
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
        context.beginPath();
        context.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        context.fill();
      }
      window.requestAnimationFrame(step);
    };
    step();

    // Keep the host hit surface in sync with the viewport (rev4 §G5/G6):
    // geometry revisions are coalesced host-side.
    const onResize = () => {
      const width = Math.min(480, Math.max(240, Math.floor(window.innerWidth / 3)));
      const height = Math.min(320, Math.max(180, Math.floor(window.innerHeight / 3)));
      const rect = { x: 24, y: 24, width, height };
      overlay.update(rect, circleFor(rect));
    };
    window.addEventListener('resize', onResize);

    // rev4 §G7: host-controlled full overlay. While it is live the host
    // renders its own chrome (plugin name + close button) above every plugin
    // layer, makes the app background inert, restores focus on close, and
    // closes on Escape even when focus lives inside this sandbox document
    // (the sandbox relays the key to the host).
    let fullOverlay = null;
    await api.commands.register(
      'rev4-overlay.full',
      { title: 'Rev4 overlay: full overlay (host chrome)', category: 'rev4' },
      async () => {
        if (fullOverlay) return;
        fullOverlay = await api.overlays.register('full', {
          initialRect: {
            x: 0,
            y: 0,
            width: window.innerWidth,
            height: window.innerHeight,
          },
        });
        document.documentElement.setAttribute('data-overlay-full-ready', '1');
      },
      { kernel: true },
    );

    plugin.deactivate = () => {
      running = false;
      window.removeEventListener('resize', resize);
      window.removeEventListener('resize', onResize);
      canvas.remove();
      overlay.dispose();
      if (fullOverlay) {
        fullOverlay.dispose();
        fullOverlay = null;
      }
      document.documentElement.removeAttribute('data-overlay-full-ready');
    };
  },

  deactivate() {
    // Replaced by the per-activation closure assigned in activate(); the host
    // tolerates a missing or throwing deactivate.
  },
};

export default plugin;
