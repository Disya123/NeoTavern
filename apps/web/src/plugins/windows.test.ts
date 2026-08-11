/**
 * Rev4 §J3 multi-window: WindowRoleManager election (BroadcastChannel claims,
 * deterministic leader, lease expiry, release) and the kernel `windows.*`
 * slice (role RPCs + host-generated `window.background.changed` pushes,
 * session-scoped cleanup).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kernel } from '@neotavern/plugin-sdk';
import { attachWindows } from './kernel/windows.js';
import { WindowRoleManager, type WindowRoleChannel, type WindowRoleSnapshot } from './windows.js';
import type { KernelHostContext } from './kernel/types.js';

const { KernelErrorCode } = kernel;

const listenerSets = new WeakMap<WindowRoleChannel, Set<(event: { data: unknown }) => void>>();
function listenersOf(channel: WindowRoleChannel): Set<(event: { data: unknown }) => void> {
  let set = listenerSets.get(channel);
  if (!set) {
    set = new Set();
    listenerSets.set(channel, set);
  }
  return set;
}

/** In-memory BroadcastChannel hub shared by fake windows of one tab set. */
class FakeHub {
  private readonly channels = new Map<string, Set<WindowRoleChannel>>();

  create(name: string): WindowRoleChannel {
    const set = this.channels.get(name) ?? new Set<WindowRoleChannel>();
    this.channels.set(name, set);
    const channel: WindowRoleChannel = {
      postMessage: (message) => {
        // BroadcastChannel semantics: every registered listener of the
        // channel (including the sender) observes the message.
        for (const peer of [...set]) {
          for (const listener of [...listenersOf(peer)]) {
            try {
              listener({ data: message });
            } catch {
              // A failing listener must not break the hub.
            }
          }
        }
      },
      addEventListener: (_type, listener) => {
        listenersOf(channel).add(listener);
      },
      removeEventListener: (_type, listener) => {
        listenersOf(channel).delete(listener);
      },
      close: () => {
        this.channels.delete(name);
        set.delete(channel);
      },
    };
    set.add(channel);
    return channel;
  }

  count(name: string): number {
    return this.channels.get(name)?.size ?? 0;
  }
}

function manager(
  hub: FakeHub,
  installationId: string,
  windowId: string,
  heartbeatMs = 10,
  leaseMs = 50,
  createChannel: (name: string) => WindowRoleChannel = (name) => hub.create(name),
): WindowRoleManager {
  return new WindowRoleManager(installationId, {
    heartbeatMs,
    leaseMs,
    windowId,
    createChannel,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WindowRoleManager election (rev4 §J3)', () => {
  it('elects the smallest window id as primary once claims converge', () => {
    const hub = new FakeHub();
    const a = manager(hub, 'inst', 'a');
    const b = manager(hub, 'inst', 'b');
    a.start();
    b.start();

    expect(a.snapshot().isBackground).toBe(true); // alone at start
    expect(b.snapshot().isBackground).toBe(true); // has not heard of a yet

    vi.advanceTimersByTime(10); // one heartbeat round converges
    expect(a.snapshot()).toMatchObject({ role: 'primary', isBackground: true });
    expect(b.snapshot()).toMatchObject({ role: 'secondary', isBackground: false });
    expect(a.snapshot().windowId).toBe('a');
    expect(a.snapshot().installationId).toBe('inst');
  });

  it('takes over when the primary dies without releasing (lease expiry)', () => {
    const hub = new FakeHub();
    let channelA: WindowRoleChannel | null = null;
    const createChannelA = (name: string): WindowRoleChannel => {
      channelA = hub.create(name);
      return channelA;
    };
    const a = manager(hub, 'inst', 'a', 10, 50, createChannelA);
    const b = manager(hub, 'inst', 'b');
    a.start();
    b.start();
    vi.advanceTimersByTime(10);
    expect(b.snapshot().role).toBe('secondary');

    // Kill A without a release: its heartbeats stop reaching the hub.
    channelA!.postMessage = () => undefined;
    // B's own heartbeats keep its claim live; A's claim expires after the
    // lease, so B takes over.
    vi.advanceTimersByTime(60);
    expect(b.snapshot().role).toBe('primary');
  });

  it('releases on stop: the surviving window becomes primary immediately', () => {
    const hub = new FakeHub();
    const a = manager(hub, 'inst', 'a');
    const b = manager(hub, 'inst', 'b');
    a.start();
    b.start();
    vi.advanceTimersByTime(10);
    expect(b.snapshot().role).toBe('secondary');

    a.stop();
    expect(b.snapshot().role).toBe('primary');
  });

  it('fires change listeners once per transition with the new snapshot', () => {
    const hub = new FakeHub();
    const a = manager(hub, 'inst', 'a');
    const b = manager(hub, 'inst', 'b');
    const transitions: Array<{ role: string; isBackground: boolean }> = [];
    const off = b.onChange((snapshot) =>
      transitions.push({ role: snapshot.role, isBackground: snapshot.isBackground }),
    );
    b.start();
    a.start();
    vi.advanceTimersByTime(10);
    expect(transitions).toEqual([{ role: 'secondary', isBackground: false }]);
    a.stop();
    expect(transitions).toEqual([
      { role: 'secondary', isBackground: false },
      { role: 'primary', isBackground: true },
    ]);
    off();
  });

  it('stops itself when the last listener detaches', () => {
    const hub = new FakeHub();
    const a = manager(hub, 'inst', 'a');
    a.start();
    const off = a.onChange(() => undefined);
    off();
    expect(a.snapshot().role).toBe('standalone'); // channel closed
    expect(hub.count('neotavern:rev4:windows:inst')).toBe(0);
  });

  it('degrades to standalone without BroadcastChannel', () => {
    const a = new WindowRoleManager('inst', { windowId: 'a', createChannel: () => null });
    a.start();
    expect(a.snapshot()).toMatchObject({ role: 'standalone', isBackground: true });
    a.stop();
  });
});

describe('kernel windows slice (rev4 §J3)', () => {
  function fakeContext(installationId: string | null) {
    const hub = new FakeHub();
    const handlers = new Map<string, (ctx: { params: unknown }) => unknown>();
    const tracked: Array<{ dispose: () => void }> = [];
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const managers = new Map<string, WindowRoleManager>();
    const currentManager = (id: string): WindowRoleManager => {
      let m = managers.get(id);
      if (!m) {
        m = manager(hub, id, `w-${id}`);
        m.start();
        managers.set(id, m);
      }
      return m;
    };
    const session = {
      handle: vi.fn((method: string, handler: (ctx: { params: unknown }) => unknown) => {
        handlers.set(method, handler);
        return () => handlers.delete(method);
      }),
      emitEvent: vi.fn((event: string, payload: unknown) => {
        emitted.push({ event, payload });
      }),
      scope: {
        track: vi.fn((item: { dispose: () => void }) => {
          tracked.push(item);
          return item;
        }),
      },
    };
    const runtime = {
      kernelWindowRole: (id: string) => currentManager(id).snapshot(),
      kernelWindowRoleOnChange: (id: string, listener: (snapshot: unknown) => void) =>
        currentManager(id).onChange(listener as (snapshot: WindowRoleSnapshot) => void),
    };
    const ctx = {
      pluginId: 'test.windows',
      frame: { installationId },
      session,
      runtime,
      hasCapability: () => true,
      currentChatId: () => null,
    } as unknown as KernelHostContext;
    return { ctx, handlers, session, runtime, tracked, emitted, hub };
  }

  function invoke(
    handlers: Map<string, (ctx: { params: unknown }) => unknown>,
    method: string,
    params: unknown,
  ) {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`no handler for ${method}`);
    return handler({ params });
  }

  it('exposes the role and isBackground over RPC', () => {
    const fake = fakeContext('inst-1');
    attachWindows(fake.ctx);
    expect([...fake.handlers.keys()].sort()).toEqual(['windows.isBackground', 'windows.role']);

    const role = invoke(fake.handlers, 'windows.role', {}) as {
      role: string;
      windowId: string;
      installationId: string;
      isBackground: boolean;
    };
    expect(role).toMatchObject({
      role: 'primary',
      installationId: 'inst-1',
      isBackground: true,
    });
    expect(role.windowId).toBe('w-inst-1');
    const background = invoke(fake.handlers, 'windows.isBackground', {}) as {
      isBackground: boolean;
    };
    expect(background.isBackground).toBe(true);
  });

  it('pushes window.background.changed when the role transitions', () => {
    const fake = fakeContext('inst-1');
    attachWindows(fake.ctx);
    // A second window of the same installation claims the channel with a
    // smaller window id: this window loses the background role and the
    // host pushes the transition.
    const rival = manager(fake.hub, 'inst-1', 'w-0');
    rival.start();
    vi.advanceTimersByTime(10);
    expect(fake.emitted).toEqual([
      {
        event: 'window.background.changed',
        payload: expect.objectContaining({ role: 'secondary', isBackground: false }),
      },
    ]);
  });

  it('tracks the change listener in the session scope (release on dispose)', () => {
    const fake = fakeContext('inst-1');
    attachWindows(fake.ctx);
    expect(fake.tracked).toHaveLength(1);
    const dispose = fake.tracked[0]?.dispose;
    expect(dispose).toBeDefined();
    dispose?.();
    expect(fake.hub.count('neotavern:rev4:windows:inst-1')).toBe(0);
  });

  it('answers with VALIDATION_FAILED when the frame has no installation id', () => {
    const fake = fakeContext(null);
    attachWindows(fake.ctx); // must not throw at attach
    expect(() => invoke(fake.handlers, 'windows.role', {})).toThrowError(
      expect.objectContaining({
        code: KernelErrorCode.VALIDATION_FAILED,
        details: expect.objectContaining({ reason: 'no-installation-id' }),
      }),
    );
    expect(fake.tracked).toHaveLength(0);
  });
});
