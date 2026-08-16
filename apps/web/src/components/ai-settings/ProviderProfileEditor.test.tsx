/**
 * ProviderProfileEditor kernel-plane tests (M5 slice 27): model discovery has
 * no wire operation, so after a successful kernel connection the optional
 * warm-up refusal must NOT surface as a failed connection — the panel reports
 * the honest 'Saved' state instead of a localized UNSUPPORTED error.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_PROMPT_TEMPLATE,
  type AppSettings,
  type ProviderCatalogEntry,
  type ProviderConfig,
  type ProviderConfigDto,
} from '@neotavern/contracts';
import { createI18n } from '@neotavern/i18n';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api/client.js';
import { ProviderProfileEditor } from './ProviderProfileEditor.js';

const mocks = vi.hoisted(() => ({ isKernelMode: vi.fn(() => false) }));
vi.mock('../../api/backend.js', async (importOriginal) => {
  const actual = (await importOriginal()) as { backend: unknown };
  return { ...actual, isKernelMode: mocks.isKernelMode };
});

import { backend } from '../../api/backend.js';

const catalogEntry: ProviderCatalogEntry = {
  id: 'openai-compatible',
  adapterKind: 'openai-compatible',
  defaultBaseUrl: null,
  apiKeyRequired: false,
  baseUrlEditable: true,
  samplerSupport: ['temperature', 'topP', 'frequencyPenalty', 'presencePenalty'],
};

const storedProvider: ProviderConfig = {
  id: '018f0000-0000-7000-8000-000000000101',
  kind: 'openai-compatible',
  name: 'Local model',
  baseUrl: 'http://127.0.0.1:1234/v1',
  model: 'old-model',
  enabled: true,
  hasApiKey: true,
  settings: { source: 'openai-compatible', samplerCompatibility: 'standard' },
  createdAt: 1,
  updatedAt: 1,
};

const PROVIDER_DTO: ProviderConfigDto = {
  id: storedProvider.id,
  provider: 'openai-compatible',
  name: 'default',
  config: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', enabled: true },
  hasApiKey: true,
  createdAt: '2026-08-13T00:00:00Z',
  updatedAt: '2026-08-13T01:00:00Z',
};

const defaultSettings: AppSettings = {
  language: 'en',
  themeId: null,
  activeProviderConfigId: storedProvider.id,
  activePersonaId: null,
  contextStrategy: 'truncate',
  maxContextTokens: 16032,
  generationDefaults: { maxTokens: 2048, temperature: 0.8, stream: true },
  instructFormat: null,
  instructFormatId: null,
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  activeGenerationPresetId: null,
  activePromptTemplatePresetId: null,
  macroVariables: {},
  ui: {},
};

async function renderEditor(element: ReactElement) {
  const i18n = await createI18n({ language: 'en' });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(['providers'], { items: [storedProvider] });
  queryClient.setQueryData(['provider-catalog'], { items: [catalogEntry] });
  queryClient.setQueryData(['settings'], defaultSettings);
  queryClient.setQueryData(['presets', 'generation'], { items: [] });
  queryClient.setQueryData(['presets', 'prompt-template'], { items: [] });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>{element}</I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, i18n, queryClient };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setCsrfToken('test-csrf');
  mocks.isKernelMode.mockReturnValue(false);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

describe('ProviderProfileEditor (kernel plane, slice 27)', () => {
  it('connect saves the provider and does not report discovery as a failed connection', async () => {
    mocks.isKernelMode.mockReturnValue(true);
    const configList = vi
      .spyOn(backend.providers.config, 'list')
      .mockResolvedValue({ items: [PROVIDER_DTO] });
    const configSet = vi.spyOn(backend.providers.config, 'set').mockResolvedValue(PROVIDER_DTO);
    const settingsGet = vi.spyOn(backend.settings, 'get').mockResolvedValue({ items: [] });
    const settingsUpdate = vi.spyOn(backend.settings, 'update').mockResolvedValue({ items: [] });

    await renderEditor(<ProviderProfileEditor />);
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    // The connection persisted through the wire config set, and the optional
    // model-discovery refusal (UnsupportedError) is absorbed into the honest
    // 'Saved' status — no localized failure and no legacy network call.
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    expect(configSet).toHaveBeenCalled();
    expect(settingsUpdate).toHaveBeenCalled();
    expect(configList).toHaveBeenCalled();
    expect(settingsGet).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
