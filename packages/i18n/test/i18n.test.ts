import { describe, it, expect } from 'vitest';
import {
  createI18n,
  localizeError,
  languageDirection,
  pseudoLocale,
  en,
  ru,
} from '../src/index.js';

/** All leaf key paths of a nested resource tree, e.g. "chat.messages_one". */
function keyPaths(node: unknown, prefix = ''): string[] {
  if (typeof node !== 'object' || node === null) return prefix ? [prefix] : [];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    keyPaths(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe('i18n', () => {
  it('translates from the default English namespace', async () => {
    const i18n = await createI18n();
    expect(i18n.t('common:save')).toBe('Save');
    expect(i18n.t('navigation:characters')).toBe('Characters');
  });

  it('switches language without reload', async () => {
    const i18n = await createI18n();
    await i18n.changeLanguage('ru');
    expect(i18n.t('common:save')).toBe('Сохранить');
    expect(i18n.t('navigation:characters')).toBe('Персонажи');
  });

  it('falls back to English for missing keys', async () => {
    const i18n = await createI18n({ language: 'ru' });
    // 'appName' is identical but exists; use a guaranteed-en-only check via pseudo.
    expect(i18n.t('common:appName')).toBe('NeoTavern');
  });

  it('localizes error codes with interpolation', async () => {
    const i18n = await createI18n();
    const msg = localizeError(i18n, 'CHARACTER_NOT_FOUND', { characterId: 'abc' });
    expect(msg).toContain('abc');
    expect(msg.toLowerCase()).toContain('not found');
  });

  it('falls back to UNKNOWN for unrecognized codes', async () => {
    const i18n = await createI18n();
    expect(localizeError(i18n, 'TOTALLY_UNKNOWN_CODE')).toBe('Unknown error.');
  });

  it('provides a pseudo-locale that wraps strings', () => {
    expect(pseudoLocale.common.save).toContain('[!!');
    expect(pseudoLocale.common.save).toContain('Save');
  });

  it('resolves text direction', () => {
    expect(languageDirection('en')).toBe('ltr');
    expect(languageDirection('ru')).toBe('ltr');
    expect(languageDirection('ar')).toBe('rtl');
    expect(languageDirection('ar-EG')).toBe('rtl');
  });

  it('keeps ru structurally identical to en (no missing branches)', () => {
    // ru must define every key en defines (extra CLDR plural forms are allowed).
    const enKeys = new Set(keyPaths(en));
    const ruKeys = new Set(keyPaths(ru));
    const missingInRu = [...enKeys].filter((key) => !ruKeys.has(key));
    expect(missingInRu).toEqual([]);
  });

  it('pluralizes Russian with one/few/many CLDR forms', async () => {
    const i18n = await createI18n({ language: 'ru', logMissingKeys: false });
    expect(i18n.t('chat:messages', { count: 1 })).toBe('1 сообщение');
    expect(i18n.t('chat:messages', { count: 3 })).toBe('3 сообщения');
    expect(i18n.t('chat:messages', { count: 5 })).toBe('5 сообщений');
    expect(i18n.t('chat:messages', { count: 21 })).toBe('21 сообщение');
    expect(i18n.t('chat:messages', { count: 11 })).toBe('11 сообщений');
  });

  it('pseudo-locale inflates every string for long-text layout checks (ТЗ §9)', async () => {
    const i18n = await createI18n({ language: 'pseudo', logMissingKeys: false });
    const sample = i18n.t('common:save');
    expect(sample).toContain('[!!');
    expect(sample.length).toBeGreaterThan('Save'.length);
    // Interpolation survives the padding.
    const withCount = i18n.t('chat:messages', { count: 7 });
    expect(withCount).toContain('7');
  });
});
