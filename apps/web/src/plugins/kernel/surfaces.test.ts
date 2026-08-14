/**
 * Rev4 §A4 kernel surface host tests: kernel-flagged registrations mount the
 * plugin runner over the kernel port (`ui.surface.mount` / `ui.surface.layout`
 * / `ui.surface.unmount`), join the iframe clip union, and never use the v2
 * postMessage mount channel.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '@neotavern/contracts';
import { kernel } from '@neotavern/plugin-sdk';
import { FrontendPluginRuntime, type RuntimeFrame } from '../runtime.js';
import { attachCommands } from './commands.js';

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

function installedPlugin(): InstalledPlugin {
  return {
    id: 'test.surfaces',
    name: 'Surfaces',
    version: '1.0.0',
    apiVersion: 2,
    enabled: true,
    status: 'active',
    manifest: {},
    requestedPermissions: [],
    grantedPermissions: [],
    grantedCapabilities: [
      { name: 'ui.surfaces', revision: 1, grantedAt: 1 },
      { name: 'ui.commands', revision: 1, grantedAt: 1 },
    ],
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
  window.dispatchEvent(new Event('resize'));
}

interface Harness {
  runtime: FrontendPluginRuntime;
  frame: RuntimeFrame;
  host: kernel.KernelSession;
  plugin: kernel.KernelSession;
}

function setup(): Harness {
  vi.useFakeTimers();
  const runtime = new FrontendPluginRuntime();
  runtime.sync([installedPlugin()]);
  const frame = runtime.kernelGetFrame('test.surfaces');
  if (!frame) throw new Error('frame missing');
  const { host, plugin } = createSessionPair();
  attachCommands({
    pluginId: 'test.surfaces',
    frame,
    session: host,
    runtime,
    hasCapability: (name) => runtime.kernelHasCapability(frame, name),
    currentChatId: () => null,
    currentProviderId: () => null,
  });
  // The real runtime assigns the session on sandbox ACK; tests inject it.
  frame.session = host;
  return { runtime, frame, host, plugin };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('kernel surfaces (rev4 §A4)', () => {
  it('registers a kernel-flagged surface over the kernel port', async () => {
    const { plugin } = setup();
    const result = (await plugin.call('surfaces.register', {
      kind: 'settingsPanels',
      definition: { title: 'Kernel panel' },
      kernel: true,
    })) as { surfaceId: string };
    expect(result.surfaceId).toMatch(/^surf:/);
  });

  it('mounts the plugin runner via ui.surface.mount and pushes layout rects', async () => {
    const { runtime, frame, plugin } = setup();
    const mounts: Array<Record<string, unknown>> = [];
    const layouts: Array<Array<Record<string, unknown>>> = [];
    plugin.handle('ui.surface.mount', ({ params }) => {
      mounts.push(params as Record<string, unknown>);
      return {};
    });
    plugin.handle('ui.surface.layout', ({ params }) => {
      layouts.push((params as { rects: Array<Record<string, unknown>> }).rects);
      return {};
    });

    const registered = (await plugin.call('surfaces.register', {
      kind: 'settingsPanels',
      definition: { title: 'Kernel panel' },
      kernel: true,
    })) as { surfaceId: string };

    const container = document.createElement('div');
    document.body.append(container);
    mockRect(container, { x: 10, y: 20, width: 200, height: 100 });
    const unmount = runtime.kernelMountSurface(frame, registered.surfaceId, container);
    await vi.advanceTimersByTimeAsync(100);

    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toEqual({ surfaceId: registered.surfaceId });
    // The kernel rect joins the clip union so the sandbox pixels show through.
    const clipRects = [...frame.clipPath.children].map((child) => child.getAttribute('width'));
    expect(clipRects).toContain('200');
    // Layout rects reach the sandbox over the kernel port.
    const flat = layouts.flat();
    expect(flat.some((rect) => rect['registrationId'] === registered.surfaceId)).toBe(true);

    // The v2 mount channel must never see a kernel surface.
    const postMessage = vi.spyOn(frame.iframe.contentWindow!, 'postMessage');
    await vi.advanceTimersByTimeAsync(100);
    for (const call of postMessage.mock.calls) {
      const message = call[0] as { type: string; registrationId?: string };
      expect(message.type).not.toBe('neotavern.plugin.mount');
    }

    unmount();
    await vi.advanceTimersByTimeAsync(100);
    expect(frame.surfaceContainers.has(registered.surfaceId)).toBe(false);
  });

  it('unmounts the sandbox runner when the registration is removed', async () => {
    const { runtime, frame, plugin } = setup();
    const unmounts: string[] = [];
    plugin.handle('ui.surface.unmount', ({ params }) => {
      unmounts.push((params as { surfaceId: string }).surfaceId);
      return {};
    });
    const registered = (await plugin.call('surfaces.register', {
      kind: 'sidebarPanels',
      definition: { title: 'Side' },
      kernel: true,
    })) as { surfaceId: string };
    const container = document.createElement('div');
    document.body.append(container);
    runtime.kernelMountSurface(frame, registered.surfaceId, container);
    await vi.advanceTimersByTimeAsync(100);

    runtime.kernelRemoveRegistration(registered.surfaceId);
    await vi.advanceTimersByTimeAsync(100);
    expect(unmounts).toEqual([registered.surfaceId]);
    expect(frame.overlays.has(registered.surfaceId)).toBe(false);
  });

  it('invokes kernel registrations over the kernel port, not postMessage', async () => {
    const { runtime, frame, plugin } = setup();
    plugin.handle('commands.run', ({ params }) => {
      return { ran: (params as { commandId: string }).commandId };
    });
    const postMessage = vi.spyOn(frame.iframe.contentWindow!, 'postMessage');
    const result = await runtime.invoke({
      pluginId: 'test.surfaces',
      pluginName: 'Surfaces',
      registrationId: 'cmd:demo',
      kind: 'commands',
      definition: { id: 'demo', title: 'Demo', kernel: true },
      kernel: true,
    });
    expect(result).toEqual({ ran: 'cmd:demo' });
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'neotavern.plugin.invoke' }),
      '*',
    );
  });

  it('advertises the notifications feature and negotiates versions', () => {
    const { runtime } = setup();
    expect(runtime.kernelSupportedFeature('ui.notifications', 1)).toBe(true);
    expect(runtime.kernelSupportedFeature('ui.surfaces', 1)).toBe(true);
    expect(runtime.kernelSupportedFeature('ui.surfaces', 2)).toBe(false);
  });
});
