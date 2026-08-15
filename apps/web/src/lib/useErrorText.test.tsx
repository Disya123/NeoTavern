/**
 * useErrorText must localize CAPABILITY_UNAVAILABLE honestly (ТЗ §13.1):
 * an UnsupportedError maps to `errors:UNSUPPORTED` with the feature name,
 * never to INTERNAL.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import i18next from 'i18next';
import { UnsupportedError } from '@neotavern/neobackend';
import { ApiError } from '../api/client.js';
import { useErrorText } from './useErrorText.js';
import type { ReactNode } from 'react';

async function createI18n() {
  const instance = i18next.createInstance();
  await instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: {
        errors: {
          UNKNOWN: 'Unknown error.',
          INTERNAL: 'Something went wrong. Please try again.',
          UNSUPPORTED: 'This feature is not available in this build ({{feature}}).',
        },
      },
    },
  });
  return instance;
}

describe('useErrorText', () => {
  beforeEach(() => vi.resetModules());

  it('localizes UnsupportedError as an honest capability refusal', async () => {
    const instance = await createI18n();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <I18nextProvider i18n={instance}>{children}</I18nextProvider>
    );
    const { result } = renderHook(() => useErrorText(), { wrapper });
    expect(result.current(new UnsupportedError('characters.export.card'))).toBe(
      'This feature is not available in this build (characters.export.card).',
    );
  });

  it('keeps ApiError localization and the INTERNAL fallback', async () => {
    const instance = await createI18n();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <I18nextProvider i18n={instance}>{children}</I18nextProvider>
    );
    const { result } = renderHook(() => useErrorText(), { wrapper });
    expect(
      result.current(new ApiError({ code: 'CHARACTER_NOT_FOUND', params: { characterId: 'c1' } })),
    ).toBe('Unknown error.');
    expect(result.current(new Error('boom'))).toBe('Something went wrong. Please try again.');
  });
});
