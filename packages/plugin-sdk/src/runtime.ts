import type { FrontendPluginApi, PluginDefinition, Registrar, Unregister } from './frontend.js';
import type {
  PluginContextStrategyRegistry,
  PluginProviderRegistry,
  PluginRouter,
  ServerPluginApi,
  ServerPluginDefinition,
} from './backend.js';
import type { PluginEventBus } from './events.js';
import { Disposables } from './cleanup.js';

export type PluginRuntimeState = 'idle' | 'activating' | 'active' | 'deactivating';

function trackedRegistrar<T>(registrar: Registrar<T>, disposables: Disposables): Registrar<T> {
  return {
    register(definition) {
      return disposables.add(registrar.register(definition));
    },
  };
}

function trackedEvents(events: PluginEventBus, disposables: Disposables): PluginEventBus {
  return new Proxy(events, {
    get(target, property, receiver) {
      if (property === 'on') {
        return (event: string, handler: (payload: unknown) => void): Unregister =>
          disposables.add(target.on(event, handler));
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function trackedRouter(router: PluginRouter, disposables: Disposables): PluginRouter {
  return {
    get: (path, handler) => disposables.add(router.get(path, handler)),
    post: (path, handler) => disposables.add(router.post(path, handler)),
    put: (path, handler) => disposables.add(router.put(path, handler)),
    delete: (path, handler) => disposables.add(router.delete(path, handler)),
  };
}

function trackedProviders(
  providers: PluginProviderRegistry,
  disposables: Disposables,
): PluginProviderRegistry {
  return {
    register: (kind, factory, options) =>
      disposables.add(providers.register(kind, factory, options)),
    registerTokenizer: (profile) => disposables.add(providers.registerTokenizer(profile)),
  };
}

function trackedContextStrategies(
  strategies: PluginContextStrategyRegistry,
  disposables: Disposables,
): PluginContextStrategyRegistry {
  return {
    register: (strategy) => disposables.add(strategies.register(strategy)),
  };
}

function scopeFrontendApi(api: FrontendPluginApi, disposables: Disposables): FrontendPluginApi {
  return {
    ...api,
    events: trackedEvents(api.events, disposables),
    i18n: {
      t: api.i18n.t.bind(api.i18n),
      addResources: (language, resources) =>
        disposables.add(api.i18n.addResources(language, resources)),
    },
    ui: {
      messageActions: trackedRegistrar(api.ui.messageActions, disposables),
      toolbarActions: trackedRegistrar(api.ui.toolbarActions, disposables),
      pages: trackedRegistrar(api.ui.pages, disposables),
      settingsPanels: trackedRegistrar(api.ui.settingsPanels, disposables),
      sidebarPanels: trackedRegistrar(api.ui.sidebarPanels, disposables),
      contextMenuItems: trackedRegistrar(api.ui.contextMenuItems, disposables),
      messageRenderers: trackedRegistrar(api.ui.messageRenderers, disposables),
      characterTabs: trackedRegistrar(api.ui.characterTabs, disposables),
      dialogs: trackedRegistrar(api.ui.dialogs, disposables),
      commands: trackedRegistrar(api.ui.commands, disposables),
      hotkeys: trackedRegistrar(api.ui.hotkeys, disposables),
    },
    slash: trackedRegistrar(api.slash, disposables),
    interceptors: trackedRegistrar(api.interceptors, disposables),
    notify: (notification) => disposables.add(api.notify(notification)),
  };
}

function scopeServerApi(api: ServerPluginApi, disposables: Disposables): ServerPluginApi {
  return {
    ...api,
    routes: trackedRouter(api.routes, disposables),
    events: trackedEvents(api.events, disposables),
    providers: trackedProviders(api.providers, disposables),
    contextStrategies: trackedContextStrategies(api.contextStrategies, disposables),
    postProcessors: trackedRegistrar(api.postProcessors, disposables),
  };
}

/**
 * Owns one plugin activation. Registrations are collected by the host even
 * when plugin code ignores the cleanup functions returned by the SDK.
 *
 * @deprecated Reference in-process implementation for alternative hosts and
 * tests. The NeoTavern production host runs frontend plugins in sandboxed
 * iframes and backend plugins in permission-model workers instead; see
 * docs/plugin-sdk/README.md «Frontend».
 */
export class PluginRuntime<TDefinition extends { deactivate?(): void | Promise<void> }> {
  private stateValue: PluginRuntimeState = 'idle';
  private definition: TDefinition | undefined;
  private disposables: Disposables | undefined;

  get state(): PluginRuntimeState {
    return this.stateValue;
  }

  async activate(
    definition: TDefinition,
    activate: (definition: TDefinition, disposables: Disposables) => Promise<void>,
  ): Promise<void> {
    if (this.stateValue !== 'idle') {
      throw new Error(`Plugin runtime cannot activate from state "${this.stateValue}"`);
    }

    const disposables = new Disposables();
    this.stateValue = 'activating';
    this.definition = definition;
    this.disposables = disposables;

    try {
      await activate(definition, disposables);
      this.stateValue = 'active';
    } catch (error) {
      disposables.dispose();
      this.definition = undefined;
      this.disposables = undefined;
      this.stateValue = 'idle';
      throw error;
    }
  }

  async deactivate(): Promise<void> {
    if (this.stateValue === 'idle') return;
    if (this.stateValue !== 'active') {
      throw new Error(`Plugin runtime cannot deactivate from state "${this.stateValue}"`);
    }

    this.stateValue = 'deactivating';
    try {
      await this.definition?.deactivate?.();
    } finally {
      this.disposables?.dispose();
      this.definition = undefined;
      this.disposables = undefined;
      this.stateValue = 'idle';
    }
  }
}

/**
 * Activate a frontend plugin with host-enforced registration cleanup.
 * @deprecated See {@link PluginRuntime} — the production host does not use this.
 */
export async function activateFrontendPlugin(
  runtime: PluginRuntime<PluginDefinition>,
  definition: PluginDefinition,
  api: FrontendPluginApi,
): Promise<void> {
  await runtime.activate(definition, async (plugin, disposables) => {
    await plugin.activate(scopeFrontendApi(api, disposables));
  });
}

/**
 * Activate a backend plugin with host-enforced route/event/provider cleanup.
 * @deprecated See {@link PluginRuntime} — the production host does not use this.
 */
export async function activateServerPlugin(
  runtime: PluginRuntime<ServerPluginDefinition>,
  definition: ServerPluginDefinition,
  api: ServerPluginApi,
): Promise<void> {
  await runtime.activate(definition, async (plugin, disposables) => {
    await plugin.activate(scopeServerApi(api, disposables));
  });
}
