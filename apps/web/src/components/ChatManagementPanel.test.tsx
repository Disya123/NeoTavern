/**
 * ChatManagementPanel (sidebar chat manager) component tests. The API client is
 * backed by global fetch, so a URL router stub drives every hook (AGENTS.md §23).
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLocation } from 'react-router-dom';
import { jsonResponse, renderWithProviders } from '../../test/helpers.js';
import { ChatManagementPanel } from './ChatManagementPanel.js';

const CHARACTER_A = {
  id: '018f0000-0000-7000-8000-000000000001',
  name: 'Aurora',
  avatar: null,
  description: '',
  tags: [],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};
const CHARACTER_B = {
  id: '018f0000-0000-7000-8000-000000000002',
  name: 'Bastion',
  avatar: null,
  description: '',
  tags: [],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const CHAT_1 = {
  id: '018f0000-0000-7000-8000-000000000011',
  characterId: CHARACTER_A.id,
  title: 'First trip',
  messageCount: 3,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
};
const CHAT_2 = {
  id: '018f0000-0000-7000-8000-000000000022',
  characterId: CHARACTER_B.id,
  title: 'Spy stories',
  messageCount: 0,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_050_000,
};
const CHAT_3 = {
  id: '018f0000-0000-7000-8000-000000000033',
  characterId: CHARACTER_A.id,
  title: 'Second trip',
  messageCount: 2,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_025_000,
};

interface Route {
  method: string;
  match: RegExp;
  body: unknown;
}

let calls: Array<{ method: string; url: string; body: unknown }> = [];
let routes: Route[] = [];

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-probe">{location.pathname}</output>;
}

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

async function renderPanel(
  initialEntries: string[] = ['/'],
): Promise<ReturnType<typeof userEvent.setup>> {
  calls = [];
  routes = [
    {
      method: 'GET',
      match: /\/api\/v2\/characters\?sort=used&limit=50$/,
      body: { items: [CHARACTER_A, CHARACTER_B], nextCursor: null, hasMore: false },
    },
    {
      method: 'GET',
      match: /\/api\/v2\/chats\?characterId=([^&]+)$/,
      body: { items: [CHAT_1, CHAT_3], nextCursor: null, hasMore: false },
    },
    {
      method: 'GET',
      match: /\/api\/v2\/chats\?q=[^&]+$/,
      body: { items: [CHAT_2], nextCursor: null, hasMore: false },
    },
    {
      method: 'GET',
      match: /\/api\/v2\/chats$/,
      body: { items: [CHAT_1, CHAT_2], nextCursor: null, hasMore: false },
    },
    {
      method: 'GET',
      match: /\/api\/v2\/chats\/018f0000-0000-7000-8000-000000000011$/,
      body: CHAT_1,
    },
    { method: 'PUT', match: /\/api\/v2\/chats\/order$/, body: { reordered: 2 } },
    {
      method: 'POST',
      match: /\/api\/v2\/chats$/,
      body: { ...CHAT_1, id: '018f0000-0000-7000-8000-0000000000ff' },
    },
    {
      method: 'GET',
      match: /\/api\/v2\/chats\/018f0000-0000-7000-8000-0000000000ff$/,
      body: { ...CHAT_1, id: '018f0000-0000-7000-8000-0000000000ff', title: 'New conversation' },
    },
    { method: 'PATCH', match: /\/api\/v2\/chats\/[^/]+$/, body: { ...CHAT_1, title: 'Renamed' } },
    { method: 'DELETE', match: /\/api\/v2\/chats\/[^/]+$/, body: { ok: true } },
  ];
  vi.stubGlobal('fetch', vi.fn(router));

  const user = userEvent.setup();
  await renderWithProviders(
    <>
      <LocationProbe />
      <ChatManagementPanel onClose={() => {}} />
    </>,
    { initialEntries },
  );
  await screen.findByText('First trip');
  return user;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ChatManagementPanel', () => {
  it('renders chat rows with title and message count', async () => {
    await renderPanel();
    expect(screen.getByText('First trip')).toBeVisible();
    expect(screen.getByText('Spy stories')).toBeVisible();
    // 3 messages via the chat namespace plural.
    expect(screen.getByText(/3 messages/)).toBeVisible();
  });

  it('keeps the current character context without rendering a character filter', async () => {
    await renderPanel([`/chats/${CHAT_1.id}`]);
    expect(screen.queryByLabelText('Filter by character')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('First trip')).toBeVisible();
      expect(screen.queryByText('Spy stories')).not.toBeInTheDocument();
      const scoped = calls.find(
        (call) => call.method === 'GET' && call.url.includes('characterId='),
      );
      expect(scoped?.url).toContain(`characterId=${CHARACTER_A.id}`);
    });
  });

  it('reorders chats while dragging the whole row', async () => {
    await renderPanel([`/chats/${CHAT_1.id}`]);
    const list = document.querySelector<HTMLElement>('[data-part="chat-list"]');
    if (!list) throw new Error('Chat list was not rendered');
    const labels = (): string[] =>
      within(list)
        .getAllByRole('strong')
        .map((element) => element.textContent ?? '');
    const rows = (): HTMLElement[] => within(list).getAllByRole('listitem');
    const chatRow = rows()[0]?.querySelector<HTMLElement>('[data-component="chat-item"]');
    if (!chatRow) throw new Error('Chat row was not rendered');
    await waitFor(() => expect(chatRow).toHaveAttribute('data-reorderable', 'true'));
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => rows()[1] ?? null),
    });

    fireEvent.mouseDown(chatRow, { button: 0 });
    fireEvent.mouseMove(document, { clientX: 10, clientY: 10 });
    expect(labels().slice(0, 2)).toEqual(['Second trip', 'First trip']);
    fireEvent.mouseUp(document);

    await waitFor(() => {
      const put = calls.find((call) => call.method === 'PUT');
      expect(put?.body).toEqual({
        characterId: CHARACTER_A.id,
        order: [CHAT_3.id, CHAT_1.id],
      });
    });
  });

  it('supports dragging the whole row on touch devices', async () => {
    await renderPanel([`/chats/${CHAT_1.id}`]);
    const list = document.querySelector<HTMLElement>('[data-part="chat-list"]');
    if (!list) throw new Error('Chat list was not rendered');
    const labels = (): string[] =>
      within(list)
        .getAllByRole('strong')
        .map((element) => element.textContent ?? '');
    const rows = (): HTMLElement[] => within(list).getAllByRole('listitem');
    const chatRow = rows()[0]?.querySelector<HTMLElement>('[data-component="chat-item"]');
    if (!chatRow) throw new Error('Chat row was not rendered');
    await waitFor(() => expect(chatRow).toHaveAttribute('data-reorderable', 'true'));
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => rows()[1] ?? null),
    });
    const touch = { identifier: 7, clientX: 10, clientY: 10 };

    fireEvent.touchStart(chatRow, { changedTouches: [touch], touches: [touch] });
    fireEvent.touchMove(document, {
      changedTouches: [{ ...touch, clientX: 30, clientY: 30 }],
      touches: [{ ...touch, clientX: 30, clientY: 30 }],
    });
    expect(labels().slice(0, 2)).toEqual(['Second trip', 'First trip']);
    fireEvent.touchEnd(document, { changedTouches: [touch], touches: [] });

    await waitFor(() => {
      const put = calls.find((call) => call.method === 'PUT');
      expect(put?.body).toEqual({
        characterId: CHARACTER_A.id,
        order: [CHAT_3.id, CHAT_1.id],
      });
    });
  });

  it('opens the chat context menu after a stationary touch hold', async () => {
    await renderPanel([`/chats/${CHAT_1.id}`]);
    const chatRow = screen
      .getByText('First trip')
      .closest<HTMLElement>('[data-component="chat-item"]');
    if (!chatRow) throw new Error('Chat row was not rendered');
    const touch = { identifier: 9, clientX: 24, clientY: 40 };
    vi.useFakeTimers();

    fireEvent.touchStart(chatRow, { changedTouches: [touch], touches: [touch] });
    fireEvent.touchMove(document, {
      changedTouches: [{ ...touch, clientX: 30, clientY: 46 }],
      touches: [{ ...touch, clientX: 30, clientY: 46 }],
    });
    act(() => vi.advanceTimersByTime(700));
    fireEvent.touchMove(document, {
      changedTouches: [{ ...touch, clientX: 34, clientY: 48 }],
      touches: [{ ...touch, clientX: 34, clientY: 48 }],
    });

    expect(screen.getByText('Rename')).toBeVisible();
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    fireEvent.touchEnd(document, { changedTouches: [touch], touches: [] });
  });

  it('searches titles and message content via the q parameter', async () => {
    await renderPanel();
    const search = screen.getByPlaceholderText('Search chats and messages…');
    fireEvent.change(search, { target: { value: 'kumquat' } });
    await waitFor(() => {
      const hit = calls.find((call) => call.method === 'GET' && call.url.includes('q='));
      expect(hit?.url).toContain('q=kumquat');
    });
  });

  it('creates a chat for the current context and opens it', async () => {
    await renderPanel();
    const newChat = screen.getByRole('button', { name: 'New chat' });
    const header = document.querySelector('[data-part="chat-management-header"]');
    const actions = document.querySelector('[data-part="chat-actions"]');
    expect(header).not.toContainElement(newChat);
    expect(actions).toContainElement(newChat);
    await userEvent.click(newChat);
    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST');
      expect(post?.url).toContain('/api/v2/chats');
      expect(post?.body).toEqual({
        characterId: null,
        title: 'New conversation',
        reuseUnstarted: true,
      });
      expect(screen.getByTestId('location-probe')).toHaveTextContent(
        '/chats/018f0000-0000-7000-8000-0000000000ff',
      );
    });
  });

  it('renames a chat from the context menu', async () => {
    await renderPanel();
    const row = screen.getByText('First trip').closest('[data-component="chat-item"]');
    if (!row) throw new Error('chat row not found');
    fireEvent.contextMenu(row);

    await userEvent.click(await screen.findByText('Rename'));
    const input = screen.getByLabelText('Chat title');
    await userEvent.clear(input);
    await userEvent.type(input, 'Renamed');
    await userEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH');
      expect(patch?.url).toContain('/api/v2/chats/018f0000-0000-7000-8000-000000000011');
      expect(patch?.body).toEqual({ title: 'Renamed' });
    });
  });

  it('deletes a chat after confirmation', async () => {
    await renderPanel();
    const row = screen.getByText('Spy stories').closest('[data-component="chat-item"]');
    if (!row) throw new Error('chat row not found');
    fireEvent.contextMenu(row);

    await userEvent.click(await screen.findByText('Delete'));
    expect(await screen.findByText('Delete chat')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      const del = calls.find((call) => call.method === 'DELETE');
      expect(del?.url).toContain('/api/v2/chats/018f0000-0000-7000-8000-000000000022');
    });
  });
});
