/**
 * BackgroundsPanel (sidebar chat-wallpaper manager) tests. The API client is
 * backed by global fetch, so a URL/call router stub drives every hook; the
 * open chat path is simulated via `initialEntries` (AGENTS.md §23).
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithProviders } from '../../test/helpers.js';
import { BackgroundsPanel } from './BackgroundsPanel.js';

const CHAT_ID = '018f0000-0000-7000-8000-000000000101';

const BG_WALL = {
  id: 'wall-of-storms.webp',
  name: 'wall-of-storms.webp',
  originalUrl: '/api/v2/assets/backgrounds/wall-of-storms.webp',
  thumbnailUrl: '/api/v2/assets/thumbnails/thumb-wall.webp',
  sizeBytes: 1048576,
  createdAt: 1_700_000_000_000,
};

const BG_SKY = {
  id: 'sky-glow.png',
  name: 'sky-glow.png',
  originalUrl: '/api/v2/assets/backgrounds/sky-glow.png',
  thumbnailUrl: '/api/v2/assets/thumbnails/thumb-sky.webp',
  sizeBytes: 524288,
  createdAt: 1_700_000_010_000,
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

interface ChatState {
  id: string;
  title: string;
  characterId: string | null;
  backgroundId: string | null;
}

let calls: Call[] = [];
let chat: ChatState;
let items: (typeof BG_WALL)[] = [];

function router(req: RequestInfo | URL, init?: RequestInit): Response {
  const url = typeof req === 'string' ? req : req instanceof URL ? req.href : req.url;
  const method = init?.method ?? 'GET';
  const text = typeof init?.body === 'string' ? init.body : undefined;
  const body = text ? (JSON.parse(text) as unknown) : undefined;
  calls.push({ method, url, body });

  if (method === 'GET' && /\/api\/v2\/chats\/[^/]+$/.test(url)) {
    return jsonResponse(chat);
  }
  if (method === 'PATCH' && /\/api\/v2\/chats\/[^/]+$/.test(url)) {
    const update = body as { backgroundId?: string | null };
    chat = { ...chat, backgroundId: update.backgroundId ?? null };
    return jsonResponse(chat);
  }
  if (method === 'GET' && /\/api\/v2\/backgrounds$/.test(url)) {
    return jsonResponse({ items });
  }
  if (method === 'DELETE' && /\/api\/v2\/backgrounds\/[^/]+$/.test(url)) {
    items = items.filter(
      (item) => !url.endsWith(`/api/v2/backgrounds/${encodeURIComponent(item.id)}`),
    );
    return jsonResponse({ ok: true });
  }
  throw new Error(`No route for ${method} ${url}`);
}

async function renderPanel(
  initialEntries: string[] = [`/chats/${CHAT_ID}`],
  initialChat: ChatState = {
    id: CHAT_ID,
    title: 'Wallpaper chat',
    characterId: null,
    backgroundId: null,
  },
  catalogItems: Array<typeof BG_WALL> = [BG_SKY, BG_WALL],
): Promise<void> {
  calls = [];
  chat = initialChat;
  items = catalogItems;
  vi.stubGlobal('fetch', vi.fn(router));
  await renderWithProviders(<BackgroundsPanel onClose={() => {}} />, { initialEntries });
  await screen.findByText('Upload background');
  if (catalogItems.length > 0) {
    for (const item of catalogItems) {
      await screen.findByTitle(item.name);
      break;
    }
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BackgroundsPanel', () => {
  it('lists the background catalog with the newest item first', async () => {
    await renderPanel();

    const cards = screen.getAllByRole('button').filter((btn) => btn.hasAttribute('title'));
    expect(cards.map((card) => card.getAttribute('title'))).toMatchObject([
      'sky-glow.png',
      'wall-of-storms.webp',
    ]);
  });

  it('applies a background on click', async () => {
    const user = await renderPanelWithUser();

    const card = screen.getByTitle('sky-glow.png');
    await user.click(card);

    await waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.method === 'PATCH' &&
            call.url === `/api/v2/chats/${CHAT_ID}` &&
            (call.body as { backgroundId?: string }).backgroundId === BG_SKY.id,
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getAllByText('Applied').length).toBeGreaterThan(0);
    });
  });

  it('clears the wallpaper on clicking an applied background', async () => {
    const user = await renderPanelWithUser({
      id: CHAT_ID,
      title: 'Wallpaper chat',
      characterId: null,
      backgroundId: BG_WALL.id,
    });

    const card = screen.getByTitle('wall-of-storms.webp');
    await user.click(card);

    await waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.method === 'PATCH' &&
            call.url === `/api/v2/chats/${CHAT_ID}` &&
            (call.body as { backgroundId?: string | null }).backgroundId === null,
        ),
      ).toBe(true);
    });
  });

  it('deletes a background via context menu after confirmation', async () => {
    const user = await renderPanelWithUser();

    const card = screen.getByTitle('sky-glow.png');
    await user.pointer({ keys: '[MouseRight]', target: card });

    const deleteOption = await screen.findByText('Delete background');
    await user.click(deleteOption);

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('sky-glow.png');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.queryByTitle('sky-glow.png')).toBeNull();
    });
    expect(screen.getByTitle('wall-of-storms.webp')).toBeTruthy();
  });

  it('opens the card menu after a stationary touch hold', async () => {
    await renderPanel();
    const card = screen.getByTitle('sky-glow.png');
    const touch = { identifier: 12, clientX: 30, clientY: 40 };
    vi.useFakeTimers();

    fireEvent.touchStart(card, { changedTouches: [touch], touches: [touch] });
    expect(screen.queryByText('Delete background')).toBeNull();
    act(() => vi.advanceTimersByTime(700));
    expect(screen.getByText('Delete background')).toBeVisible();
    fireEvent.touchEnd(document, { changedTouches: [touch], touches: [] });
    vi.useRealTimers();
  });

  it('shows an empty state when the catalog has no backgrounds', async () => {
    await renderPanel(['/chats/other-chat'], undefined, []);

    expect(await screen.findByText('No backgrounds yet')).toBeTruthy();
  });
});

async function renderPanelWithUser(
  initialChat?: ChatState,
): Promise<ReturnType<typeof userEvent.setup>> {
  await renderPanel(undefined, initialChat);
  return userEvent.setup();
}
