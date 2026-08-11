import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_PROMPT_TEMPLATE,
  ReasoningEfforts,
  type AppSettings,
  type ProviderCatalogEntry,
  type ProviderConfig,
} from '@neotavern/contracts';
import { createI18n } from '@neotavern/i18n';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '../../../test/helpers.js';
import { setCsrfToken } from '../../api/client.js';
import { setDocumentLanguage } from '../../lib/lang.js';
import { GenerationPresetEditor } from './GenerationPresetEditor.js';
import { PromptTemplateEditor } from './PromptTemplateEditor.js';
import { ProviderProfileEditor } from './ProviderProfileEditor.js';

const catalogEntry: ProviderCatalogEntry = {
  id: 'openai-compatible',
  adapterKind: 'openai-compatible',
  defaultBaseUrl: null,
  apiKeyRequired: false,
  baseUrlEditable: true,
  samplerSupport: ['temperature', 'topP', 'frequencyPenalty', 'presencePenalty'],
};

const textCatalogEntry: ProviderCatalogEntry = {
  id: 'text-completion',
  adapterKind: 'text-completion',
  defaultBaseUrl: 'http://127.0.0.1:5000',
  apiKeyRequired: false,
  baseUrlEditable: true,
  samplerSupport: [],
};

const requiredKeyCatalogEntry: ProviderCatalogEntry = {
  id: 'nanogpt',
  adapterKind: 'openai-compatible',
  defaultBaseUrl: 'https://nano-gpt.com/api/v1',
  apiKeyRequired: true,
  baseUrlEditable: true,
  samplerSupport: [
    'temperature',
    'topP',
    'topK',
    'minP',
    'topA',
    'repetitionPenalty',
    'frequencyPenalty',
    'presencePenalty',
    'seed',
    'reasoningEffort',
  ],
  reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
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

interface RenderOptions {
  language?: string;
  providers?: ProviderConfig[];
  settings?: AppSettings;
  catalog?: ProviderCatalogEntry[];
}

async function renderEditor(element: ReactElement, options: RenderOptions = {}) {
  const i18n = await createI18n({ language: options.language ?? 'en' });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(['providers'], { items: options.providers ?? [storedProvider] });
  queryClient.setQueryData(['provider-catalog'], { items: options.catalog ?? [catalogEntry] });
  queryClient.setQueryData(['settings'], options.settings ?? defaultSettings);
  queryClient.setQueryData(['presets', 'generation'], { items: [] });
  queryClient.setQueryData(['presets', 'prompt-template'], { items: [] });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>{element}</I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, i18n, queryClient };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'elementFromPoint');
  setCsrfToken(null);
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
});

describe('ProviderProfileEditor', () => {
  it('preserves a stored key while editing a manual model after empty discovery', async () => {
    setCsrfToken('test-csrf');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const nextProvider = { ...storedProvider, model: 'manual-model', updatedAt: 2 };
    const nextSettings = { ...defaultSettings, activeProviderConfigId: storedProvider.id };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        const method = init?.method ?? 'GET';
        if (url.endsWith(`/providers/${storedProvider.id}`) && method === 'PATCH') {
          return jsonResponse(nextProvider);
        }
        if (url.endsWith(`/providers/${storedProvider.id}/models`)) {
          return jsonResponse({
            models: [
              { id: 'manual-model', name: 'Manual model', contextLimit: 32768 },
              { id: 'other-model', name: 'Other model' },
            ],
          });
        }
        if (url.endsWith(`/providers/${storedProvider.id}/secrets`)) {
          return jsonResponse({
            items: [
              {
                id: 'secret-primary',
                label: 'Primary',
                masked: 'sk-…1234',
                active: true,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          });
        }
        if (url.endsWith('/settings') && method === 'PATCH') return jsonResponse(nextSettings);
        if (url.endsWith('/settings')) return jsonResponse(nextSettings);
        if (url.endsWith('/providers')) return jsonResponse({ items: [nextProvider] });
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    await renderEditor(<ProviderProfileEditor />);
    const keySelect = await screen.findByLabelText('API key');
    await waitFor(() => expect(keySelect).toHaveValue('secret-primary'));
    expect(keySelect).toHaveTextContent('Primary · sk-…1234');

    const modelInput = screen.getByLabelText('Model');
    await userEvent.clear(modelInput);
    await userEvent.type(modelInput, 'manual-model');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    const update = calls.find(
      ({ url, init }) =>
        url.endsWith(`/providers/${storedProvider.id}`) && init?.method === 'PATCH',
    );
    expect(update).toBeDefined();
    const payload = JSON.parse(String(update?.init?.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({ model: 'manual-model' });
    expect(payload).not.toHaveProperty('apiKey');
    // Closed menu mirrors the picked model's label; the committed id is kept.
    expect(screen.getByLabelText('Model')).toHaveValue(
      `Manual model (${(32768).toLocaleString()})`,
    );
    // The menu reopens pre-filtered to the committed id...
    await userEvent.click(screen.getByLabelText('Model'));
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('manual-model');
    // ...while the status line reports the discovery result.
    expect(screen.getByText('2 models loaded.')).toBeInTheDocument();
  });

  it('preserves the selected key when changing the provider source', async () => {
    setCsrfToken('test-csrf');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const nextProvider: ProviderConfig = {
      ...storedProvider,
      baseUrl: requiredKeyCatalogEntry.defaultBaseUrl,
      settings: { source: 'nanogpt', promptPostProcessing: '' },
      updatedAt: 2,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        const method = init?.method ?? 'GET';
        if (url.endsWith(`/providers/${storedProvider.id}`) && method === 'PATCH') {
          return jsonResponse(nextProvider);
        }
        if (url.endsWith(`/providers/${storedProvider.id}/models`)) {
          return jsonResponse({ models: [] });
        }
        if (url.endsWith(`/providers/${storedProvider.id}/secrets`)) {
          return jsonResponse({
            items: [
              {
                id: 'secret-nanogpt',
                label: 'NanoGPT',
                masked: 'nano-...1234',
                active: true,
                createdAt: 1,
              },
            ],
          });
        }
        if (url.endsWith('/settings') && method === 'PATCH') return jsonResponse(defaultSettings);
        if (url.endsWith('/settings')) return jsonResponse(defaultSettings);
        if (url.endsWith('/providers')) return jsonResponse({ items: [nextProvider] });
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    await renderEditor(<ProviderProfileEditor />, {
      catalog: [catalogEntry, requiredKeyCatalogEntry],
    });
    const keySelect = await screen.findByLabelText('API key');
    await waitFor(() => expect(keySelect).toHaveValue('secret-nanogpt'));

    await userEvent.selectOptions(screen.getByLabelText('Provider source'), 'nanogpt');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    const update = calls.find(
      ({ url, init }) =>
        url.endsWith(`/providers/${storedProvider.id}`) && init?.method === 'PATCH',
    );
    expect(update).toBeDefined();
    const payload = JSON.parse(String(update?.init?.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      baseUrl: 'https://nano-gpt.com/api/v1',
      settings: { source: 'nanogpt' },
    });
    expect(payload).not.toHaveProperty('apiKey');
  });

  it('creates a profile without a Name field, auto-naming it from the source', async () => {
    setCsrfToken('test-csrf');
    const created = {
      ...storedProvider,
      id: '018f0000-0000-7000-8000-000000000102',
      name: 'Custom OpenAI-compatible',
      model: 'remote-model',
      hasApiKey: true,
    };
    let createPayload: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/providers') && method === 'POST') {
          createPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return jsonResponse(created);
        }
        if (url.endsWith(`/providers/${created.id}/models`)) return jsonResponse({ models: [] });
        if (url.endsWith('/settings') && method === 'PATCH') return jsonResponse(defaultSettings);
        if (url.endsWith('/providers')) return jsonResponse({ items: [created] });
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    // Panel surface: the source is the identity, so there is no Name field.
    await renderEditor(<ProviderProfileEditor />, {
      providers: [],
      settings: { ...defaultSettings, activeProviderConfigId: null },
    });
    expect(screen.queryByLabelText('Name')).toBeNull();
    await userEvent.type(await screen.findByLabelText('Base URL'), 'https://example.test/v1');
    await userEvent.type(screen.getByLabelText('Model'), 'remote-model');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());
    expect(createPayload).toMatchObject({
      model: 'remote-model',
      name: 'Custom OpenAI-compatible',
    });
    expect(createPayload).not.toHaveProperty('apiKey');
  });

  it('opens the key manager from the key icon for a new required-key profile', async () => {
    setCsrfToken('test-csrf');
    const created = {
      ...storedProvider,
      id: '018f0000-0000-7000-8000-000000000104',
      name: 'NanoGPT',
      baseUrl: 'https://nano-gpt.com/api/v1',
      hasApiKey: false,
      settings: { source: 'nanogpt' },
    };
    let createPayload: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/providers') && method === 'POST') {
          createPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return jsonResponse(created);
        }
        if (url.endsWith(`/providers/${created.id}/secrets`)) return jsonResponse({ items: [] });
        if (url.endsWith('/providers')) return jsonResponse({ items: [created] });
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    await renderEditor(<ProviderProfileEditor />, {
      providers: [],
      settings: { ...defaultSettings, activeProviderConfigId: null },
      catalog: [requiredKeyCatalogEntry],
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Manage keys' }));

    expect(await screen.findByRole('dialog', { name: 'API keys · NanoGPT' })).toBeVisible();
    expect(createPayload).toMatchObject({ name: 'NanoGPT' });
    expect(createPayload).not.toHaveProperty('apiKey');
    expect(screen.queryByText('No key stored')).toBeNull();
    expect(screen.queryByText('Manage keys')).toBeNull();
  });

  it('lets the page surface override the auto-derived profile name', async () => {
    setCsrfToken('test-csrf');
    const created = {
      ...storedProvider,
      id: '018f0000-0000-7000-8000-000000000103',
      name: 'Work account',
      model: 'remote-model',
      hasApiKey: true,
    };
    let createPayload: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/providers') && method === 'POST') {
          createPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return jsonResponse(created);
        }
        if (url.endsWith(`/providers/${created.id}/models`)) return jsonResponse({ models: [] });
        if (url.endsWith('/settings') && method === 'PATCH') return jsonResponse(defaultSettings);
        if (url.endsWith('/providers')) return jsonResponse({ items: [created] });
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    await renderEditor(<ProviderProfileEditor surface="page" />, {
      providers: [],
      settings: { ...defaultSettings, activeProviderConfigId: null },
    });
    // Page surface exposes the optional Name field, pre-filled via placeholder.
    const nameInput = await screen.findByLabelText('Name');
    expect(nameInput).toHaveAttribute('placeholder', 'Custom OpenAI-compatible');
    await userEvent.type(nameInput, 'Work account');
    await userEvent.type(screen.getByLabelText('Base URL'), 'https://example.test/v1');
    await userEvent.type(screen.getByLabelText('Model'), 'remote-model');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());
    expect(createPayload).toMatchObject({ name: 'Work account', model: 'remote-model' });
  });

  it('filters the source list by the top-level API mode (Chat vs Text)', async () => {
    await renderEditor(<ProviderProfileEditor />, {
      providers: [],
      settings: { ...defaultSettings, activeProviderConfigId: null },
      catalog: [catalogEntry, textCatalogEntry],
    });

    // The top-level API selector defaults to Chat Completions.
    const apiSelect = await screen.findByLabelText('API');
    expect(apiSelect).toHaveValue('chat');

    // Only chat sources are offered while API = Chat Completions.
    const chatSource = screen.getByLabelText('Provider source');
    expect(within(chatSource).getByText('Custom OpenAI-compatible')).toBeInTheDocument();
    expect(within(chatSource).queryByText('Custom text completion')).toBeNull();

    // Switching the API repopulates the source list with text sources only and
    // resets the selected source to the first text source (SillyTavern main_api).
    await userEvent.selectOptions(apiSelect, 'text');
    expect(screen.getByLabelText('API')).toHaveValue('text');
    const textSource = screen.getByLabelText('Provider source');
    expect(within(textSource).getByText('Custom text completion')).toBeInTheDocument();
    expect(within(textSource).queryByText('Custom OpenAI-compatible')).toBeNull();
  });
});

describe('GenerationPresetEditor', () => {
  it('derives enabled sampler controls from the active provider capabilities', async () => {
    await renderEditor(<GenerationPresetEditor />);
    expect(await screen.findByRole('slider', { name: 'Temperature' })).toBeEnabled();
    expect(screen.getByRole('slider', { name: 'Top P' })).toBeEnabled();
    expect(screen.getByRole('slider', { name: 'Min P' })).toBeDisabled();
    expect(screen.queryByRole('switch', { name: 'Request model reasoning' })).toBeNull();
  });

  it('enables NanoGPT samplers and exposes only accepted reasoning efforts', async () => {
    const nanoProvider: ProviderConfig = {
      ...storedProvider,
      name: 'NanoGPT',
      baseUrl: requiredKeyCatalogEntry.defaultBaseUrl,
      settings: { source: 'nanogpt' },
    };
    await renderEditor(<GenerationPresetEditor />, {
      providers: [nanoProvider],
      catalog: [requiredKeyCatalogEntry],
    });

    for (const name of [
      'Top K',
      'Min P',
      'Top A',
      'Repetition penalty',
      'Frequency penalty',
      'Presence penalty',
      'Seed',
    ]) {
      expect(await screen.findByRole('slider', { name })).toBeEnabled();
    }
    const effort = screen.getByLabelText('Reasoning effort');
    expect(Array.from((effort as HTMLSelectElement).options, (option) => option.value)).toEqual([
      '',
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('offers the full OpenAI-compatible effort superset without a fake reasoning toggle', async () => {
    const extendedProvider: ProviderConfig = {
      ...storedProvider,
      settings: { source: 'openai-compatible', samplerCompatibility: 'extended' },
    };
    await renderEditor(<GenerationPresetEditor />, {
      providers: [extendedProvider],
      catalog: [
        {
          ...catalogEntry,
          samplerSupport: [...catalogEntry.samplerSupport, 'reasoningEffort'],
        },
      ],
    });

    expect(screen.queryByRole('switch', { name: 'Request model reasoning' })).toBeNull();
    const effort = await screen.findByLabelText('Reasoning effort');
    expect(Array.from((effort as HTMLSelectElement).options, (option) => option.value)).toEqual([
      '',
      ...ReasoningEfforts,
    ]);
    expect(effort).toHaveValue('');
    await userEvent.selectOptions(effort, 'xhigh');
    expect(effort).toHaveValue('xhigh');
  });

  it('keeps the explicit reasoning switch and valid effort levels for Anthropic', async () => {
    const anthropicProvider: ProviderConfig = {
      ...storedProvider,
      kind: 'anthropic',
      settings: { source: 'anthropic' },
    };
    const anthropicCatalog: ProviderCatalogEntry = {
      id: 'anthropic',
      adapterKind: 'anthropic',
      defaultBaseUrl: null,
      apiKeyRequired: true,
      baseUrlEditable: false,
      samplerSupport: ['reasoning', 'reasoningEffort'],
      reasoningEfforts: ['low', 'medium', 'high'],
    };
    await renderEditor(<GenerationPresetEditor />, {
      providers: [anthropicProvider],
      catalog: [anthropicCatalog],
    });

    expect(await screen.findByRole('switch', { name: 'Request model reasoning' })).toBeEnabled();
    const effort = screen.getByLabelText('Reasoning effort');
    expect(Array.from((effort as HTMLSelectElement).options, (option) => option.value)).toEqual([
      '',
      'low',
      'medium',
      'high',
    ]);
  });
});

describe('PromptTemplateEditor', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/settings') && init?.method === 'PATCH') {
          const update = JSON.parse(String(init.body)) as Partial<AppSettings>;
          return jsonResponse({ ...defaultSettings, ...update });
        }
        throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
      }),
    );
  });

  it('places the include toggle before the name and autosaves without footer actions', async () => {
    await renderEditor(<PromptTemplateEditor />);
    const name = screen.getByRole('button', { name: /^Main Prompt$/ });
    const row = name.closest('li');
    if (!row) throw new Error('Main Prompt row was not rendered');
    const buttons = within(row).getAllByRole('button');

    expect(
      buttons.indexOf(screen.getByRole('button', { name: 'Disable Main Prompt' })),
    ).toBeLessThan(buttons.indexOf(name));
    expect(screen.queryByRole('button', { name: 'Apply changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset block order' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Disable Main Prompt' }));
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        expect.stringMatching(/\/settings$/),
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
  });

  it('reorders blocks immediately while dragging the dedicated handle', async () => {
    const { container } = await renderEditor(<PromptTemplateEditor />);
    const list = container.querySelector<HTMLElement>('[data-part="prompt-block-list"]');
    if (!list) throw new Error('Prompt block list was not rendered');
    const labels = (): string[] =>
      within(list)
        .getAllByRole('strong')
        .map((element) => element.textContent ?? '');
    const rows = (): HTMLElement[] => within(list).getAllByRole('listitem');
    const handle = screen.getByRole('button', { name: 'Drag Main Prompt' });
    let targetRowIndex = 1;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => rows()[targetRowIndex] ?? null),
    });

    fireEvent.mouseDown(handle, { button: 0 });
    fireEvent.mouseMove(document, { clientX: 10, clientY: 10 });
    expect(labels().slice(0, 2)).toEqual(['World Info (before)', 'Main Prompt']);

    targetRowIndex = 2;
    fireEvent.mouseMove(document, { clientX: 10, clientY: 20 });
    expect(labels().slice(0, 3)).toEqual(['World Info (before)', 'Persona', 'Main Prompt']);

    fireEvent.mouseUp(document);
    expect(screen.getByText('Main Prompt moved to position 3.')).toBeInTheDocument();
  });

  it('uses the same stable block identity for touch dragging', async () => {
    const { container } = await renderEditor(<PromptTemplateEditor />);
    const list = container.querySelector<HTMLElement>('[data-part="prompt-block-list"]');
    if (!list) throw new Error('Prompt block list was not rendered');
    const labels = (): string[] =>
      within(list)
        .getAllByRole('strong')
        .map((element) => element.textContent ?? '');
    const rows = (): HTMLElement[] => within(list).getAllByRole('listitem');
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => rows()[1] ?? null),
    });
    const handle = screen.getByRole('button', { name: 'Drag Main Prompt' });
    const touch = { identifier: 7, clientX: 10, clientY: 10 };

    fireEvent.touchStart(handle, { changedTouches: [touch], touches: [touch] });
    fireEvent.touchMove(document, { changedTouches: [touch], touches: [touch] });
    expect(labels().slice(0, 2)).toEqual(['World Info (before)', 'Main Prompt']);
    fireEvent.touchEnd(document, { changedTouches: [touch], touches: [] });
    expect(screen.getByText('Main Prompt moved to position 2.')).toBeInTheDocument();
  });

  it('keeps Chat History penultimate and Post-History Instructions last', async () => {
    const misplaced = {
      ...DEFAULT_PROMPT_TEMPLATE,
      blocks: [
        DEFAULT_PROMPT_TEMPLATE.blocks.find((block) => block.id === 'chat-history'),
        ...DEFAULT_PROMPT_TEMPLATE.blocks.filter(
          (block) => block.id !== 'chat-history' && block.id !== 'post-history-instructions',
        ),
        DEFAULT_PROMPT_TEMPLATE.blocks.find((block) => block.id === 'post-history-instructions'),
      ].filter((block) => block !== undefined),
    };
    const { container } = await renderEditor(<PromptTemplateEditor />, {
      settings: { ...defaultSettings, promptTemplate: misplaced },
    });
    const list = container.querySelector<HTMLElement>('[data-part="prompt-block-list"]');
    if (!list) throw new Error('Prompt block list was not rendered');
    const labels = within(list)
      .getAllByRole('strong')
      .map((element) => element.textContent ?? '');

    expect(labels.slice(-2)).toEqual(['Chat History', 'Post-History Instructions']);
    expect(
      screen.getByRole('button', { name: 'Chat History has a fixed terminal position' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', {
        name: 'Post-History Instructions has a fixed terminal position',
      }),
    ).toBeDisabled();
  });

  it('reorders blocks with keyboard-accessible controls and announces the move', async () => {
    const { container } = await renderEditor(<PromptTemplateEditor />);
    const list = container.querySelector<HTMLElement>('[data-part="prompt-block-list"]');
    if (!list) throw new Error('Prompt block list was not rendered');
    const labels = (): string[] =>
      within(list)
        .getAllByRole('strong')
        .map((element) => element.textContent ?? '');
    expect(labels().slice(0, 2)).toEqual(['Main Prompt', 'World Info (before)']);

    await userEvent.click(screen.getByRole('button', { name: 'Move Main Prompt down' }));
    expect(labels().slice(0, 2)).toEqual(['World Info (before)', 'Main Prompt']);
    expect(screen.getByText('Main Prompt moved to position 2.')).toBeInTheDocument();
  });

  it('edits the main prompt in an ST1-style modal and keeps the draft in the manager', async () => {
    const legacyPromptTemplate = {
      ...DEFAULT_PROMPT_TEMPLATE,
      blocks: DEFAULT_PROMPT_TEMPLATE.blocks.map((block) => ({
        id: block.id,
        enabled: block.enabled,
      })),
    };
    setCsrfToken('test-csrf');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/providers/${storedProvider.id}/models`)) {
          return jsonResponse({
            models: [
              { id: 'gpt-4o', name: 'GPT-4o', contextLimit: 32768 },
              { id: 'echo', name: 'Echo (offline)' },
            ],
          });
        }
        return jsonResponse({});
      }),
    );
    await renderEditor(<PromptTemplateEditor />, {
      settings: { ...defaultSettings, promptTemplate: legacyPromptTemplate },
    });
    const mainPromptButton = screen.getByRole('button', { name: /^Main Prompt$/ });
    const mainPromptRow = mainPromptButton.closest('li');
    expect(mainPromptRow?.querySelector('output')).toHaveTextContent(/^\d+$/);
    expect(mainPromptRow?.querySelector('output')).not.toHaveTextContent('—');
    await userEvent.click(mainPromptButton);

    const dialog = await screen.findByRole('dialog', { name: 'Edit prompt' });
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Main Prompt');
    expect(within(dialog).getByLabelText('Role')).toHaveValue('system');
    expect(within(dialog).getByLabelText('Position')).toHaveValue('relative');
    const content = within(dialog).getByLabelText('Prompt');
    expect(content).toHaveValue(
      "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
    );
    await userEvent.clear(content);
    await userEvent.type(content, 'Keep replies concise.');

    // Bind the block to a model from the active provider (Load → pick).
    const modelMenu = within(dialog).getByLabelText('Model');
    expect(modelMenu).toHaveValue('');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Load models' }));
    await userEvent.click(modelMenu);
    // Combobox options render in a Radix portal (document.body), outside the dialog.
    await userEvent.click(await screen.findByRole('option', { name: /GPT-4o/ }));
    // Closed combobox mirrors the picked option label; the id is committed.
    expect(modelMenu).toHaveValue(`GPT-4o (${(32768).toLocaleString()})`);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(screen.queryByRole('dialog', { name: 'Edit prompt' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^Main Prompt$/ }));
    expect(await screen.findByLabelText('Prompt')).toHaveValue('Keep replies concise.');
    // The binding survived: closed menu mirrors the label, focus re-seeds the id.
    expect(screen.getByLabelText('Model')).toHaveValue(`GPT-4o (${(32768).toLocaleString()})`);
    await userEvent.click(screen.getByLabelText('Model'));
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('gpt-4o');
  });

  it('shows dynamic host content as a sourced, read-only prompt marker', async () => {
    await renderEditor(<PromptTemplateEditor />);
    await userEvent.click(screen.getByRole('button', { name: /^Scenario$/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit prompt' });
    expect(
      within(dialog).getByText(
        'The content of this prompt is pulled from elsewhere and cannot be edited here.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Source: Character Scenario/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Prompt')).toBeNull();
  });

  it('adds a custom prompt with role, triggers, and editable content', async () => {
    await renderEditor(<PromptTemplateEditor />);
    await userEvent.click(screen.getByRole('button', { name: 'Add prompt' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit prompt' });
    const name = within(dialog).getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Emotion cue');
    await userEvent.selectOptions(within(dialog).getByLabelText('Role'), 'assistant');
    await userEvent.clear(within(dialog).getByLabelText('Prompt'));
    await userEvent.type(within(dialog).getByLabelText('Prompt'), 'Answer with visible tension.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(screen.getByRole('button', { name: /^Emotion cue$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable Emotion cue' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('rejects incomplete imports and keeps accessible labels in pseudo-locale and RTL', async () => {
    const { i18n } = await renderEditor(<PromptTemplateEditor />, { language: 'pseudo' });
    const input = screen.getByLabelText(/Import prompt template preset/);
    const invalid = new File(
      [
        JSON.stringify({
          ...DEFAULT_PROMPT_TEMPLATE,
          blocks: DEFAULT_PROMPT_TEMPLATE.blocks.slice(1),
        }),
      ],
      'incomplete.json',
      { type: 'application/json' },
    );
    Object.defineProperty(invalid, 'text', {
      value: async () =>
        JSON.stringify({
          ...DEFAULT_PROMPT_TEMPLATE,
          blocks: DEFAULT_PROMPT_TEMPLATE.blocks.slice(1),
        }),
    });
    await userEvent.upload(input, invalid);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This file is not a valid prompt template preset.',
    );
    const pseudoMoveButton = screen
      .getAllByRole('button')
      .find(
        (button) =>
          button.getAttribute('title')?.includes('Main Prompt') &&
          button.getAttribute('title')?.includes('down'),
      );
    expect(pseudoMoveButton).toHaveAccessibleName();

    await i18n.changeLanguage('ar');
    setDocumentLanguage('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(
      await screen.findByRole('button', { name: 'Move Main Prompt down' }),
    ).toBeInTheDocument();
  });
});
