import { describe, expect, it, vi } from 'vitest';
import { createShellModeStore } from './shellMode.js';

describe('shell mode store', () => {
  it('starts on the stock UI and reports who owns the shell', () => {
    const store = createShellModeStore();
    expect(store.activePluginId()).toBeNull();
    store.replace('author.shell');
    expect(store.activePluginId()).toBe('author.shell');
  });

  it('always offers a way back, even when nothing was replaced', () => {
    const store = createShellModeStore();
    expect(() => store.restore()).not.toThrow();
    store.replace('author.shell');
    store.restore();
    expect(store.activePluginId()).toBeNull();
    // Idempotent: the host control may be pressed twice.
    store.restore();
    expect(store.activePluginId()).toBeNull();
  });

  it('notifies subscribers on change only', () => {
    const store = createShellModeStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.replace('author.shell');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith('author.shell');

    // Replacing with the same plugin is not a change.
    store.replace('author.shell');
    expect(listener).toHaveBeenCalledTimes(1);

    store.restore();
    expect(listener).toHaveBeenLastCalledWith(null);

    unsubscribe();
    store.replace('author.other');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('ignores an empty plugin id instead of blanking the shell', () => {
    const store = createShellModeStore();
    store.replace('author.shell');
    store.replace('');
    expect(store.activePluginId()).toBe('author.shell');
  });
});
