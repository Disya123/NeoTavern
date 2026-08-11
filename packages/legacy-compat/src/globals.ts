/**
 * Installs the documented legacy window globals (AGENTS.md §18):
 * `window.SillyTavern`, `window.eventSource`, `window.event_types`,
 * `window.extension_settings`, and `window.$` / `window.jQuery`.
 *
 * These are the documented contracts; internal random CSS classes and private
 * imports are NOT supported (best-effort only).
 */
import jQuery from 'jquery';
import { LegacyEventSource, event_types } from './eventSource.js';
import {
  createLegacyContext,
  setLegacyBridge,
  type LegacyBridge,
  type LegacyContext,
} from './context.js';

interface LegacyWindow extends Window {
  SillyTavern?: {
    getContext(): LegacyContext;
    eventSource: LegacyEventSource;
    event_types: typeof event_types;
  };
  eventSource?: LegacyEventSource;
  event_types?: typeof event_types;
  extension_settings?: Record<string, Record<string, unknown>>;
  jQuery?: typeof jQuery;
  $?: typeof jQuery;
}

export interface LegacyCompatHandle {
  eventSource: LegacyEventSource;
  getContext(): LegacyContext;
  /** Remove the installed globals (for tests / teardown). */
  uninstall(): void;
}

/**
 * Install legacy globals and wire the host bridge. Idempotent — returns the
 * same event source if already installed.
 */
export function installLegacyCompat(bridge?: LegacyBridge): LegacyCompatHandle {
  const win = window as LegacyWindow;
  if (bridge) setLegacyBridge(bridge);

  const eventSource = win.eventSource ?? new LegacyEventSource();
  const context = createLegacyContext(eventSource);

  win.eventSource = eventSource;
  win.event_types = event_types;
  win.extension_settings = win.extension_settings ?? {};
  win.jQuery = jQuery;
  win.$ = jQuery;
  win.SillyTavern = {
    getContext: () => context,
    eventSource,
    event_types,
  };

  return {
    eventSource,
    getContext: () => context,
    uninstall: () => {
      delete win.SillyTavern;
      delete win.eventSource;
      delete win.event_types;
      delete win.extension_settings;
      delete win.jQuery;
      delete win.$;
    },
  };
}
