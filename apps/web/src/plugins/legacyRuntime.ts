/**
 * Trusted main-window loader for explicitly consented SillyTavern legacy UI
 * code.
 *
 * ТЗ §10/§87: no arbitrary third-party JS in the main WebView. Legacy
 * frontend entries inject a plain `<script>` into the main document, so
 * loading requires BOTH the per-plugin `legacy.trusted` consent AND the
 * app-level `extensions.legacyFrontend` opt-in (default off). The
 * `window.SillyTavern` globals stay installed — they are a documented legacy
 * contract (AGENTS.md §18) and inert without an injected entry.
 */
import type { i18n } from 'i18next';
import type { InstalledPlugin } from '@neotavern/contracts';

interface LoadedLegacyPlugin {
  plugin: InstalledPlugin;
  script: HTMLScriptElement;
  localeLanguages: string[];
}

/**
 * Legacy frontend gate decision (ТЗ §10/§87): inject only when the admin
 * consented `legacy.trusted` for the plugin AND the app-level
 * `extensions.legacyFrontend` setting is enabled.
 */
export function shouldLoadLegacyFrontend(input: {
  legacyTrusted: boolean;
  appGateEnabled: boolean;
}): boolean {
  return input.legacyTrusted && input.appGateEnabled;
}

/**
 * Defensive read of the app-level `extensions.legacyFrontend` setting from
 * the settings payload. The key is registered server-side and is not part of
 * the frozen wire schema, so unknown shapes safely read as `false`.
 */
export function readLegacyFrontendSetting(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return false;
  const extensions = (settings as Record<string, unknown>)['extensions'];
  if (typeof extensions !== 'object' || extensions === null) return false;
  return (extensions as Record<string, unknown>)['legacyFrontend'] === true;
}

class LegacyFrontendRuntime {
  private readonly loaded = new Map<string, LoadedLegacyPlugin>();
  private i18n: i18n | null = null;
  private appGateEnabled = false;
  private gateWarningLogged = false;

  configureI18n(instance: i18n): void {
    this.i18n = instance;
  }

  /**
   * App-level opt-in for legacy frontend injection (`extensions.legacyFrontend`,
   * default off). Turning the gate off unloads every injected legacy entry
   * immediately; the `window.SillyTavern` globals remain installed.
   */
  setAppGateEnabled(enabled: boolean): void {
    if (enabled === this.appGateEnabled) return;
    this.appGateEnabled = enabled;
    if (!enabled) this.clear();
  }

  sync(plugins: readonly InstalledPlugin[]): void {
    const wanted = new Map(
      plugins
        .filter((plugin) => plugin.enabled && plugin.hasLegacyFrontend)
        .map((plugin) => [plugin.id, plugin]),
    );
    for (const [pluginId, loaded] of this.loaded) {
      const next = wanted.get(pluginId);
      if (!next || next.version !== loaded.plugin.version) this.remove(pluginId);
    }
    for (const plugin of wanted.values()) {
      if (!this.loaded.has(plugin.id)) this.load(plugin);
    }
  }

  clear(): void {
    for (const pluginId of [...this.loaded.keys()]) this.remove(pluginId);
  }

  private load(plugin: InstalledPlugin): void {
    const legacyTrusted = plugin.grantedPermissions.includes('legacy.trusted');
    if (!shouldLoadLegacyFrontend({ legacyTrusted, appGateEnabled: this.appGateEnabled })) {
      if (legacyTrusted) this.warnGateOnce();
      return;
    }
    const script = document.createElement('script');
    script.type = 'module';
    // Cache-buster on the module URL: the ESM module map is keyed by URL, so
    // without it an updated legacy plugin would never re-execute until a full
    // page reload (ТЗ §8 — lifecycle hooks must run for the new version).
    const cacheBuster = `${encodeURIComponent(plugin.version)}-${plugin.installedAt}`;
    script.src = `/api/v2/plugins/${encodeURIComponent(plugin.id)}/legacy.js?v=${cacheBuster}`;
    script.dataset.component = 'legacy-plugin-entry';
    script.dataset.pluginId = plugin.id;
    document.head.append(script);
    this.loaded.set(plugin.id, { plugin, script, localeLanguages: [] });
    this.loadI18nResources(plugin);
  }

  /** One warning per session when the app-level gate hides trusted entries. */
  private warnGateOnce(): void {
    if (this.gateWarningLogged) return;
    this.gateWarningLogged = true;
    console.warn(
      '[legacy] Legacy frontend injection is off: trusted legacy plugins are skipped until the app-level "extensions.legacyFrontend" setting is enabled.',
    );
  }

  /** Manifest i18n resources register under the `legacy.<id>` namespace. */
  private loadI18nResources(plugin: InstalledPlugin): void {
    const resources = plugin.manifest['i18n'];
    if (!resources || typeof resources !== 'object' || Array.isArray(resources)) return;
    const loaded = this.loaded.get(plugin.id);
    if (!loaded) return;
    for (const [language, path] of Object.entries(resources as Record<string, unknown>)) {
      if (typeof path !== 'string' || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(language)) continue;
      const segments = path.split('/').map(encodeURIComponent).join('/');
      void fetch(`/api/v2/plugins/${encodeURIComponent(plugin.id)}/assets/${segments}`)
        .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
        .then((json) => {
          if (
            json &&
            typeof json === 'object' &&
            !Array.isArray(json) &&
            this.loaded.has(plugin.id)
          ) {
            this.i18n?.addResourceBundle(language, `legacy.${plugin.id}`, json, true, true);
            loaded.localeLanguages.push(language);
          }
        })
        .catch(() => undefined);
    }
  }

  private remove(pluginId: string): void {
    const loaded = this.loaded.get(pluginId);
    if (!loaded) return;
    globalThis.dispatchEvent(
      new CustomEvent('neotavern:legacy-plugin-disable', { detail: { pluginId } }),
    );
    loaded.script.remove();
    for (const language of loaded.localeLanguages) {
      this.i18n?.removeResourceBundle(language, `legacy.${pluginId}`);
    }
    this.loaded.delete(pluginId);
  }
}

export const legacyFrontendRuntime = new LegacyFrontendRuntime();
