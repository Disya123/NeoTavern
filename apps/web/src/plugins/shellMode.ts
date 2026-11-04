/**
 * Shell replacement state and the way back (ADR-0066 D4).
 *
 * A plugin that owns the window must never be able to trap the user: the host keeps
 * this store, `restore()` always works even if the plugin is hung, crashed, or never
 * loaded, and the control that calls it is drawn by the host — not by the plugin.
 *
 * The store is deliberately tiny and synchronous. It holds an id, not a component:
 * rendering belongs to the shell, and a hung plugin cannot block a state change.
 */

export type ShellListener = (pluginId: string | null) => void;

export interface ShellModeStore {
  /** The plugin currently owning the shell, or null for the stock UI. */
  activePluginId(): string | null;
  /** Announces that `pluginId` owns the shell. */
  replace(pluginId: string): void;
  /** Returns to the stock UI. Safe to call at any time, any number of times. */
  restore(): void;
  subscribe(listener: ShellListener): () => void;
}

export function createShellModeStore(): ShellModeStore {
  const listeners = new Set<ShellListener>();
  let current: string | null = null;

  const emit = () => {
    for (const listener of listeners) listener(current);
  };

  return {
    activePluginId: () => current,
    replace(pluginId: string) {
      if (!pluginId || pluginId === current) return;
      current = pluginId;
      emit();
    },
    restore() {
      if (current === null) return;
      current = null;
      emit();
    },
    subscribe(listener: ShellListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The app-wide shell mode store. */
export const shellMode = createShellModeStore();
