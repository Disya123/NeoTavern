/**
 * Build the external module loaded by a sandboxed frontend-plugin iframe.
 * Plugin callbacks never cross realms; the host receives only metadata and
 * invokes callbacks through postMessage IDs.
 */
import { buildSandboxRev4Client } from './sandboxRev4.js';
export function buildSandboxBootstrap(
  pluginId: string,
  entryUrl: string,
  bundledResources: Readonly<Record<string, Record<string, unknown>>>,
  grantedCapabilities: ReadonlyArray<{
    name: string;
    scope?: unknown;
    revision: number;
    grantedAt: number;
  }> = [],
): string {
  return `
const pluginId = ${JSON.stringify(pluginId)};
const entryUrl = ${JSON.stringify(entryUrl)};
const bundledResources = ${JSON.stringify(bundledResources)};
const grantedCapabilities = ${JSON.stringify(grantedCapabilities)};
const registrations = new Map();
const mounted = new Map();
const dynamicResources = new Map();
const invocationAborts = new Map();
const maxEventSubscriptions = 128;
let sequence = 0;
let language = 'en';
let onCapabilityRevoked = null;
let definition;

function send(message) {
  parent.postMessage({ ...message, pluginId }, '*');
}

function mountContainer(registrationId) {
  const root = document.getElementById('root');
  if (!root) return null;
  for (const child of root.children) {
    if (child instanceof HTMLElement && child.dataset.neotavernRegistration === registrationId) {
      return child;
    }
  }
  return null;
}

function applyLayout(registrationId, layout) {
  const container = mountContainer(registrationId);
  if (!container || !layout || typeof layout !== 'object') return;
  const { left, top, width, height, zIndex } = layout;
  if (![left, top, width, height, zIndex].every(Number.isFinite)) return;
  container.style.position = 'fixed';
  container.style.left = left + 'px';
  container.style.top = top + 'px';
  container.style.width = width + 'px';
  container.style.height = height + 'px';
  container.style.zIndex = String(zIndex);
  container.style.pointerEvents = 'auto';
}

function titleOf(value) {
  try {
    return typeof value === 'function' ? String(value()) : String(value ?? '');
  } catch {
    return '';
  }
}

/** Declarative slot action (ТЗ §53) over the wire: plain object, bounded. */
function serializeSlotAction(value) {
  if (!value || typeof value !== 'object') return undefined;
  const { type, commandId, event } = value;
  if (
    type === 'command' &&
    typeof commandId === 'string' &&
    commandId.length > 0 &&
    commandId.length <= 200
  ) {
    return { type: 'command', commandId };
  }
  if (type === 'event' && typeof event === 'string' && event.length > 0 && event.length <= 200) {
    return { type: 'event', event };
  }
  return undefined;
}

function register(kind, definition) {
  const registrationId = pluginId + ':' + kind + ':' + (++sequence);
  registrations.set(registrationId, { kind, definition });
  const serializable = {
    id: String(definition.id ?? definition.name ?? registrationId),
    title: titleOf(definition.title ?? definition.description ?? definition.name),
    path: typeof definition.path === 'string' ? definition.path : undefined,
    slot: typeof definition.slot === 'string' ? definition.slot : undefined,
    context: typeof definition.context === 'string' ? definition.context : undefined,
    combo: typeof definition.combo === 'string' ? definition.combo : undefined,
    icon: typeof definition.icon === 'string' ? definition.icon : undefined,
    description: typeof definition.description === 'string' ? definition.description : undefined,
    placement: typeof definition.placement === 'string' ? definition.placement : undefined,
    priority: Number.isSafeInteger(definition.priority) ? definition.priority : undefined,
    timeoutMs: Number.isSafeInteger(definition.timeoutMs) ? definition.timeoutMs : undefined,
    order: Number.isSafeInteger(definition.order) ? definition.order : undefined,
    permission: typeof definition.permission === 'string' ? definition.permission : undefined,
    action: serializeSlotAction(definition.action),
  };
  send({ type: 'neotavern.plugin.register', kind, registrationId, definition: serializable });
  return () => {
    const cleanup = mounted.get(registrationId);
    if (typeof cleanup === 'function') {
      try { cleanup(); } catch {}
    }
    mounted.delete(registrationId);
    registrations.delete(registrationId);
    send({ type: 'neotavern.plugin.unregister', registrationId });
  };
}

function cleanupRegistration(registrationId) {
  const cleanup = mounted.get(registrationId);
  if (typeof cleanup === 'function') {
    try { cleanup(); } catch {}
  }
  mounted.delete(registrationId);
  registrations.delete(registrationId);
  send({ type: 'neotavern.plugin.unregister', registrationId });
}

function translate(key) {
  const candidates = [language, language.split('-')[0], 'en'];
  for (const locale of candidates) {
    const resources = dynamicResources.get(locale) ?? bundledResources[locale];
    if (!resources) continue;
    let value = resources;
    for (const segment of String(key).split('.')) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        value = undefined;
        break;
      }
      value = value[segment];
    }
    if (typeof value === 'string') return value;
  }
  return String(key);
}

const registrar = (kind) => ({ register: (definition) => register(kind, definition) });
const eventHandlers = new Map();
const api = {
  pluginId,
  events: {
    on(event, handler) {
      if (!eventHandlers.has(event) && eventHandlers.size >= maxEventSubscriptions) {
        throw new RangeError('Event subscription limit reached');
      }
      const handlers = eventHandlers.get(event) ?? new Set();
      handlers.add(handler);
      eventHandlers.set(event, handlers);
      send({ type: 'neotavern.plugin.event.subscribe', event });
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) {
          eventHandlers.delete(event);
          send({ type: 'neotavern.plugin.event.unsubscribe', event });
        }
      };
    },
    off(event, handler) { eventHandlers.get(event)?.delete(handler); },
    emit(event, payload) { send({ type: 'neotavern.plugin.event.emit', event, payload }); },
    clear() { eventHandlers.clear(); },
  },
  i18n: {
    addResources(language, resources) {
      const registrationId = pluginId + ':i18n:' + (++sequence);
      dynamicResources.set(String(language), resources);
      send({ type: 'neotavern.plugin.i18n.add', registrationId, language, resources });
      return () => {
        dynamicResources.delete(String(language));
        // Dedicated removal message: the generic unregister never reached the
        // host i18next instance, so cleaned-up bundles leaked (PLUG-59 L2).
        send({ type: 'neotavern.plugin.i18n.remove', registrationId, language });
      };
    },
    t(key) { return translate(key); },
  },
  ui: {
    messageActions: registrar('messageActions'),
    toolbarActions: registrar('toolbarActions'),
    pages: registrar('pages'),
    settingsPanels: registrar('settingsPanels'),
    sidebarPanels: registrar('sidebarPanels'),
    contextMenuItems: registrar('contextMenuItems'),
    messageRenderers: registrar('messageRenderers'),
    characterTabs: registrar('characterTabs'),
    dialogs: registrar('dialogs'),
    commands: registrar('commands'),
    hotkeys: registrar('hotkeys'),
    // Declarative semantic UI slots (ТЗ §53): contribute() mirrors the
    // registrar shape; list() is the host's snapshot — the sandbox has no
    // local registry, so it reports an empty view (host renders the truth).
    slots: {
      contribute: (definition) => register('slots', definition),
      list: () => [],
    },
  },
  slash: registrar('slash'),
  interceptors: registrar('interceptors'),
  notify(notification) {
    const registrationId = pluginId + ':notification:' + (++sequence);
    send({ type: 'neotavern.plugin.notify', registrationId, notification });
    // The documented "returns a function to dismiss it early" contract: a
    // dedicated message the host routes to the notification layer (a generic
    // unregister used to be a no-op here — PLUG-55).
    return () => send({ type: 'neotavern.plugin.notification.dismiss', registrationId });
  },
  capabilities: {
    // Granted scoped capabilities (rev4 §B1) as delivered in the kernel
    // handshake; the v2 flat list remains \`grantedPermissions\` on the host.
    list() { return grantedCapabilities.map((grant) => ({ ...grant })); },
    has(name) { return grantedCapabilities.some((grant) => grant.name === name); },
    // rev4 §B2: the host dispatches kernel capability.revoked envelopes here.
    onRevoked(listener) { onCapabilityRevoked = listener; return () => { if (onCapabilityRevoked === listener) onCapabilityRevoked = null; }; },
  },
};

addEventListener('message', async (event) => {
  if (event.source !== parent || !event.data || typeof event.data !== 'object') return;
  const message = event.data;
  if (message.pluginId !== pluginId) return;
  if (message.type === 'neotavern.plugin.language' && typeof message.language === 'string') {
    language = message.language;
  }
  if (message.type === 'neotavern.plugin.tokens' && message.tokens && typeof message.tokens === 'object') {
    // Theme tokens for SDK UI widgets (api.ui.modelMenu): the host snapshots
    // resolved token values and pushes them on theme changes. Widgets read
    // the latest snapshot and re-style live.
    globalThis.__neotavernThemeTokens = message.tokens;
    dispatchEvent(new CustomEvent('neotavern-theme-tokens'));
    return;
  }
  if (message.type === 'neotavern.kernel.bootstrap') {
    // rev4 §A1: single postMessage bootstrap; afterwards the host and the
    // sandbox talk only through the transferred MessagePort.
    const port = event.ports && event.ports[0];
    if (!port || typeof port.postMessage !== 'function') return;
    // rev4 §A1: expose the transferred port to the rev4 kernel client, which
    // boots on this event (it runs before the entry import but the port
    // arrives asynchronously with the bootstrap envelope).
    globalThis.__neotavernKernelPort = port;
    dispatchEvent(new CustomEvent('neotavern-kernel-port-ready'));
    port.addEventListener('message', (portEvent) => {
      const payload = portEvent.data;
      if (!payload || typeof payload !== 'object') return;
      if (payload.type === 'neotavern.kernel.host-handshake') {
        globalThis.__neotavernHostHandshake = payload;
      } else if (payload.type === 'neotavern.capability.revoked') {
        if (typeof onCapabilityRevoked === 'function') {
          try { onCapabilityRevoked(payload.name, payload.revision); } catch {}
        }
        dispatchEvent(new CustomEvent('neotavern-capability-revoked', { detail: { name: payload.name, revision: payload.revision } }));
      }
    });
    port.start();
    port.postMessage({
      type: 'neotavern.kernel.bootstrap',
      nonce: message.nonce,
      protocolVersion: '2.0.0',
      sdkVersion: '1.0.0',
      pluginId,
      installationId: pluginId,
      instanceId: 'rev4:' + String(Math.random()),
      requestedFeatures: [],
    });
    return;
  }
  if (message.type === 'neotavern.capability.revoked' && typeof onCapabilityRevoked === 'function') {
    try { onCapabilityRevoked(message.name, message.revision); } catch {}
    return;
  }
  if (message.type === 'neotavern.plugin.deactivate') {
    try {
      await definition?.deactivate?.();
    } finally {
      for (const registrationId of [...registrations.keys()]) cleanupRegistration(registrationId);
      eventHandlers.clear();
      dynamicResources.clear();
      send({ type: 'neotavern.plugin.deactivated' });
    }
    return;
  }
  if (message.type === 'neotavern.plugin.invoke') {
    const item = registrations.get(message.registrationId);
    const invocationId = typeof message.invocationId === 'string' ? message.invocationId : null;
    // The host never posts its own AbortSignal (not cloneable): the sandbox
    // owns the controller for this invocation and aborts it when the host
    // sends neotavern.plugin.invoke.abort for the same id.
    const controller = invocationId ? new AbortController() : null;
    if (controller) invocationAborts.set(invocationId, controller);
    try {
      const callback =
        item?.kind === 'slash' ? item.definition.run :
        item?.kind === 'interceptors' ? item.definition.intercept :
        item?.kind === 'messageRenderers' ? item.definition.render :
        item?.definition.run;
      const runContext = controller
        ? Object.assign({}, message.context, { signal: controller.signal })
        : message.context;
      const value = typeof callback === 'function' ? await callback(runContext) : undefined;
      send({ type: 'neotavern.plugin.invoke.result', invocationId: message.invocationId, ok: true, value });
    } catch (error) {
      send({
        type: 'neotavern.plugin.invoke.result',
        invocationId: message.invocationId,
        ok: false,
        error: String(error?.message ?? error),
      });
    } finally {
      if (invocationId) invocationAborts.delete(invocationId);
    }
  }
  if (message.type === 'neotavern.plugin.invoke.abort') {
    const controller =
      typeof message.invocationId === 'string'
        ? invocationAborts.get(message.invocationId)
        : undefined;
    if (controller) {
      controller.abort();
      invocationAborts.delete(message.invocationId);
    }
  }
  if (message.type === 'neotavern.plugin.mount') {
    const item = registrations.get(message.registrationId);
    const root = document.getElementById('root');
    if (!item || !root || typeof item.definition.mount !== 'function') return;
    try {
      // One container per registrationId: simultaneous surfaces of one plugin
      // (panel + dialog, sidebar + character tab) must not draw into or wipe
      // each other's DOM (PLUG-54).
      const previousCleanup = mounted.get(message.registrationId);
      if (typeof previousCleanup === 'function') {
        try { previousCleanup(); } catch {}
        mounted.delete(message.registrationId);
      }
      mountContainer(message.registrationId)?.remove();
      const container = document.createElement('div');
      container.dataset.neotavernRegistration = message.registrationId;
      root.append(container);
      applyLayout(message.registrationId, message.layout);
      const cleanup = await item.definition.mount(container, message.context);
      if (typeof cleanup === 'function') mounted.set(message.registrationId, cleanup);
      send({ type: 'neotavern.plugin.mounted', registrationId: message.registrationId });
    } catch (error) {
      send({ type: 'neotavern.plugin.mount.error', registrationId: message.registrationId });
    }
  }
  if (message.type === 'neotavern.plugin.unmount') {
    const cleanup = mounted.get(message.registrationId);
    if (typeof cleanup === 'function') {
      try { cleanup(); } catch {}
    }
    mounted.delete(message.registrationId);
    mountContainer(message.registrationId)?.remove();
  }
  if (message.type === 'neotavern.plugin.layout' && Array.isArray(message.layouts)) {
    for (const layout of message.layouts) {
      if (layout && typeof layout.registrationId === 'string') {
        applyLayout(layout.registrationId, layout);
      }
    }
  }
  if (message.type === 'neotavern.plugin.event') {
    for (const handler of [...(eventHandlers.get(message.event) ?? [])]) {
      try { handler(message.payload); } catch {}
    }
  }
});

// Wait for the kernel port (host sends the bootstrap envelope on iframe
// load). Degrade to v2-only after 2 s instead of stalling plugin load.
await new Promise(function (resolve) {
  if (globalThis.__neotavernKernelPort) { resolve(); return; }
  var done = false;
  function finish() {
    if (done) return;
    done = true;
    removeEventListener('neotavern-kernel-port-ready', finish);
    setTimeout(resolve, 0);
  }
  addEventListener('neotavern-kernel-port-ready', finish);
  setTimeout(finish, 2000);
});

${buildSandboxRev4Client()}

try {
  const loaded = await import(entryUrl);
  definition = loaded.default;
  if (!definition || typeof definition.activate !== 'function') {
    throw new TypeError('Frontend entry must default-export a plugin definition');
  }
  for (const [locale, resources] of Object.entries(bundledResources)) {
    send({
      type: 'neotavern.plugin.i18n.add',
      registrationId: pluginId + ':manifest-i18n:' + locale,
      language: locale,
      resources,
    });
  }
  await definition.activate(api);
  send({ type: 'neotavern.plugin.ready' });
} catch (error) {
  send({ type: 'neotavern.plugin.error', code: 'PLUGIN_LOAD_FAILED' });
}

`;
}
