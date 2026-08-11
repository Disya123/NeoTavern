/**
 * ApiKeysModal (multi-key secrets manager) component tests. The API client is
 * backed by global fetch, so a URL router stub drives every hook (AGENTS.md §23).
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithProviders } from '../../test/helpers.js';
import { ApiKeysModal } from './ApiKeysModal.js';

const PROVIDER_ID = '018f0000-0000-7000-8000-000000000aaa';

const ACTIVE = {
  id: 'secret-active',
  providerId: PROVIDER_ID,
  label: 'production',
  active: true,
  masked: '••••••••2222',
  createdAt: 1_700_000_000_000,
};
const INACTIVE = {
  id: 'secret-inactive',
  providerId: PROVIDER_ID,
  label: null,
  active: false,
  masked: '••••••••1111',
  createdAt: 1_700_000_001_000,
};

interface Route {
  method: string;
  match: RegExp;
  body: unknown;
}

/** Safe indexed access for `getAllBy*` results (strict noUncheckedIndexedAccess). */
function nth(elements: readonly HTMLElement[], index: number): HTMLElement {
  const element = elements[index];
  if (!element) throw new Error(`expected an element at index ${index}`);
  return element;
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

async function renderModal(exposure: boolean): Promise<ReturnType<typeof userEvent.setup>> {
  calls = [];
  routes = [
    {
      method: 'GET',
      match: /\/api\/v2\/secrets\/exposure$/,
      body: { allowSecretsExposure: exposure },
    },
    {
      method: 'GET',
      match: new RegExp(`/providers/${PROVIDER_ID}/secrets$`),
      body: { items: [ACTIVE, INACTIVE] },
    },
    {
      method: 'POST',
      match: new RegExp(`/providers/${PROVIDER_ID}/secrets$`),
      body: { id: 'secret-new' },
    },
    { method: 'PATCH', match: /\/secrets\/secret-inactive$/, body: { ...INACTIVE, active: true } },
    { method: 'PATCH', match: /\/secrets\/secret-active$/, body: { ...ACTIVE, label: 'renamed' } },
    { method: 'DELETE', match: /\/secrets\/secret-inactive$/, body: { ok: true } },
    {
      method: 'POST',
      match: /\/secrets\/secret-active\/reveal$/,
      body: { value: 'sk-plain-2222' },
    },
  ];
  vi.stubGlobal('fetch', vi.fn(router));

  const user = userEvent.setup();
  await renderWithProviders(
    <ApiKeysModal
      open
      onOpenChange={() => {}}
      providerId={PROVIDER_ID}
      providerName="Test Provider"
    />,
  );
  // Wait for the secrets list to load.
  await screen.findByText('••••••••2222');
  return user;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ApiKeysModal', () => {
  it('lists masked keys with an active badge and hides raw values', async () => {
    await renderModal(false);
    expect(screen.getByText('API keys · Test Provider')).toBeVisible();
    // Masked values appear both in the quick active-key select and in each card;
    // assert the cards through the secrets list to stay specific.
    const list = screen.getByRole('list');
    expect(within(list).getByText('••••••••2222')).toBeVisible();
    expect(within(list).getByText('••••••••1111')).toBeVisible();
    expect(within(list).getByText('production')).toBeVisible();
    // The quick select reflects the active secret and lists every key.
    const quickSelect = screen.getByLabelText('Active key');
    expect(quickSelect).toHaveValue('secret-active');
    expect(within(quickSelect).getByText('production · ••••••••2222')).toBeInTheDocument();
    expect(within(quickSelect).getByText('••••••••1111')).toBeInTheDocument();
    // Exposure hint is shown while reveal is disabled.
    expect(screen.getByText(/Copying and viewing keys is disabled/)).toBeVisible();
    // The inactive key offers activation; the active one does not.
    expect(screen.getByText('Make active')).toBeVisible();
  });

  it('creates a secret from the add form and posts the value', async () => {
    const user = await renderModal(false);
    await user.click(screen.getByText('Add secret'));

    const valueInput = screen.getByLabelText('Secret value (can be empty)');
    const labelInput = screen.getByLabelText('Label (optional)');
    await user.type(valueInput, 'sk-brand-new');
    await user.type(labelInput, 'staging');
    await user.click(screen.getByText('Save'));

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && /\/secrets$/.test(call.url));
      expect(post?.body).toEqual({ value: 'sk-brand-new', label: 'staging' });
    });
    // The form collapses after a successful create.
    await waitFor(() => expect(screen.queryByLabelText('Secret value (can be empty)')).toBeNull());
  });

  it('activates an inactive key via PATCH', async () => {
    const user = await renderModal(false);
    await user.click(screen.getByText('Make active'));
    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH');
      expect(patch?.url).toContain('/secrets/secret-inactive');
      expect(patch?.body).toEqual({ active: true });
    });
  });

  it('activates a key from the quick active-key select', async () => {
    const user = await renderModal(false);
    await user.selectOptions(screen.getByLabelText('Active key'), 'secret-inactive');
    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH');
      expect(patch?.url).toContain('/secrets/secret-inactive');
      expect(patch?.body).toEqual({ active: true });
    });
  });

  it('renames a key label inline', async () => {
    const user = await renderModal(false);
    const editButtons = screen.getAllByLabelText('Edit label');
    // First list item is the active key.
    await user.click(nth(editButtons, 0));
    const input = await screen.findByLabelText('Label (optional)');
    await user.clear(input);
    await user.type(input, 'renamed');
    await user.click(nth(screen.getAllByLabelText('Save'), 0));
    await waitFor(() => {
      const patch = calls.find(
        (call) => call.method === 'PATCH' && /secret-active$/.test(call.url),
      );
      expect(patch?.body).toEqual({ label: 'renamed' });
    });
  });

  it('deletes a key after confirmation', async () => {
    const user = await renderModal(false);
    const deleteButtons = screen.getAllByLabelText('Delete key');
    // Delete the inactive (second) key.
    await user.click(nth(deleteButtons, 1));
    expect(await screen.findByText('Delete stored key?')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      const del = calls.find((call) => call.method === 'DELETE');
      expect(del?.url).toContain('/secrets/secret-inactive');
    });
  });

  it('copies the revealed value when exposure is enabled', async () => {
    const user = await renderModal(true);
    // No exposure hint when enabled.
    expect(screen.queryByText(/Copying and viewing keys is disabled/)).toBeNull();
    const copyButtons = screen.getAllByLabelText('Copy key');
    await user.click(nth(copyButtons, 0));
    await waitFor(async () => {
      const reveal = calls.find((call) => call.method === 'POST' && /\/reveal$/.test(call.url));
      expect(reveal?.url).toContain('/secrets/secret-active/reveal');
      // The revealed plaintext lands on the clipboard (userEvent's stub).
      expect(await navigator.clipboard.readText()).toBe('sk-plain-2222');
    });
  });
});
