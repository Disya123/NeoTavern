/**
 * Legacy frontend gate (ТЗ §10/§87): no arbitrary third-party JS in the main
 * WebView. Injection requires BOTH the per-plugin `legacy.trusted` consent
 * and the app-level `extensions.legacyFrontend` opt-in (default off).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '@neotavern/contracts';
import {
  legacyFrontendRuntime,
  readLegacyFrontendSetting,
  shouldLoadLegacyFrontend,
} from '../src/plugins/legacyRuntime.js';

function legacyPlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'test.legacy',
    name: 'Legacy Plugin',
    version: '1.0.0',
    apiVersion: 2,
    enabled: true,
    status: 'active',
    manifest: {},
    requestedPermissions: ['legacy.trusted'],
    grantedPermissions: ['legacy.trusted'],
    grantedCapabilities: [],
    addedPermissions: [],
    installedAt: 1,
    updatedAt: 1,
    hasFrontend: true,
    hasBackend: false,
    hasStyles: false,
    hasLegacyFrontend: true,
    hasLegacyBackend: false,
    compatibilityLevel: 'legacy-trusted',
    lastErrorCode: null,
    ...overrides,
  };
}

afterEach(() => {
  legacyFrontendRuntime.clear();
  legacyFrontendRuntime.setAppGateEnabled(false);
  vi.restoreAllMocks();
  document.head.replaceChildren();
});

describe('shouldLoadLegacyFrontend', () => {
  it('requires both the per-plugin consent and the app-level gate', () => {
    expect(shouldLoadLegacyFrontend({ legacyTrusted: false, appGateEnabled: false })).toBe(false);
    expect(shouldLoadLegacyFrontend({ legacyTrusted: true, appGateEnabled: false })).toBe(false);
    expect(shouldLoadLegacyFrontend({ legacyTrusted: false, appGateEnabled: true })).toBe(false);
    expect(shouldLoadLegacyFrontend({ legacyTrusted: true, appGateEnabled: true })).toBe(true);
  });
});

describe('readLegacyFrontendSetting', () => {
  it('reads extensions.legacyFrontend defensively', () => {
    expect(readLegacyFrontendSetting({ extensions: { legacyFrontend: true } })).toBe(true);
    expect(readLegacyFrontendSetting({ extensions: { legacyFrontend: false } })).toBe(false);
    expect(readLegacyFrontendSetting({ extensions: {} })).toBe(false);
    expect(readLegacyFrontendSetting({})).toBe(false);
    expect(readLegacyFrontendSetting(null)).toBe(false);
    expect(readLegacyFrontendSetting('nope')).toBe(false);
    expect(readLegacyFrontendSetting({ extensions: 'nope' })).toBe(false);
    expect(readLegacyFrontendSetting({ extensions: { legacyFrontend: 'yes' } })).toBe(false);
  });
});

describe('LegacyFrontendRuntime gate', () => {
  function appendedLegacyScripts(): string[] {
    return [...document.head.querySelectorAll('script[data-component="legacy-plugin-entry"]')].map(
      (script) => script.getAttribute('data-plugin-id') ?? '',
    );
  }

  it('skips injection when the app-level gate is off, even with consent, and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    legacyFrontendRuntime.sync([legacyPlugin()]);
    expect(appendedLegacyScripts()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    // A second sync does not repeat the warning (single warning log).
    legacyFrontendRuntime.sync([legacyPlugin()]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn when the plugin simply lacks legacy.trusted consent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    legacyFrontendRuntime.sync([legacyPlugin({ grantedPermissions: [] })]);
    expect(appendedLegacyScripts()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('injects when the app gate is enabled and the plugin is consented', () => {
    legacyFrontendRuntime.setAppGateEnabled(true);
    legacyFrontendRuntime.sync([legacyPlugin()]);
    const scripts = appendedLegacyScripts();
    expect(scripts).toEqual(['test.legacy']);
    const script = document.head.querySelector('script[data-component="legacy-plugin-entry"]');
    expect(script?.getAttribute('src')).toContain('/api/v2/plugins/test.legacy/legacy.js');
  });

  it('does not inject a plugin without legacy.trusted consent even with the gate on', () => {
    legacyFrontendRuntime.setAppGateEnabled(true);
    legacyFrontendRuntime.sync([legacyPlugin({ grantedPermissions: [] })]);
    expect(appendedLegacyScripts()).toEqual([]);
  });

  it('unloads injected entries when the app gate is turned off', () => {
    legacyFrontendRuntime.setAppGateEnabled(true);
    legacyFrontendRuntime.sync([legacyPlugin()]);
    expect(appendedLegacyScripts()).toHaveLength(1);
    legacyFrontendRuntime.setAppGateEnabled(false);
    expect(appendedLegacyScripts()).toEqual([]);
  });
});
