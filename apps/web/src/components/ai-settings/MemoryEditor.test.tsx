import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Memory } from '@neotavern/contracts';
import { createI18n } from '@neotavern/i18n';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '../../../test/helpers.js';
import { setCsrfToken } from '../../api/client.js';
import { MemoryEditor } from './MemoryEditor.js';

const MEMORY: Memory = {
  id: '018f0000-0000-7000-8000-000000000201',
  scope: 'global',
  characterId: null,
  keys: ['city'],
  content: 'The city sleeps.',
  enabled: true,
  position: 0,
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
};

async function renderEditor() {
  const i18n = await createI18n({ language: 'en' });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(['memories'], { items: [MEMORY] });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryEditor />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

describe('MemoryEditor', () => {
  it('lists memories and creates a new global memory through the API', async () => {
    setCsrfToken('test-csrf');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const created: Memory = {
      ...MEMORY,
      id: '018f0000-0000-7000-8000-000000000202',
      keys: ['sword'],
      content: 'The sword is on the shelf.',
      updatedAt: 2,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        const method = init?.method ?? 'GET';
        if (url.endsWith('/memories') && method === 'GET') {
          return jsonResponse({ items: [MEMORY] });
        }
        if (url.endsWith('/memories') && method === 'POST') {
          return jsonResponse(created);
        }
        if (url.endsWith('/characters')) return jsonResponse({ items: [], nextCursor: null });
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    await renderEditor();
    expect(await screen.findByText('The city sleeps.')).toBeInTheDocument();
    expect(screen.getByText('Global — city')).toBeInTheDocument();

    const contentInput = screen.getByLabelText('Content');
    await userEvent.clear(contentInput);
    await userEvent.type(contentInput, 'The sword is on the shelf.');
    const keysInput = screen.getByLabelText('Keys (comma-separated)');
    await userEvent.type(keysInput, 'sword');
    await userEvent.click(screen.getByRole('button', { name: 'Add memory' }));

    await waitFor(() => {
      const post = calls.find(
        (call) => call.url.endsWith('/memories') && call.init?.method === 'POST',
      );
      expect(post).toBeDefined();
      expect(JSON.parse(String(post?.init?.body))).toMatchObject({
        scope: 'global',
        keys: ['sword'],
        content: 'The sword is on the shelf.',
        enabled: true,
      });
    });
  });

  it('toggles a memory off through the API', async () => {
    setCsrfToken('test-csrf');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const disabled: Memory = { ...MEMORY, enabled: false, updatedAt: 2 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        const method = init?.method ?? 'GET';
        if (url.endsWith('/memories') && method === 'GET') return jsonResponse({ items: [MEMORY] });
        if (url.endsWith(`/memories/${MEMORY.id}`) && method === 'PATCH') {
          return jsonResponse(disabled);
        }
        if (url.endsWith('/characters')) return jsonResponse({ items: [], nextCursor: null });
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    await renderEditor();
    await screen.findByText('The city sleeps.');
    const card = screen.getByText('The city sleeps.').closest('li');
    expect(card).not.toBeNull();
    const toggle = within(card as HTMLElement).getByRole('switch', { name: 'Enabled' });
    await userEvent.click(toggle);
    await waitFor(() => {
      const patch = calls.find(
        (call) => call.url.endsWith(`/memories/${MEMORY.id}`) && call.init?.method === 'PATCH',
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(String(patch?.init?.body))).toEqual({ enabled: false });
    });
  });
});
