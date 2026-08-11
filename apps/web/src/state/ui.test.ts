/** Tests for the zustand UI store: transitions, persistence, no secret storage. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { useUiStore as UseUiStoreFn } from './ui.js';

let useUiStore: typeof UseUiStoreFn;

/** The store hydrates at module-init time, so each test gets a fresh module. */
async function freshStore(): Promise<typeof UseUiStoreFn> {
  vi.resetModules();
  return (await import('./ui.js')).useUiStore;
}

beforeEach(async () => {
  localStorage.clear();
  useUiStore = await freshStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('initial state', () => {
  it('defaults to safe interface preferences and an empty workspace state', () => {
    expect(useUiStore.getState()).toMatchObject({
      themeMode: 'system',
      density: 'comfortable',
      scale: 'medium',
      contrast: 'normal',
      fontProfile: 'default',
      motion: 'system',
      chatStyle: 'clean',
      chatAvatarStyle: 'round',
      userMessagePosition: 'right',
      characterMessagePosition: 'left',
      language: 'en',
      openHomeOnLoad: true,
      sidebarOpen: false,
      activeSidebarPanel: 'home',
      pinnedCharacterId: null,
    });
  });

  it('hydrates persisted preferences when the store is created', async () => {
    localStorage.setItem('neotavern.themeMode', 'light');
    localStorage.setItem('neotavern.language', 'ru');
    localStorage.setItem('neotavern.pinnedCharacterId', 'char-7');
    localStorage.setItem('neotavern.uiDensity', 'compact');
    localStorage.setItem('neotavern.uiScale', 'large');
    localStorage.setItem('neotavern.uiContrast', 'high');
    localStorage.setItem('neotavern.uiFontProfile', 'dyslexia');
    localStorage.setItem('neotavern.uiMotion', 'reduced');
    localStorage.setItem('neotavern.chatStyle', 'cards');
    localStorage.setItem('neotavern.chatAvatarStyle', 'portrait');
    localStorage.setItem('neotavern.userMessagePosition', 'left');
    localStorage.setItem('neotavern.characterMessagePosition', 'right');
    localStorage.setItem('neotavern.openHomeOnLoad', 'false');
    const store = await freshStore();
    expect(store.getState()).toMatchObject({
      themeMode: 'light',
      density: 'compact',
      scale: 'large',
      contrast: 'high',
      fontProfile: 'dyslexia',
      motion: 'reduced',
      chatStyle: 'cards',
      chatAvatarStyle: 'portrait',
      userMessagePosition: 'left',
      characterMessagePosition: 'right',
      language: 'ru',
      openHomeOnLoad: false,
      pinnedCharacterId: 'char-7',
    });
  });

  it('falls back to defaults when storage reads fail', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const store = await freshStore();
    expect(store.getState()).toMatchObject({
      themeMode: 'system',
      density: 'comfortable',
      scale: 'medium',
      contrast: 'normal',
      fontProfile: 'default',
      motion: 'system',
      chatStyle: 'clean',
      chatAvatarStyle: 'round',
      userMessagePosition: 'right',
      characterMessagePosition: 'left',
      language: 'en',
      openHomeOnLoad: true,
      pinnedCharacterId: null,
    });
  });
});

describe('actions', () => {
  it('setThemeMode updates state and persists the choice', () => {
    useUiStore.getState().setThemeMode('system');
    expect(useUiStore.getState().themeMode).toBe('system');
    expect(localStorage.getItem('neotavern.themeMode')).toBe('system');
  });

  it('setLanguage updates state and persists the choice', () => {
    useUiStore.getState().setLanguage('de');
    expect(useUiStore.getState().language).toBe('de');
    expect(localStorage.getItem('neotavern.language')).toBe('de');
  });

  it('setOpenHomeOnLoad persists the startup preference', () => {
    useUiStore.getState().setOpenHomeOnLoad(false);
    expect(useUiStore.getState().openHomeOnLoad).toBe(false);
    expect(localStorage.getItem('neotavern.openHomeOnLoad')).toBe('false');
  });

  it('persists interface and chat presentation preferences', () => {
    const actions = useUiStore.getState();
    actions.setDensity('compact');
    actions.setScale('large');
    actions.setContrast('high');
    actions.setFontProfile('dyslexia');
    actions.setMotion('reduced');
    actions.setChatStyle('paragraphs');
    actions.setChatAvatarStyle('banner');
    expect(useUiStore.getState()).toMatchObject({
      density: 'compact',
      scale: 'large',
      contrast: 'high',
      fontProfile: 'dyslexia',
      motion: 'reduced',
      chatStyle: 'paragraphs',
      chatAvatarStyle: 'banner',
    });
    expect(localStorage.getItem('neotavern.uiDensity')).toBe('compact');
    expect(localStorage.getItem('neotavern.uiScale')).toBe('large');
    expect(localStorage.getItem('neotavern.uiContrast')).toBe('high');
    expect(localStorage.getItem('neotavern.uiFontProfile')).toBe('dyslexia');
    expect(localStorage.getItem('neotavern.uiMotion')).toBe('reduced');
    expect(localStorage.getItem('neotavern.chatStyle')).toBe('paragraphs');
    expect(localStorage.getItem('neotavern.chatAvatarStyle')).toBe('banner');
  });

  it('openSidebarPanel selects the panel and opens the sidebar', () => {
    useUiStore.getState().openSidebarPanel('providers');
    expect(useUiStore.getState()).toMatchObject({
      activeSidebarPanel: 'providers',
      sidebarOpen: true,
    });
  });

  it('setSidebarOpen toggles transient state without touching storage', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    useUiStore.getState().setSidebarOpen(true);
    useUiStore.getState().setSidebarOpen(false);
    expect(useUiStore.getState().sidebarOpen).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('setPinnedCharacterId round-trips through storage, mapping null to empty', async () => {
    useUiStore.getState().setPinnedCharacterId('char-3');
    expect(useUiStore.getState().pinnedCharacterId).toBe('char-3');
    expect(localStorage.getItem('neotavern.pinnedCharacterId')).toBe('char-3');
    useUiStore.getState().setPinnedCharacterId(null);
    expect(useUiStore.getState().pinnedCharacterId).toBeNull();
    expect(localStorage.getItem('neotavern.pinnedCharacterId')).toBe('');
    const store = await freshStore();
    expect(store.getState().pinnedCharacterId).toBeNull();
  });

  it('keeps working when storage writes are blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(() => useUiStore.getState().setThemeMode('light')).not.toThrow();
    expect(useUiStore.getState().themeMode).toBe('light');
  });
});

describe('secrets are never persisted', () => {
  it('writes only the documented transient preference keys', () => {
    const writes: string[] = [];
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key: string) {
      writes.push(key);
    });
    const actions = useUiStore.getState();
    actions.setThemeMode('light');
    actions.setLanguage('de');
    actions.setDensity('compact');
    actions.setScale('large');
    actions.setContrast('high');
    actions.setFontProfile('dyslexia');
    actions.setMotion('reduced');
    actions.setChatStyle('classic');
    actions.setChatAvatarStyle('square');
    actions.setUserMessagePosition('left');
    actions.setCharacterMessagePosition('right');
    actions.setOpenHomeOnLoad(false);
    actions.setSidebarOpen(true);
    actions.openSidebarPanel('settings');
    actions.setPinnedCharacterId('char-9');
    expect(new Set(writes)).toEqual(
      new Set([
        'neotavern.themeMode',
        'neotavern.uiDensity',
        'neotavern.uiScale',
        'neotavern.uiContrast',
        'neotavern.uiFontProfile',
        'neotavern.uiMotion',
        'neotavern.chatStyle',
        'neotavern.chatAvatarStyle',
        'neotavern.userMessagePosition',
        'neotavern.characterMessagePosition',
        'neotavern.language',
        'neotavern.openHomeOnLoad',
        'neotavern.pinnedCharacterId',
      ]),
    );
  });

  it('holds no api keys, tokens or other secrets in state', () => {
    const stateKeys = Object.keys(useUiStore.getState());
    expect(stateKeys).toEqual(
      expect.arrayContaining([
        'themeMode',
        'density',
        'scale',
        'contrast',
        'fontProfile',
        'motion',
        'chatStyle',
        'chatAvatarStyle',
        'userMessagePosition',
        'characterMessagePosition',
        'language',
        'openHomeOnLoad',
        'sidebarOpen',
        'activeSidebarPanel',
        'pinnedCharacterId',
      ]),
    );
    for (const key of stateKeys) {
      expect(key).not.toMatch(/secret|token|password|csrf|credential|api.?key/i);
    }
    const values = Object.values(useUiStore.getState()).filter(
      (value) => typeof value === 'string',
    );
    expect(values).toEqual([
      'system',
      'comfortable',
      'medium',
      'normal',
      'default',
      'system',
      'clean',
      'round',
      'right',
      'left',
      'en',
      'home',
    ]);
  });
});
