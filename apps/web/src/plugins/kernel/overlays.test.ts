import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '@neotavern/contracts';
import { kernel } from '@neotavern/plugin-sdk';
import { FrontendPluginRuntime, type RuntimeFrame } from '../runtime.js';
import { attachOverlays } from './overlays.js';

type PortListener = (event: { data: unknown }) => void;

/** Minimal in-memory port pair: RPC envelopes only, no transferred buffers. */
class TestPort {
  onmessage: PortListener | null = null;
  peer: TestPort | null = null;
  postMessage(value: unknown): void {
    this.peer?.onmessage?.({ data: structuredClone(value) });
  }
  start(): void {}
}

function createSessionPair(): { host: kernel.KernelSession; plugin: kernel.KernelSession } {
  const left = new TestPort();
  const right = new TestPort();
  left.peer = right;
  right.peer = left;
  return {
    host: new kernel.KernelSession(left as unknown as MessagePort, {
      instanceId: 'host',
      role: 'host',
    }),
    plugin: new kernel.KernelSession(right as unknown as MessagePort, {
      instanceId: 'plugin',
      role: 'plugin',
    }),
  };
}

function installedPlugin(grantedCapabilities: string[] = ['ui.overlay']): InstalledPlugin {
  return {
    id: 'test.overlays',
    name: 'Overlays',
    version: '1.0.0',
    apiVersion: 2,
    enabled: true,
    status: 'active',
    manifest: {},
    requestedPermissions: [],
    grantedPermissions: [],
    grantedCapabilities: grantedCapabilities.map((name) => ({
      name,
      revision: 1,
      grantedAt: 1,
    })),
    addedPermissions: [],
    installedAt: 1,
    updatedAt: 1,
    hasFrontend: true,
    hasBackend: false,
    hasStyles: false,
    hasLegacyFrontend: false,
    hasLegacyBackend: false,
    compatibilityLevel: 'native-v2',
    trust: 'unsigned-untrusted',
    lastErrorCode: null,
  };
}

function mockRect(
  element: HTMLElement,
  rect: { x: number; y: number; width: number; height: number },
): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: rect.x,
    y: rect.y,
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    width: rect.width,
    height: rect.height,
    toJSON: () => ({}),
  } as DOMRect);
  // The runtime tracks overlay rects via window resize/scroll listeners.
  window.dispatchEvent(new Event('resize'));
}

interface Harness {
  runtime: FrontendPluginRuntime;
  frame: RuntimeFrame;
  plugin: kernel.KernelSession;
}

function setup(capabilities: string[] = ['ui.overlay']): Harness {
  vi.useFakeTimers();
  const runtime = new FrontendPluginRuntime();
  runtime.sync([installedPlugin(capabilities)]);
  const frame = runtime.kernelGetFrame('test.overlays');
  if (!frame) throw new Error('frame missing');
  const { host, plugin } = createSessionPair();
  attachOverlays({
    pluginId: 'test.overlays',
    frame,
    session: host,
    runtime,
    hasCapability: (name) => runtime.kernelHasCapability(frame, name),
    currentChatId: () => null,
    currentProviderId: () => null,
  });
  // The real runtime assigns the session on sandbox ACK; tests inject it.
  frame.session = host;
  return { runtime, frame, plugin };
}

async function register(
  plugin: kernel.KernelSession,
  params: Record<string, unknown>,
): Promise<{ registrationId: string }> {
  // The host handler resolves with the plain registration payload.
  return (await plugin.call('ui.overlay.register', params)) as { registrationId: string };
}

interface LayoutPayload {
  revision: number;
  rects: Array<Record<string, unknown>>;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('rev4 kernel overlays', () => {
  it('registers a native overlay: entry, registration and clip union rect', async () => {
    const { runtime, frame, plugin } = setup();
    const layouts: unknown[] = [];
    plugin.handle('ui.overlay.layout', (request) => {
      layouts.push(request.params);
      return {};
    });

    const { registrationId } = await register(plugin, {
      mode: 'native',
      initialRect: { x: 10, y: 20, width: 100, height: 50 },
    });

    const overlay = frame.overlays.get(registrationId);
    expect(overlay?.hitPolicy).toBe('native');
    expect(runtime.kernelGetRegistration(registrationId)?.kind).toBe('overlays');
    expect(overlay?.container.isConnected).toBe(true);

    mockRect(overlay!.container, { x: 10, y: 20, width: 100, height: 50 });
    vi.advanceTimersByTime(64);

    const clipRect = frame.clipPath.querySelector('rect');
    expect(clipRect).not.toBeNull();
    expect(clipRect?.getAttribute('x')).toBe('10');
    expect(clipRect?.getAttribute('width')).toBe('100');
    expect(layouts).toHaveLength(1);
    const payload = layouts[0] as LayoutPayload;
    expect(payload.revision).toBe(1);
    expect(payload.rects[0]).toMatchObject({
      registrationId,
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it('proxy overlays join the clip union and forward shape-gated packets', async () => {
    const { frame, plugin } = setup(['ui.overlay.proxy']);
    const packets: Array<Record<string, unknown>> = [];
    plugin.handle('ui.overlay.pointer', (request) => {
      const params = request.params as { packet?: Record<string, unknown> } | undefined;
      if (params?.packet) packets.push(params.packet);
      return {};
    });

    const { registrationId } = await register(plugin, {
      mode: 'proxy',
      initialRect: { x: 10, y: 20, width: 100, height: 50 },
      hitShapes: [{ kind: 'circle', cx: 50, cy: 25, r: 15 }],
    });
    const overlay = frame.overlays.get(registrationId)!;
    mockRect(overlay.container, { x: 10, y: 20, width: 100, height: 50 });
    vi.advanceTimersByTime(64);

    // Proxy visuals stay visible (rev4 §G3): the rect joins the clip union.
    const clipRect = frame.clipPath.querySelector('rect');
    expect(clipRect).not.toBeNull();
    expect(clipRect?.getAttribute('x')).toBe('10');
    expect(clipRect?.getAttribute('width')).toBe('100');

    const hitDiv = frame.hitLayer?.querySelector<HTMLDivElement>(
      `[data-registration-id="${registrationId}"]`,
    );
    expect(hitDiv).not.toBeNull();

    const fire = (clientX: number, clientY: number): void => {
      const event = new Event('pointerdown') as PointerEvent;
      Object.assign(event, {
        clientX,
        clientY,
        button: 0,
        pressure: 0.5,
        pointerId: 7,
        buttons: 1,
      });
      hitDiv!.dispatchEvent(event);
    };

    fire(60, 45); // circle center in viewport coordinates
    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({
      type: 'down',
      x: 0.5,
      y: 0.5,
      button: 0,
      pointerId: 7,
      sequence: 0,
    });
    expect(typeof packets[0]?.['timestamp']).toBe('number');

    fire(15, 25); // inside the rect but outside the circle: no packet
    expect(packets).toHaveLength(1);

    fire(60, 45);
    expect(packets).toHaveLength(2);
    expect(packets[1]?.['sequence']).toBe(1);
  });

  it('dispose removes the container, overlay entry and registration', async () => {
    const { runtime, frame, plugin } = setup();
    const { registrationId } = await register(plugin, {
      mode: 'native',
      initialRect: { x: 0, y: 0, width: 40, height: 40 },
    });
    const container = frame.overlays.get(registrationId)!.container;
    expect(container.isConnected).toBe(true);

    await plugin.call('ui.overlay.dispose', { registrationId });

    expect(frame.overlays.has(registrationId)).toBe(false);
    expect(runtime.kernelGetRegistration(registrationId)).toBeUndefined();
    expect(container.isConnected).toBe(false);
  });

  it('rejects a second full overlay and ungranted modes', async () => {
    const { plugin } = setup(['ui.overlay.full']);
    await register(plugin, { mode: 'full' });
    await expect(plugin.call('ui.overlay.register', { mode: 'full' })).rejects.toMatchObject({
      code: kernel.KernelErrorCode.VALIDATION_FAILED,
    });

    const denied = setup(['ui.overlay.native']);
    await expect(
      denied.plugin.call('ui.overlay.register', { mode: 'proxy' }),
    ).rejects.toMatchObject({
      code: kernel.KernelErrorCode.CAPABILITY_DENIED,
    });
  });

  it('update resizes the host container and republishes layout', async () => {
    const { frame, plugin } = setup();
    const { registrationId } = await register(plugin, { mode: 'native' });
    const container = frame.overlays.get(registrationId)!.container;

    await plugin.call('ui.overlay.update', {
      registrationId,
      rect: { x: 5, y: 6, width: 200, height: 80 },
    });

    expect(container.style.width).toBe('200px');
    expect(container.style.left).toBe('5px');
  });

  it('deduplicates identical layout pushes and republishes on geometry change', async () => {
    const { runtime, frame, plugin } = setup();
    const layouts: unknown[] = [];
    plugin.handle('ui.overlay.layout', (request) => {
      layouts.push(request.params);
      return {};
    });

    const { registrationId } = await register(plugin, {
      mode: 'native',
      initialRect: { x: 10, y: 20, width: 100, height: 50 },
    });
    const overlay = frame.overlays.get(registrationId)!;
    mockRect(overlay.container, { x: 10, y: 20, width: 100, height: 50 });
    vi.advanceTimersByTime(64);
    expect(layouts).toHaveLength(1);

    // Same geometry: repeated pushes are skipped (resize-loop guard).
    runtime.kernelPushOverlayLayout(frame);
    runtime.kernelPushOverlayLayout(frame);
    expect(layouts).toHaveLength(1);

    // Changed geometry publishes a fresh revision.
    mockRect(overlay.container, { x: 11, y: 20, width: 100, height: 50 });
    vi.advanceTimersByTime(64);
    expect(layouts).toHaveLength(2);
    const payload = layouts[1] as LayoutPayload;
    expect(payload.revision).toBe(2);
    expect(payload.rects[0]).toMatchObject({
      registrationId,
      x: 11,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it('native overlays render hitShapes as SVG clip primitives', async () => {
    const { frame, plugin } = setup();
    const { registrationId } = await register(plugin, {
      mode: 'native',
      initialRect: { x: 10, y: 20, width: 100, height: 50 },
      hitShapes: [
        { kind: 'circle', cx: 50, cy: 25, r: 15 },
        {
          kind: 'polygon',
          points: [
            [0, 0],
            [10, 0],
            [5, 8],
          ],
        },
      ],
    });
    const overlay = frame.overlays.get(registrationId)!;
    mockRect(overlay.container, { x: 10, y: 20, width: 100, height: 50 });
    vi.advanceTimersByTime(64);

    // Shapes replace the plain rect inside the union.
    expect(frame.clipPath.querySelector('rect')).toBeNull();
    const circle = frame.clipPath.querySelector('circle');
    expect(circle?.getAttribute('cx')).toBe('60');
    expect(circle?.getAttribute('cy')).toBe('45');
    expect(circle?.getAttribute('r')).toBe('15');
    const polygon = frame.clipPath.querySelector('polygon');
    expect(polygon?.getAttribute('points')).toBe('10,20 20,20 15,28');

    // Shape-only update swaps the primitives without touching the rect.
    await plugin.call('ui.overlay.update', {
      registrationId,
      hitShapes: [{ kind: 'rect', x: 0, y: 0, width: 40, height: 20 }],
    });
    vi.advanceTimersByTime(64);
    expect(frame.clipPath.querySelector('circle')).toBeNull();
    const rect = frame.clipPath.querySelector('rect');
    expect(rect?.getAttribute('x')).toBe('10');
    expect(rect?.getAttribute('width')).toBe('40');
    expect(rect?.getAttribute('height')).toBe('20');
  });

  it('validates hitShapes against the overlay limits', async () => {
    const { plugin } = setup();
    await expect(
      register(plugin, { mode: 'native', hitShapes: [{ kind: 'hex' }] }),
    ).rejects.toMatchObject({ code: kernel.KernelErrorCode.VALIDATION_FAILED });
    await expect(
      register(plugin, {
        mode: 'native',
        hitShapes: Array.from({ length: 33 }, () => ({ kind: 'circle', cx: 1, cy: 1, r: 1 })),
      }),
    ).rejects.toMatchObject({ code: kernel.KernelErrorCode.VALIDATION_FAILED });
    await expect(
      register(plugin, {
        mode: 'native',
        hitShapes: [
          {
            kind: 'polygon',
            points: [
              [0, 0],
              [1, 1],
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: kernel.KernelErrorCode.VALIDATION_FAILED });
    await expect(
      register(plugin, {
        mode: 'full',
        hitShapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1 }],
      }),
    ).rejects.toMatchObject({ code: kernel.KernelErrorCode.VALIDATION_FAILED });
  });

  it('rate-limits shape updates to overlays.maxUpdatesPerSecond', async () => {
    const { plugin } = setup();
    const { registrationId } = await register(plugin, {
      mode: 'native',
      initialRect: { x: 0, y: 0, width: 10, height: 10 },
    });
    const shape = [{ kind: 'circle', cx: 5, cy: 5, r: 2 }];
    const max = kernel.DEFAULT_PLUGIN_LIMITS.overlays.maxUpdatesPerSecond;
    for (let i = 0; i < max; i += 1) {
      await plugin.call('ui.overlay.update', { registrationId, hitShapes: shape });
    }
    await expect(
      plugin.call('ui.overlay.update', { registrationId, hitShapes: shape }),
    ).rejects.toMatchObject({ code: kernel.KernelErrorCode.PLUGIN_QUOTA_EXCEEDED });

    vi.advanceTimersByTime(1001);
    await expect(
      plugin.call('ui.overlay.update', { registrationId, hitShapes: shape }),
    ).resolves.toEqual({});
  });

  it('none overlays stay visible with an absorbing hit-div', async () => {
    const { frame, plugin } = setup(['ui.overlay']);
    const packets: unknown[] = [];
    plugin.handle('ui.overlay.pointer', (request) => {
      const params = request.params as { packet?: unknown } | undefined;
      if (params?.packet) packets.push(params.packet);
      return {};
    });

    const { registrationId } = await register(plugin, {
      mode: 'none',
      initialRect: { x: 0, y: 0, width: 80, height: 40 },
    });
    const overlay = frame.overlays.get(registrationId)!;
    mockRect(overlay.container, { x: 0, y: 0, width: 80, height: 40 });
    vi.advanceTimersByTime(64);

    // Visible: the rect joins the clip union.
    expect(frame.clipPath.querySelector('rect')).not.toBeNull();
    // Non-interactive: the absorbing hit-div swallows pointers silently.
    const hitDiv = frame.hitLayer?.querySelector<HTMLDivElement>(
      `[data-registration-id="${registrationId}"]`,
    );
    expect(hitDiv).not.toBeNull();
    const event = new Event('pointerdown') as PointerEvent;
    Object.assign(event, { clientX: 10, clientY: 10, button: 0, pointerId: 1 });
    hitDiv!.dispatchEvent(event);
    expect(packets).toHaveLength(0);
  });

  it('full overlays activate the host chrome and ui.overlay.escape closes them (rev4 §G7)', async () => {
    const { runtime, frame, plugin } = setup(['ui.overlay']);
    expect(runtime.getOverlayChrome()).toMatchObject({ active: false });

    const { registrationId } = await register(plugin, {
      mode: 'full',
      initialRect: { x: 0, y: 0, width: 200, height: 150 },
    });
    vi.advanceTimersByTime(64);

    // The chrome names the plugin and points at the live full overlay.
    expect(runtime.getOverlayChrome()).toMatchObject({
      active: true,
      pluginId: 'test.overlays',
      pluginName: 'Overlays',
      registrationId,
    });

    // Escape relayed from the sandbox closes the overlay host-side; the
    // plugin's overlay DOM is disposed through the unmount RPC.
    interface UnmountParams {
      surfaceId?: string;
    }
    let unmounted = false;
    plugin.handle('ui.surface.unmount', (request) => {
      const params = request.params as UnmountParams | undefined;
      unmounted = params?.surfaceId === registrationId;
      return {};
    });
    const escaped = await plugin.call('ui.overlay.escape', {});
    expect(escaped).toEqual({});
    expect(unmounted).toBe(true);
    expect(frame.overlays.has(registrationId)).toBe(false);
    expect(runtime.getOverlayChrome()).toMatchObject({ active: false });
    vi.useRealTimers();
  });

  it('full overlays are capped at one per frame and the chrome survives sibling surfaces', async () => {
    const { runtime, plugin } = setup(['ui.overlay']);

    const first = await register(plugin, {
      mode: 'full',
      initialRect: { x: 0, y: 0, width: 200, height: 150 },
    });
    vi.advanceTimersByTime(64);
    await expect(
      register(plugin, { mode: 'full', initialRect: { x: 0, y: 0, width: 10, height: 10 } }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: kernel.KernelErrorCode.VALIDATION_FAILED }),
    );

    // A proxy sibling does not clear the chrome.
    await register(plugin, { mode: 'proxy', initialRect: { x: 0, y: 0, width: 40, height: 40 } });
    vi.advanceTimersByTime(64);
    expect(runtime.getOverlayChrome().registrationId).toBe(first.registrationId);
    vi.useRealTimers();
  });
});
