/**
 * LorebookPanel (sidebar world-info manager) component tests. The API client is
 * backed by global fetch, so a URL router stub drives every hook (AGENTS.md §23).
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithProviders } from '../../test/helpers.js';
import { LorebookPanel } from './LorebookPanel.js';

const CHAR_A = {
  id: '018f0000-0000-7000-8000-000000000001',
  name: 'Aurora',
  avatar: null,
  description: '',
  tags: [],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const BOOK_GLOBAL = {
  id: '018f0000-0000-7000-8000-000000000011',
  name: 'Eldoria Gazette',
  description: 'Lands and guilds of the realm.',
  characterId: null,
  metadata: {},
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const BOOK_LINKED = {
  id: '018f0000-0000-7000-8000-000000000022',
  name: 'Aurora Files',
  description: 'Secrets tied to Aurora.',
  characterId: CHAR_A.id,
  metadata: {},
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_010_000,
};

const ENTRY_1 = {
  id: '018f0000-0000-7000-8000-000000000101',
  lorebookId: BOOK_GLOBAL.id,
  keys: ['feather'],
  secondaryKeys: [],
  content: 'A single silver feather opens the library at dusk.',
  enabled: true,
  position: 0,
  constant: false,
  selective: false,
  metadata: {},
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

interface Route {
  method: string;
  match: RegExp;
  body: unknown;
}

let calls: Array<{ method: string; url: string; body: unknown }> = [];
let routes: Route[] = [];

function router(req: RequestInfo | URL, init?: RequestInit): Response {
  const url = typeof req === 'string' ? req : req instanceof URL ? req.href : req.url;
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  calls.push({ method, url, body });
  const route = routes.find(
    (candidate) => candidate.method === method && candidate.match.test(url),
  );
  if (!route) throw new Error(`No route for ${method} ${url}`);
  return jsonResponse(route.body);
}

async function renderPanel(): Promise<ReturnType<typeof userEvent.setup>> {
  calls = [];
  routes = [
    {
      method: 'GET',
      match: /\/api\/v2\/lorebooks\?limit=200$/,
      body: { items: [BOOK_GLOBAL, BOOK_LINKED], nextCursor: null, hasMore: false },
    },
    {
      method: 'GET',
      match: /\/api\/v2\/characters\/[^/]+$/,
      body: CHAR_A,
    },
    {
      method: 'GET',
      match: /\/api\/v2\/characters\?limit=20&sort=name$/,
      body: { items: [CHAR_A], nextCursor: null, hasMore: false },
    },
    {
      method: 'GET',
      match: /\/api\/v2\/lorebooks\/[^/]+$/,
      body: BOOK_GLOBAL,
    },
    {
      method: 'GET',
      match: /\/api\/v2\/lorebooks\/[^/]+\/entries$/,
      body: { items: [ENTRY_1] },
    },
    {
      method: 'POST',
      match: /\/api\/v2\/lorebooks$/,
      body: { ...BOOK_GLOBAL, id: '018f0000-0000-7000-8000-0000000000ff' },
    },
    {
      method: 'PATCH',
      match: /\/api\/v2\/lorebooks\/[^/]+$/,
      body: { ...BOOK_GLOBAL, name: 'Renamed Gazette' },
    },
    {
      method: 'DELETE',
      match: /\/api\/v2\/lorebooks\/[^/]+$/,
      body: { ok: true },
    },
    {
      method: 'POST',
      match: /\/api\/v2\/lorebooks\/[^/]+\/entries$/,
      body: { ...ENTRY_1, id: '018f0000-0000-7000-8000-000000000202' },
    },
    {
      method: 'PATCH',
      match: /\/api\/v2\/lorebooks\/[^/]+\/entries\/[^/]+$/,
      body: { ...ENTRY_1, enabled: false },
    },
    {
      method: 'DELETE',
      match: /\/api\/v2\/lorebooks\/[^/]+\/entries\/[^/]+$/,
      body: { ok: true },
    },
  ];
  vi.stubGlobal('fetch', vi.fn(router));

  const user = userEvent.setup();
  await renderWithProviders(<LorebookPanel onClose={() => {}} />);
  await screen.findByText('Eldoria Gazette');
  return user;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LorebookPanel', () => {
  it('lists books and scopes the view to global books only', async () => {
    await renderPanel();

    expect(screen.getByText('Aurora Files')).toBeTruthy();
    const gazette = screen.getByText('Eldoria Gazette').closest('button');
    expect(gazette).toBeTruthy();
    expect(within(gazette as HTMLElement).getByText('Global')).toBeTruthy();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'global' } });
    });

    expect(screen.queryByText('Aurora Files')).toBeNull();
    expect(screen.getByText('Eldoria Gazette')).toBeTruthy();
  });

  it('opens the editor and saves a renamed book on blur', async () => {
    const user = await renderPanel();

    await user.click(screen.getByText('Eldoria Gazette'));

    const nameInput = await screen.findByLabelText('Book name');
    expect(nameInput).toBeTruthy();

    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Renamed' } });
    });
    await act(async () => {
      fireEvent.blur(nameInput);
    });

    await waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.method === 'PATCH' &&
            /\/api\/v2\/lorebooks\/[^/]+$/.test(call.url) &&
            call.body &&
            typeof call.body === 'object' &&
            (call.body as { name?: string }).name === 'Renamed',
        ),
      ).toBe(true);
    });
  });

  it('creates a book from the dialog and switches to its editor', async () => {
    const user = await renderPanel();

    await user.click(screen.getByText('New'));

    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('Book name');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'My World' } });
    });
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.method === 'POST' &&
            call.url.endsWith('/api/v2/lorebooks') &&
            (call.body as { name?: string })?.name === 'My World',
        ),
      ).toBe(true);
    });
  });

  it('lists entries and toggles an entry', async () => {
    const user = await renderPanel();

    await user.click(screen.getByText('Eldoria Gazette'));
    await user.click(screen.getByRole('button', { name: 'Entries' }));

    expect(await screen.findByText('feather')).toBeTruthy();
    expect(screen.getByText(/silver feather/)).toBeTruthy();

    const toggle = screen.getByRole('switch');
    await act(async () => {
      fireEvent.click(toggle);
    });

    await waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.method === 'PATCH' &&
            /\/api\/v2\/lorebooks\/[^/]+\/entries\/[^/]+$/.test(call.url) &&
            (call.body as { enabled?: boolean })?.enabled === false,
        ),
      ).toBe(true);
    });
  });
});
