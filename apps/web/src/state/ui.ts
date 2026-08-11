/**
 * Local UI state (Zustand). Server data lives in TanStack Query — never
 * duplicated here (AGENTS.md §13). Only bounded, transient UI state belongs
 * here; message drafts never touch browser storage.
 */
import { create } from 'zustand';

export type ThemeMode = 'light' | 'dark' | 'system';
export type UiDensity = 'comfortable' | 'compact';
export type UiScale = 'small' | 'medium' | 'large';
export type UiContrast = 'normal' | 'high';
export type UiFontProfile = 'default' | 'dyslexia';
export type UiMotion = 'system' | 'reduced';
export type ChatStyle = 'clean' | 'classic' | 'bubbles' | 'document' | 'cards' | 'paragraphs';
export type ChatAvatarStyle = 'round' | 'square' | 'portrait' | 'banner' | 'hidden';
export type UserMessagePosition = 'right' | 'left';
export type CharacterMessagePosition = 'left' | 'right';

export interface InterfacePreferences {
  density: UiDensity;
  scale: UiScale;
  contrast: UiContrast;
  fontProfile: UiFontProfile;
  motion: UiMotion;
  chatStyle: ChatStyle;
  chatAvatarStyle: ChatAvatarStyle;
  userMessagePosition: UserMessagePosition;
  characterMessagePosition: CharacterMessagePosition;
  uiOpacity?: number;
  uiGlassBlur?: number;
  globalBackgroundId?: string | null;
}

export type SidebarPanelId =
  | 'home'
  | 'characters'
  | 'providers'
  | 'settings'
  | 'personas'
  | 'lorebooks'
  | 'plugins'
  | 'backgrounds';

const MAX_SESSION_DRAFTS = 50;

interface UiState {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  density: UiDensity;
  setDensity: (density: UiDensity) => void;
  scale: UiScale;
  setScale: (scale: UiScale) => void;
  contrast: UiContrast;
  setContrast: (contrast: UiContrast) => void;
  fontProfile: UiFontProfile;
  setFontProfile: (fontProfile: UiFontProfile) => void;
  motion: UiMotion;
  setMotion: (motion: UiMotion) => void;
  uiOpacity: number;
  setUiOpacity: (opacity: number) => void;
  uiGlassBlur: number;
  setUiGlassBlur: (blur: number) => void;
  globalBackgroundId: string | null;
  setGlobalBackgroundId: (id: string | null) => void;
  chatStyle: ChatStyle;
  setChatStyle: (style: ChatStyle) => void;
  chatAvatarStyle: ChatAvatarStyle;
  setChatAvatarStyle: (style: ChatAvatarStyle) => void;
  userMessagePosition: UserMessagePosition;
  setUserMessagePosition: (position: UserMessagePosition) => void;
  characterMessagePosition: CharacterMessagePosition;
  setCharacterMessagePosition: (position: CharacterMessagePosition) => void;
  language: string;
  setLanguage: (language: string) => void;
  openHomeOnLoad: boolean;
  setOpenHomeOnLoad: (open: boolean) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  navigationRailExpanded: boolean;
  setNavigationRailExpanded: (expanded: boolean) => void;
  activeSidebarPanel: SidebarPanelId;
  openSidebarPanel: (panel: SidebarPanelId) => void;
  pinnedCharacterId: string | null;
  setPinnedCharacterId: (id: string | null) => void;
  drafts: Readonly<Record<string, string>>;
  setDraft: (scope: string, value: string) => void;
}

function readStored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore — private mode may block storage
  }
}

const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];
const UI_DENSITIES: readonly UiDensity[] = ['comfortable', 'compact'];
const UI_SCALES: readonly UiScale[] = ['small', 'medium', 'large'];
const UI_CONTRASTS: readonly UiContrast[] = ['normal', 'high'];
const UI_FONT_PROFILES: readonly UiFontProfile[] = ['default', 'dyslexia'];
const UI_MOTIONS: readonly UiMotion[] = ['system', 'reduced'];
const CHAT_STYLES: readonly ChatStyle[] = [
  'clean',
  'classic',
  'bubbles',
  'document',
  'cards',
  'paragraphs',
];
const CHAT_AVATAR_STYLES: readonly ChatAvatarStyle[] = [
  'round',
  'square',
  'portrait',
  'banner',
  'hidden',
];
const USER_MESSAGE_POSITIONS: readonly UserMessagePosition[] = ['right', 'left'];
const CHARACTER_MESSAGE_POSITIONS: readonly CharacterMessagePosition[] = ['left', 'right'];

function readChoice<T extends string>(key: string, choices: readonly T[], fallback: T): T {
  const stored = readStored(key, fallback);
  return choices.find((choice) => choice === stored) ?? fallback;
}

function readNumber(key: string, min: number, max: number, fallback: number): number {
  const stored = readStored(key, String(fallback));
  const parsed = Number(stored);
  if (Number.isFinite(parsed) && parsed >= min && parsed <= max) return parsed;
  return fallback;
}

function readBoolean(key: string, fallback: boolean): boolean {
  const stored = readStored(key, String(fallback));
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return fallback;
}

/** Hydrate the theme mode defensively — corrupted storage falls back. */
function readThemeMode(): ThemeMode {
  return readChoice('neotavern.themeMode', THEME_MODES, 'system');
}

export const useUiStore = create<UiState>((set) => ({
  themeMode: readThemeMode(),
  setThemeMode: (mode) => {
    store('neotavern.themeMode', mode);
    set({ themeMode: mode });
  },
  density: readChoice('neotavern.uiDensity', UI_DENSITIES, 'comfortable'),
  setDensity: (density) => {
    store('neotavern.uiDensity', density);
    set({ density });
  },
  scale: readChoice('neotavern.uiScale', UI_SCALES, 'medium'),
  setScale: (scale) => {
    store('neotavern.uiScale', scale);
    set({ scale });
  },
  contrast: readChoice('neotavern.uiContrast', UI_CONTRASTS, 'normal'),
  setContrast: (contrast) => {
    store('neotavern.uiContrast', contrast);
    set({ contrast });
  },
  fontProfile: readChoice('neotavern.uiFontProfile', UI_FONT_PROFILES, 'default'),
  setFontProfile: (fontProfile) => {
    store('neotavern.uiFontProfile', fontProfile);
    set({ fontProfile });
  },
  motion: readChoice('neotavern.uiMotion', UI_MOTIONS, 'system'),
  setMotion: (motion) => {
    store('neotavern.uiMotion', motion);
    set({ motion });
  },
  uiOpacity: readNumber('neotavern.uiOpacity', 0, 100, 70),
  setUiOpacity: (uiOpacity) => {
    store('neotavern.uiOpacity', String(uiOpacity));
    set({ uiOpacity });
  },
  uiGlassBlur: readNumber('neotavern.uiGlassBlur', 0, 40, 16),
  setUiGlassBlur: (uiGlassBlur) => {
    store('neotavern.uiGlassBlur', String(uiGlassBlur));
    set({ uiGlassBlur });
  },
  globalBackgroundId: readStored('neotavern.globalBackgroundId', '') || null,
  setGlobalBackgroundId: (globalBackgroundId) => {
    if (globalBackgroundId) {
      store('neotavern.globalBackgroundId', globalBackgroundId);
    } else {
      try {
        localStorage.removeItem('neotavern.globalBackgroundId');
      } catch {
        // localStorage may be unavailable (privacy mode); clearing is best-effort.
      }
    }
    set({ globalBackgroundId });
  },
  chatStyle: readChoice('neotavern.chatStyle', CHAT_STYLES, 'clean'),
  setChatStyle: (chatStyle) => {
    store('neotavern.chatStyle', chatStyle);
    set({ chatStyle });
  },
  chatAvatarStyle: readChoice('neotavern.chatAvatarStyle', CHAT_AVATAR_STYLES, 'round'),
  setChatAvatarStyle: (chatAvatarStyle) => {
    store('neotavern.chatAvatarStyle', chatAvatarStyle);
    set({ chatAvatarStyle });
  },
  userMessagePosition: readChoice('neotavern.userMessagePosition', USER_MESSAGE_POSITIONS, 'right'),
  setUserMessagePosition: (userMessagePosition) => {
    store('neotavern.userMessagePosition', userMessagePosition);
    set({ userMessagePosition });
  },
  characterMessagePosition: readChoice(
    'neotavern.characterMessagePosition',
    CHARACTER_MESSAGE_POSITIONS,
    'left',
  ),
  setCharacterMessagePosition: (characterMessagePosition) => {
    store('neotavern.characterMessagePosition', characterMessagePosition);
    set({ characterMessagePosition });
  },
  language: readStored('neotavern.language', 'en'),
  setLanguage: (language) => {
    store('neotavern.language', language);
    set({ language });
  },
  openHomeOnLoad: readBoolean('neotavern.openHomeOnLoad', true),
  setOpenHomeOnLoad: (openHomeOnLoad) => {
    store('neotavern.openHomeOnLoad', String(openHomeOnLoad));
    set({ openHomeOnLoad });
  },
  sidebarOpen: false,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  navigationRailExpanded: readStored('neotavern.navigationRailExpanded', 'true') === 'true',
  setNavigationRailExpanded: (expanded) => {
    store('neotavern.navigationRailExpanded', String(expanded));
    set({ navigationRailExpanded: expanded });
  },
  activeSidebarPanel: 'home',
  openSidebarPanel: (panel) => set({ activeSidebarPanel: panel, sidebarOpen: true }),
  pinnedCharacterId: readStored('neotavern.pinnedCharacterId', '') || null,
  setPinnedCharacterId: (id) => {
    store('neotavern.pinnedCharacterId', id ?? '');
    set({ pinnedCharacterId: id });
  },
  drafts: {},
  setDraft: (scope, value) =>
    set((state) => {
      const drafts: Record<string, string> = { ...state.drafts };
      delete drafts[scope];
      if (value.length > 0) drafts[scope] = value;
      const staleScopes = Object.keys(drafts).slice(0, -MAX_SESSION_DRAFTS);
      for (const staleScope of staleScopes) delete drafts[staleScope];
      return { drafts };
    }),
}));
