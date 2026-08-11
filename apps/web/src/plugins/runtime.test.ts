import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { InstalledPlugin } from '@neotavern/contracts';
import { kernel } from '@neotavern/plugin-sdk';
import { createI18n } from '@neotavern/i18n';
import { FrontendPluginRuntime } from './runtime.js';

type PortListener = (event: { data: unknown }) => void;

/** Minimal in-memory port pair: RPC envelopes only, no transferred buffers. */
class TestPort {
  onmessage: PortListener | null = null;
  peer: TestPort | null = null;
  private closeListeners: Array<() => void> = [];
  private closed = false;
  postMessage(value: unknown): void {
    this.peer?.onmessage?.({ data: structuredClone(value) });
  }
  start(): void {}
  addEventListener(type: string, listener: () => void): void {
    if (type === 'close') this.closeListeners.push(listener);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
    // The remote end observes the close too (MessagePort semantics).
    this.peer?.close();
  }
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

function installedPlugin(grantedPermissions: readonly string[] = ['ui.toolbar']): InstalledPlugin {
  return {
    id: 'test.frontend-runtime',
    name: 'Frontend Runtime',
    version: '1.0.0',
    apiVersion: 2,
    enabled: true,
    status: 'active',
    manifest: {},
    requestedPermissions: [...grantedPermissions],
    grantedPermissions: [...grantedPermissions],
    grantedCapabilities: [],
    addedPermissions: [],
    installedAt: 1,
    updatedAt: 1,
    hasFrontend: true,
    hasBackend: false,
    hasStyles: false,
    hasLegacyFrontend: false,
    hasLegacyBackend: false,
    compatibilityLevel: 'native-v2',
    lastErrorCode: null,
  };
}

function sendFromFrame(
  iframe: HTMLIFrameElement,
  data: Record<string, unknown>,
  pluginId = 'test.frontend-runtime',
): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { pluginId, ...data },
      source: iframe.contentWindow,
    }),
  );
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('frontend plugin sandbox runtime', () => {
  it('accepts only granted registrations and performs a deactivate handshake', () => {
    vi.useFakeTimers();
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin()]);
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[data-plugin-id="test.frontend-runtime"]',
    );
    expect(iframe).not.toBeNull();
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    // Every powerful browser feature is denied at the iframe boundary
    // (rev4 §0: plugins never observe devices, clipboard, location, …).
    const allow = iframe?.getAttribute('allow') ?? '';
    expect(allow).toContain("camera 'none'");
    expect(allow).toContain("microphone 'none'");
    expect(allow).toContain("geolocation 'none'");
    expect(allow).toContain("clipboard-read 'none'");
    expect(allow).toContain("fullscreen 'none'");
    expect(allow).toContain("local-fonts 'none'");
    expect(allow).toContain("ch-ua-high-entropy-values 'none'");
    expect(allow).toContain("storage-access 'none'");

    sendFromFrame(iframe!, {
      type: 'neotavern.plugin.register',
      registrationId: 'toolbar-1',
      kind: 'toolbarActions',
      definition: { id: 'hello', title: 'Hello' },
    });
    sendFromFrame(iframe!, {
      type: 'neotavern.plugin.register',
      registrationId: 'page-1',
      kind: 'pages',
      definition: { id: 'page', title: 'Page', path: '/page' },
    });
    expect(runtime.getSnapshot()).toHaveLength(1);
    expect(runtime.getSnapshot()[0]?.kind).toBe('toolbarActions');

    const postMessage = vi.spyOn(iframe!.contentWindow!, 'postMessage');
    runtime.sync([]);
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'neotavern.plugin.deactivate', pluginId: 'test.frontend-runtime' },
      '*',
    );
    expect(iframe).toBeInTheDocument();

    sendFromFrame(iframe!, { type: 'neotavern.plugin.deactivated' });
    expect(iframe).not.toBeInTheDocument();
    expect(runtime.getSnapshot()).toEqual([]);
  });

  it('registers translation resources in an isolated plugin namespace', async () => {
    const runtime = new FrontendPluginRuntime();
    const i18n = await createI18n({ language: 'en' });
    runtime.configureI18n(i18n);
    runtime.sync([installedPlugin()]);
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[data-plugin-id="test.frontend-runtime"]',
    );

    sendFromFrame(iframe!, {
      type: 'neotavern.plugin.i18n.add',
      language: 'en',
      resources: { action: 'Plugin action' },
    });

    expect(i18n.t('action', { ns: 'plugin.test.frontend-runtime' })).toBe('Plugin action');
    runtime.clear();
  });

  it('accepts renderer, character-tab and dialog registrations only with their capabilities', async () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin(['chat.read', 'characters.read', 'ui.shell'])]);
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[data-plugin-id="test.frontend-runtime"]',
    );
    const postMessage = vi.spyOn(iframe!.contentWindow!, 'postMessage');

    for (const [registrationId, kind] of [
      ['renderer-1', 'messageRenderers'],
      ['character-tab-1', 'characterTabs'],
      ['dialog-1', 'dialogs'],
    ] as const) {
      sendFromFrame(iframe!, {
        type: 'neotavern.plugin.register',
        registrationId,
        kind,
        definition: { id: registrationId, title: registrationId },
      });
    }

    expect(runtime.getSnapshot().map((registration) => registration.kind)).toEqual([
      'messageRenderers',
      'characterTabs',
      'dialogs',
    ]);
    const characterTab = runtime
      .getSnapshot()
      .find((registration) => registration.kind === 'characterTabs');
    const container = document.createElement('div');
    document.body.append(container);
    const unmount = runtime.mountPage(characterTab!, container, {
      characterId: 'character-1',
    });
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 320, 120));
    await nextAnimationFrame();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'neotavern.plugin.mount',
        registrationId: 'character-tab-1',
        context: { characterId: 'character-1' },
      }),
      '*',
    );
    unmount();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'neotavern.plugin.unmount',
        registrationId: 'character-tab-1',
      }),
      '*',
    );
    runtime.clear();
  });

  it('keeps simultaneous roots in one clipped full-screen iframe and cleans them selectively', async () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin(['characters.read', 'ui.shell'])]);
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[data-plugin-id="test.frontend-runtime"]',
    );
    const postMessage = vi.spyOn(iframe!.contentWindow!, 'postMessage');
    sendFromFrame(iframe!, {
      type: 'neotavern.plugin.register',
      registrationId: 'tab-1',
      kind: 'characterTabs',
      definition: { id: 'tab', title: 'Tab' },
    });
    sendFromFrame(iframe!, {
      type: 'neotavern.plugin.register',
      registrationId: 'dialog-1',
      kind: 'dialogs',
      definition: { id: 'dialog', title: 'Dialog' },
    });
    const tab = runtime.getSnapshot().find((entry) => entry.registrationId === 'tab-1');
    const dialog = runtime.getSnapshot().find((entry) => entry.registrationId === 'dialog-1');
    const tabHost = document.body.appendChild(document.createElement('div'));
    const dialogHost = document.body.appendChild(document.createElement('div'));
    vi.spyOn(tabHost, 'getBoundingClientRect').mockReturnValue(rect(10, 20, 320, 120));
    vi.spyOn(dialogHost, 'getBoundingClientRect').mockReturnValue(rect(40, 50, 420, 240));

    const unmountTab = runtime.mountPage(tab!, tabHost, { characterId: 'character-1' });
    const unmountDialog = runtime.mountPage(dialog!, dialogHost);
    await nextAnimationFrame();

    const firstLayout = latestLayout(postMessage);
    expect(firstLayout.layouts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ registrationId: 'tab-1', left: 10, top: 20, zIndex: 1 }),
        expect.objectContaining({ registrationId: 'dialog-1', left: 40, top: 50, zIndex: 2 }),
      ]),
    );
    const clip = document.querySelector('clipPath');
    expect(clip?.querySelectorAll('rect')).toHaveLength(2);
    expect(iframe?.style.clipPath).toMatch(/^url\(#neotavern-plugin-clip-/);

    unmountTab();
    await nextAnimationFrame();
    expect(latestLayout(postMessage).layouts).toEqual([
      expect.objectContaining({ registrationId: 'dialog-1', zIndex: 2 }),
    ]);
    // The app-owned mount target survives a selective sandbox unmount.
    expect(tabHost).toBeInTheDocument();
    unmountDialog();
    runtime.clear();
  });

  it('runs permission-checked prompt interceptors and forwards subscribed app events', async () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin(['prompt.modify'])]);
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[data-plugin-id="test.frontend-runtime"]',
    );
    const postMessage = vi.spyOn(iframe!.contentWindow!, 'postMessage');
    sendFromFrame(iframe!, {
      type: 'neotavern.plugin.register',
      registrationId: 'interceptor-1',
      kind: 'interceptors',
      definition: { id: 'rewrite', title: 'Rewrite', priority: 20, timeoutMs: 500 },
    });

    const pending = runtime.runPromptInterceptors({
      chatId: 'chat-1',
      messages: [{ id: 'message-1', role: 'user', content: 'before' }],
      meta: {},
    });
    const invocation = postMessage.mock.calls
      .map(([message]) => message)
      .find(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'neotavern.plugin.invoke',
      ) as { invocationId: string };
    sendFromFrame(iframe!, {
      type: 'neotavern.plugin.invoke.result',
      invocationId: invocation.invocationId,
      ok: true,
      value: {
        chatId: 'chat-1',
        messages: [{ id: 'message-1', role: 'user', content: 'after' }],
        meta: { rewritten: true },
      },
    });
    await expect(pending).resolves.toMatchObject({
      messages: [{ content: 'after' }],
      meta: { rewritten: true },
    });

    // Chat-content events require `chat.read`: this plugin only has
    // prompt.modify, so the subscription is refused and nothing is delivered.
    sendFromFrame(iframe!, {
      type: 'neotavern.plugin.event.subscribe',
      event: 'generation.finished',
    });
    runtime.emitEvent('generation.finished', { chatId: 'chat-1', text: 'done' });
    const eventDeliveries = postMessage.mock.calls.filter(
      ([message]) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'neotavern.plugin.event',
    );
    expect(eventDeliveries).toHaveLength(0);
    runtime.clear();
  });

  it('delivers chat-content events only to plugins granted chat.read', () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin(['chat.read'])]);
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[data-plugin-id="test.frontend-runtime"]',
    );
    const postMessage = vi.spyOn(iframe!.contentWindow!, 'postMessage');

    sendFromFrame(iframe!, {
      type: 'neotavern.plugin.event.subscribe',
      event: 'generation.finished',
    });
    runtime.emitEvent('generation.finished', { chatId: 'chat-1', text: 'done' });
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'neotavern.plugin.event',
        pluginId: 'test.frontend-runtime',
        event: 'generation.finished',
        payload: { chatId: 'chat-1', text: 'done' },
      },
      '*',
    );
    runtime.clear();
  });

  it('drops subscriptions and registrations when the sandbox document is replaced', () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin(['chat.read', 'ui.toolbar'])]);
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[data-plugin-id="test.frontend-runtime"]',
    );
    sendFromFrame(iframe!, {
      type: 'neotavern.plugin.register',
      registrationId: 'toolbar-1',
      kind: 'toolbarActions',
      definition: { id: 'hello', title: 'Hello' },
    });
    sendFromFrame(iframe!, {
      type: 'neotavern.plugin.event.subscribe',
      event: 'generation.finished',
    });
    expect(runtime.getSnapshot()).toHaveLength(1);

    // Initial load completes the sandbox bootstrap; a second load means the
    // document was navigated away or reloaded — session state must not carry
    // over (a navigated page keeps the same contentWindow, so the postMessage
    // source check alone would keep passing).
    iframe!.dispatchEvent(new Event('load'));
    const postMessage = vi.spyOn(iframe!.contentWindow!, 'postMessage');
    iframe!.dispatchEvent(new Event('load'));

    runtime.emitEvent('generation.finished', { chatId: 'chat-1', text: 'done' });
    expect(postMessage).not.toHaveBeenCalled();
    expect(runtime.getSnapshot()).toHaveLength(0);
    runtime.clear();
  });

  it('rejects invoke results that do not belong to the sending plugin', async () => {
    const runtime = new FrontendPluginRuntime();
    const victim: InstalledPlugin = {
      ...installedPlugin(['ui.toolbar']),
      id: 'test.victim',
      name: 'Victim',
    };
    runtime.sync([installedPlugin(['ui.toolbar']), victim]);
    const attackerFrame = document.querySelector<HTMLIFrameElement>(
      'iframe[data-plugin-id="test.frontend-runtime"]',
    );
    const victimFrame = document.querySelector<HTMLIFrameElement>(
      'iframe[data-plugin-id="test.victim"]',
    );
    const victimPostMessage = vi.spyOn(victimFrame!.contentWindow!, 'postMessage');

    sendFromFrame(
      victimFrame!,
      {
        type: 'neotavern.plugin.register',
        registrationId: 'victim-action',
        kind: 'toolbarActions',
        definition: { id: 'victim', title: 'Victim action' },
      },
      'test.victim',
    );
    const registration = runtime
      .getSnapshot()
      .find((entry) => entry.registrationId === 'victim-action');
    const pending = runtime.invoke(registration!, {});
    const invocation = victimPostMessage.mock.calls
      .map(([message]) => message)
      .find(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'neotavern.plugin.invoke',
      ) as { invocationId: string };

    // The attacker knows its own id and can observe/guess ids of the form
    // "test.victim:<token>"; its result must be ignored because it does not
    // come from the victim's frame.
    sendFromFrame(attackerFrame!, {
      type: 'neotavern.plugin.invoke.result',
      invocationId: invocation.invocationId,
      ok: true,
      value: { spoofed: true },
    });
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'neotavern.plugin.invoke.result',
          pluginId: 'test.victim',
          invocationId: invocation.invocationId,
          ok: true,
          value: { spoofed: false },
        },
        source: victimFrame!.contentWindow,
      }),
    );
    await expect(pending).resolves.toMatchObject({ spoofed: false });
    runtime.clear();
  });
});

describe('capability consent round-trip (rev4 §B2)', () => {
  it('resolves immediately when the capability is already granted', async () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin()]);
    const frame = runtime.kernelGetFrame('test.frontend-runtime')!;
    frame.plugin.grantedCapabilities.push({
      name: 'camera.request',
      revision: 1,
      grantedAt: 1,
    });
    await expect(
      runtime.requestCapabilityConsent(frame, { name: 'camera.request' }),
    ).resolves.toMatchObject({ name: 'camera.request' });
    expect(runtime.consentGetSnapshot()).toEqual([]);
    runtime.clear();
  });

  it('queues one consent per plugin and rejects concurrent requests', async () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin()]);
    const frame = runtime.kernelGetFrame('test.frontend-runtime')!;
    const first = runtime.requestCapabilityConsent(frame, { name: 'camera.request' });
    expect(runtime.consentGetSnapshot()).toHaveLength(1);
    expect(runtime.consentGetSnapshot()[0]).toMatchObject({
      pluginId: 'test.frontend-runtime',
      request: { name: 'camera.request' },
    });
    await expect(
      runtime.requestCapabilityConsent(frame, { name: 'network.domains' }),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
      details: { reason: 'consent-pending' },
    });
    runtime.resolveConsent('test.frontend-runtime', false);
    await expect(first).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
      details: { reason: 'user-denied' },
    });
    expect(runtime.consentGetSnapshot()).toEqual([]);
    runtime.clear();
  });

  it('persists an allowed grant through the server and publishes it locally', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        grant: { name: 'camera.request', revision: 3, grantedAt: 42 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin()]);
    const frame = runtime.kernelGetFrame('test.frontend-runtime')!;
    const pending = runtime.requestCapabilityConsent(frame, { name: 'camera.request' });
    runtime.resolveConsent('test.frontend-runtime', true);
    await expect(pending).resolves.toMatchObject({ name: 'camera.request', revision: 3 });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/plugins/test.frontend-runtime/capabilities',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'camera.request' }),
      }),
    );
    expect(runtime.kernelHasCapability(frame, 'camera.request')).toBe(true);
    expect(runtime.consentGetSnapshot()).toEqual([]);
    runtime.clear();
    vi.unstubAllGlobals();
  });

  it('denies the request when the user declines', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin()]);
    const frame = runtime.kernelGetFrame('test.frontend-runtime')!;
    const pending = runtime.requestCapabilityConsent(frame, { name: 'camera.request' });
    runtime.resolveConsent('test.frontend-runtime', false);
    await expect(pending).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
      details: { reason: 'user-denied' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    runtime.clear();
    vi.unstubAllGlobals();
  });

  it('times out unanswered consents', async () => {
    vi.useFakeTimers();
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin()]);
    const frame = runtime.kernelGetFrame('test.frontend-runtime')!;
    const pending = runtime.requestCapabilityConsent(frame, { name: 'camera.request' });
    expect(runtime.consentGetSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    await expect(pending).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
      details: { reason: 'consent-timeout' },
    });
    expect(runtime.consentGetSnapshot()).toEqual([]);
    runtime.clear();
  });

  it('fails pending consents when the plugin frame is removed', async () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin()]);
    const frame = runtime.kernelGetFrame('test.frontend-runtime')!;
    const pending = runtime.requestCapabilityConsent(frame, { name: 'camera.request' });
    runtime.clear();
    await expect(pending).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
      details: { reason: 'frame-gone' },
    });
    expect(runtime.consentGetSnapshot()).toEqual([]);
  });

  it('drops revoked grants from the live frame grant list', async () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      onmessage: ((event: { data: string }) => void) | null = null;
      readyState = 0;
      constructor(public url: string) {
        FakeEventSource.instances.push(this);
      }
      close(): void {
        this.readyState = 2;
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin()]);
    const frame = runtime.kernelGetFrame('test.frontend-runtime')!;
    frame.plugin.grantedCapabilities.push({
      name: 'camera.request',
      revision: 1,
      grantedAt: 1,
    });
    expect(runtime.kernelHasCapability(frame, 'camera.request')).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.instances[0]!.onmessage!({
      data: JSON.stringify({
        type: 'event',
        event: 'plugin.capability.revoked',
        payload: { pluginId: 'test.frontend-runtime', name: 'camera.request', revision: 2 },
      }),
    });
    expect(runtime.kernelHasCapability(frame, 'camera.request')).toBe(false);
    expect(frame.plugin.grantedCapabilities).toEqual([]);
    runtime.clear();
    vi.unstubAllGlobals();
  });

  it('drives the host overlay chrome while a full overlay is live (rev4 §G7)', async () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin()]);
    const frame = runtime.kernelGetFrame('test.frontend-runtime');
    expect(frame).toBeDefined();

    expect(runtime.getOverlayChrome()).toMatchObject({ active: false });

    // A 'full' overlay activates the chrome with the plugin identity.
    const fullContainer = document.createElement('div');
    runtime.kernelMountOverlay(frame!, 'full-1', fullContainer, 'full');
    runtime.kernelAddRegistration({
      pluginId: 'test.frontend-runtime',
      pluginName: 'Frontend Runtime',
      registrationId: 'full-1',
      kind: 'overlays',
      definition: { id: 'full-1', title: 'Full' },
    });
    await nextAnimationFrame();
    expect(runtime.getOverlayChrome()).toEqual({
      active: true,
      pluginId: 'test.frontend-runtime',
      pluginName: 'Frontend Runtime',
      registrationId: 'full-1',
      frameId: frame!.frameId,
    });

    // A non-full overlay in the same frame does not clear the chrome.
    const proxyContainer = document.createElement('div');
    runtime.kernelMountOverlay(frame!, 'proxy-1', proxyContainer, 'proxy');
    await nextAnimationFrame();
    expect(runtime.getOverlayChrome().registrationId).toBe('full-1');

    // rev4 §G7: while 'full' is live the proxy hit layer yields so the
    // full iframe receives pointer events; it returns after the close.
    expect(frame!.hitLayer?.style.display).toBe('none');
    runtime.closeFullOverlay();
    await nextAnimationFrame();
    expect(frame!.hitLayer?.style.display).toBe('');

    // Host-controlled close removes the overlay and the chrome with it.
    runtime.closeFullOverlay();
    expect(frame!.overlays.has('full-1')).toBe(false);
    expect(runtime.getOverlayChrome()).toMatchObject({ active: false });

    // Closing with no live full overlay is a no-op.
    runtime.closeFullOverlay();
    expect(runtime.getOverlayChrome()).toMatchObject({ active: false });

    runtime.clear();
  });

  it('clears the chrome when its full overlay is disposed or the frame is torn down (rev4 §G7)', async () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin()]);
    const frame = runtime.kernelGetFrame('test.frontend-runtime');
    expect(frame).toBeDefined();

    const container = document.createElement('div');
    runtime.kernelMountOverlay(frame!, 'full-2', container, 'full');
    runtime.kernelAddRegistration({
      pluginId: 'test.frontend-runtime',
      pluginName: 'Frontend Runtime',
      registrationId: 'full-2',
      kind: 'overlays',
      definition: { id: 'full-2', title: 'Full' },
    });
    await nextAnimationFrame();
    expect(runtime.getOverlayChrome().active).toBe(true);

    // Plugin-side dispose (ui.overlay.dispose) drops the chrome too (via the
    // layout flush that follows the removal).
    runtime.kernelRemoveRegistration('full-2');
    await nextAnimationFrame();
    expect(runtime.getOverlayChrome()).toMatchObject({ active: false });

    // A full overlay in another plugin's frame never steals the chrome when
    // this frame relayouts without one.
    const second = document.createElement('div');
    runtime.kernelMountOverlay(frame!, 'full-3', second, 'full');
    await nextAnimationFrame();
    expect(runtime.getOverlayChrome().active).toBe(true);

    // Teardown (deactivate/uninstall) clears the chrome with the frame.
    vi.useFakeTimers();
    runtime.sync([]);
    vi.advanceTimersByTime(600);
    expect(runtime.getOverlayChrome()).toMatchObject({ active: false });
    vi.useRealTimers();
    runtime.clear();
  });

  it('closes the chrome even without a host registration (defensive path)', async () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin()]);
    const frame = runtime.kernelGetFrame('test.frontend-runtime');
    expect(frame).toBeDefined();

    const container = document.createElement('div');
    runtime.kernelMountOverlay(frame!, 'full-orphan', container, 'full');
    await nextAnimationFrame();
    expect(runtime.getOverlayChrome().active).toBe(true);
    runtime.closeFullOverlay();
    expect(frame!.overlays.has('full-orphan')).toBe(false);
    expect(runtime.getOverlayChrome()).toMatchObject({ active: false });

    runtime.clear();
  });
});

describe('plugin lifecycle hooks (rev4 §J2)', () => {
  it('delivers a hook to the live sandbox session and reports handling', async () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin()]);
    const frame = runtime.kernelGetFrame('test.frontend-runtime');
    expect(frame).toBeDefined();
    const { host, plugin } = createSessionPair();
    frame!.session = host;

    const received: Array<{ hook?: unknown; detail?: unknown }> = [];
    plugin.handle('lifecycle.hook', (request) => {
      const params = request.params as { hook: unknown; detail?: unknown };
      received.push(params);
      return { handled: true };
    });

    await expect(runtime.kernelLifecycleHook('test.frontend-runtime', 'suspend')).resolves.toEqual({
      handled: true,
    });
    await expect(
      runtime.kernelLifecycleHook('test.frontend-runtime', 'afterUpdate', {
        version: '2.0.0',
        previousVersion: '1.0.0',
      }),
    ).resolves.toEqual({ handled: true });

    expect(received).toEqual([
      { hook: 'suspend' },
      { hook: 'afterUpdate', detail: { version: '2.0.0', previousVersion: '1.0.0' } },
    ]);
    runtime.clear();
  });

  it('degrades to handled:false for an unhandled hook and a dead frame', async () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin()]);
    const frame = runtime.kernelGetFrame('test.frontend-runtime');
    expect(frame).toBeDefined();
    // No session yet: the hook resolves as a no-op, never rejecting.
    await expect(runtime.kernelLifecycleHook('test.frontend-runtime', 'rollback')).resolves.toEqual(
      { handled: false },
    );

    const { host } = createSessionPair();
    frame!.session = host;
    // The sandbox has no lifecycle.hook handler (e.g. a v2-only plugin).
    await expect(
      runtime.kernelLifecycleHook('test.frontend-runtime', 'uninstall'),
    ).resolves.toEqual({ handled: false });

    // Unknown plugin: also a clean no-op.
    await expect(runtime.kernelLifecycleHook('no.such-plugin', 'suspend')).resolves.toEqual({
      handled: false,
    });
    runtime.clear();
  });

  it('suspends and resumes every live frame', async () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin(), { ...installedPlugin(), id: 'test.second', name: 'Second' }]);
    const first = runtime.kernelGetFrame('test.frontend-runtime');
    const second = runtime.kernelGetFrame('test.second');
    const { host: host1, plugin: plugin1 } = createSessionPair();
    const { host: host2, plugin: plugin2 } = createSessionPair();
    first!.session = host1;
    second!.session = host2;

    const suspended: string[] = [];
    const resumed: string[] = [];
    plugin1.handle('lifecycle.hook', (request) => {
      const hook = (request.params as { hook?: unknown })?.hook;
      if (hook === 'suspend') suspended.push('first');
      if (hook === 'resume') resumed.push('first');
      return { handled: true };
    });
    plugin2.handle('lifecycle.hook', (request) => {
      const hook = (request.params as { hook?: unknown })?.hook;
      if (hook === 'suspend') suspended.push('second');
      if (hook === 'resume') resumed.push('second');
      return { handled: true };
    });

    runtime.kernelSuspendAll();
    runtime.kernelResumeAll();
    await vi.waitFor(() => expect(suspended).toEqual(['first', 'second']));
    await vi.waitFor(() => expect(resumed).toEqual(['first', 'second']));
    runtime.clear();
  });

  it('suspends on tab hide and resumes on visibility', async () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin()]);
    const frame = runtime.kernelGetFrame('test.frontend-runtime');
    expect(frame).toBeDefined();
    const { host, plugin } = createSessionPair();
    frame!.session = host;

    const hooks: string[] = [];
    plugin.handle('lifecycle.hook', (request) => {
      const hook = (request.params as { hook?: unknown })?.hook;
      if (typeof hook === 'string') hooks.push(hook);
      return { handled: true };
    });

    const original = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(hooks).toEqual(['suspend']));

    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(hooks).toEqual(['suspend', 'resume']));

    Object.defineProperty(document, 'visibilityState', {
      value: original,
      configurable: true,
    });
    runtime.clear();
  });
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height } as DOMRect;
}

async function nextAnimationFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function latestLayout(postMessage: MockInstance): { layouts: unknown[] } {
  const message = postMessage.mock.calls
    .map((call) => call[0])
    .filter(
      (value): value is { type: string; layouts: unknown[] } =>
        typeof value === 'object' &&
        value !== null &&
        'type' in value &&
        value.type === 'neotavern.plugin.layout' &&
        'layouts' in value &&
        Array.isArray(value.layouts),
    )
    .at(-1);
  if (!message) throw new Error('Expected a sandbox layout message');
  return message;
}

describe('crash isolation (rev4 §M3)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function hungRuntime(
    overrides?: Partial<FrontendPluginRuntime['crashPolicy']>,
  ): FrontendPluginRuntime {
    const runtime = new FrontendPluginRuntime();
    runtime.crashPolicy.pingIntervalMs = 100;
    runtime.crashPolicy.pingDeadlineMs = 50;
    runtime.crashPolicy.windowMs = 10_000;
    if (overrides) Object.assign(runtime.crashPolicy, overrides);
    return runtime;
  }

  /** Attach a session whose sandbox never answers the liveness probe. */
  function attachHungSession(
    runtime: FrontendPluginRuntime,
    pluginId: string,
  ): { host: kernel.KernelSession } {
    const frame = runtime.kernelGetFrame(pluginId);
    expect(frame).toBeDefined();
    const pair = createSessionPair();
    frame!.session = pair.host;
    pair.plugin.handle('kernel.ping', () => new Promise(() => {}));
    return { host: pair.host };
  }

  it('restarts a frame whose sandbox stops answering heartbeats', async () => {
    vi.useFakeTimers();
    const runtime = hungRuntime();
    runtime.sync([installedPlugin()]);
    const first = runtime.kernelGetFrame('test.frontend-runtime');
    expect(first).toBeDefined();
    const { host } = attachHungSession(runtime, 'test.frontend-runtime');
    const crashEvents: Array<Record<string, unknown>> = [];
    const onCrash = (event: Event): void => {
      crashEvents.push((event as CustomEvent).detail as Record<string, unknown>);
    };
    globalThis.addEventListener('neotavern-plugin-crash', onCrash);
    try {
      await vi.advanceTimersByTimeAsync(100 + 50 + 20);
      const restarted = runtime.kernelGetFrame('test.frontend-runtime');
      expect(restarted).toBeDefined();
      expect(restarted!.frameId).not.toBe(first!.frameId);
      // The crashed session is disposed: streams, workers, jobs and pending
      // invokes close with it.
      expect(host.isDisposed).toBe(true);
      expect(crashEvents).toHaveLength(1);
      expect(crashEvents[0]).toMatchObject({
        pluginId: 'test.frontend-runtime',
        disabled: false,
        restartBudgetLeft: 2,
      });
    } finally {
      globalThis.removeEventListener('neotavern-plugin-crash', onCrash);
      runtime.clear();
    }
  });

  it('keeps a frame alive while the sandbox answers pings', async () => {
    vi.useFakeTimers();
    const runtime = hungRuntime();
    runtime.sync([installedPlugin()]);
    const first = runtime.kernelGetFrame('test.frontend-runtime');
    expect(first).toBeDefined();
    const pair = createSessionPair();
    first!.session = pair.host;
    pair.plugin.handle('kernel.ping', () => ({ ok: true }));
    await vi.advanceTimersByTimeAsync(100 + 50 + 20);
    expect(runtime.kernelGetFrame('test.frontend-runtime')?.frameId).toBe(first!.frameId);
    runtime.clear();
  });

  it('disables a crash-looping plugin and calls the disable endpoint', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const runtime = hungRuntime({ maxRestarts: 2 });
    runtime.sync([installedPlugin()]);
    const crashEvents: Array<Record<string, unknown>> = [];
    const onCrash = (event: Event): void => {
      crashEvents.push((event as CustomEvent).detail as Record<string, unknown>);
    };
    globalThis.addEventListener('neotavern-plugin-crash', onCrash);
    try {
      for (let cycle = 0; cycle < 3; cycle += 1) {
        attachHungSession(runtime, 'test.frontend-runtime');
        await vi.advanceTimersByTimeAsync(100 + 50 + 20);
      }
      expect(runtime.kernelGetFrame('test.frontend-runtime')).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/plugins/test.frontend-runtime/disable'),
        expect.objectContaining({ method: 'POST' }),
      );
      expect(crashEvents).toHaveLength(3);
      expect(crashEvents[2]).toMatchObject({ disabled: true, restartBudgetLeft: 0 });
    } finally {
      globalThis.removeEventListener('neotavern-plugin-crash', onCrash);
      runtime.clear();
    }
  });

  it('restarts a frame whose sandbox session port closes (process death)', async () => {
    const runtime = new FrontendPluginRuntime();
    runtime.sync([installedPlugin()]);
    const first = runtime.kernelGetFrame('test.frontend-runtime');
    expect(first).toBeDefined();
    const pair = createSessionPair();
    first!.session = pair.host;
    runtime.kernelAttachCrashWatch(first!);
    const crashEvents: Array<Record<string, unknown>> = [];
    const onCrash = (event: Event): void => {
      crashEvents.push((event as CustomEvent).detail as Record<string, unknown>);
    };
    globalThis.addEventListener('neotavern-plugin-crash', onCrash);
    try {
      // The plugin side dies: its session disposes and the port closes, so
      // the host's session observes the peer close — the fast crash signal.
      pair.plugin.dispose();
      await Promise.resolve();
      const restarted = runtime.kernelGetFrame('test.frontend-runtime');
      expect(restarted).toBeDefined();
      expect(restarted!.frameId).not.toBe(first!.frameId);
      expect(pair.host.isDisposed).toBe(true);
      expect(crashEvents).toHaveLength(1);
      expect(crashEvents[0]).toMatchObject({
        pluginId: 'test.frontend-runtime',
        disabled: false,
        restartBudgetLeft: 2,
      });
    } finally {
      globalThis.removeEventListener('neotavern-plugin-crash', onCrash);
      runtime.clear();
    }
  });

  it('exposes crash accounting in the diagnostics snapshot', async () => {
    vi.useFakeTimers();
    const runtime = hungRuntime();
    runtime.sync([installedPlugin()]);
    attachHungSession(runtime, 'test.frontend-runtime');
    await vi.advanceTimersByTimeAsync(100 + 50 + 20);
    const restarted = runtime.kernelGetFrame('test.frontend-runtime');
    expect(restarted).toBeDefined();
    const snapshot = runtime.kernelDiagnosticsSnapshot(restarted!);
    expect(snapshot.crash).toEqual({
      count: 1,
      lastAt: expect.any(Number),
      restartBudgetLeft: 2,
    });
    runtime.clear();
  });

  it('does not crash-handle a frame that is already being removed', async () => {
    vi.useFakeTimers();
    const runtime = hungRuntime();
    runtime.sync([installedPlugin()]);
    const frame = runtime.kernelGetFrame('test.frontend-runtime');
    expect(frame).toBeDefined();
    const pair = createSessionPair();
    frame!.session = pair.host;
    pair.plugin.handle('kernel.ping', () => new Promise(() => {}));
    const crashEvents: Array<Record<string, unknown>> = [];
    const onCrash = (event: Event): void => {
      crashEvents.push((event as CustomEvent).detail as Record<string, unknown>);
    };
    globalThis.addEventListener('neotavern-plugin-crash', onCrash);
    try {
      // Graceful disable starts the removal; the probe fires inside the
      // 500 ms grace and must neither restart nor crash-loop the frame.
      runtime.sync([]);
      await vi.advanceTimersByTimeAsync(100 + 50 + 20);
      expect(runtime.kernelGetFrame('test.frontend-runtime')).toBeDefined();
      expect(crashEvents).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(600);
      expect(runtime.kernelGetFrame('test.frontend-runtime')).toBeUndefined();
      expect(crashEvents).toHaveLength(0);
    } finally {
      globalThis.removeEventListener('neotavern-plugin-crash', onCrash);
      runtime.clear();
    }
  });
});
