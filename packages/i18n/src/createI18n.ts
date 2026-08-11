/**
 * i18next factory. Bundles en/ru resources and supports lazy addition of
 * plugin/theme namespaces. Fallback chain: regional → base language → English
 * (AGENTS.md §16).
 */
import i18next, { type i18n } from 'i18next';
import { en } from './resources/en.js';
import { ru } from './resources/ru.js';
import { pseudoLocale } from './pseudo.js';

export const NAMESPACES = [
  'common',
  'navigation',
  'chat',
  'characters',
  'personas',
  'lorebooks',
  'settings',
  'providers',
  'themes',
  'plugins',
  'errors',
  'validation',
  'accessibility',
] as const;

export interface LanguageInfo {
  code: string;
  name: string;
  dir: 'ltr' | 'rtl';
}

export const SUPPORTED_LANGUAGES: readonly LanguageInfo[] = [
  { code: 'en', name: 'English', dir: 'ltr' },
  { code: 'ru', name: 'Русский', dir: 'ltr' },
  { code: 'pseudo', name: 'Pseudo (debug)', dir: 'ltr' },
];

const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur']);

/** Resolve text direction for a language code (regional → base). */
export function languageDirection(code: string): 'ltr' | 'rtl' {
  const base = code.split('-')[0] ?? code;
  return RTL_LANGUAGES.has(base) ? 'rtl' : 'ltr';
}

export interface CreateI18nOptions {
  language?: string;
  /** Log missing translation keys (ТЗ §9). Defaults to dev-mode detection. */
  logMissingKeys?: boolean;
}

function isDevEnvironment(): boolean {
  const viteEnv = (import.meta as { env?: { DEV?: boolean } }).env;
  if (typeof viteEnv?.DEV === 'boolean') return viteEnv.DEV;
  const nodeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.['NODE_ENV'];
  return nodeEnv === undefined || nodeEnv !== 'production';
}

/** Create and initialize an isolated i18next instance. */
export async function createI18n(options: CreateI18nOptions = {}): Promise<i18n> {
  const instance = i18next.createInstance();
  const logMissing = options.logMissingKeys ?? isDevEnvironment();
  await instance.init({
    lng: options.language ?? 'en',
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: [...NAMESPACES],
    resources: {
      en,
      ru,
      pseudo: pseudoLocale,
    },
    interpolation: { escapeValue: false },
    returnNull: false,
    saveMissing: logMissing,
    missingKeyHandler: logMissing
      ? (languages, namespace, key) => {
          console.warn(`[i18n] missing translation key "${namespace}:${key}"`, languages);
        }
      : undefined,
  });
  return instance;
}
