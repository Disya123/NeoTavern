/**
 * Shared frontend test helpers (jsdom + Testing Library).
 *
 * `renderWithProviders` mirrors the provider stack every component test used
 * to hand-roll (DUP-26): QueryClientProvider (retries off) + I18nextProvider
 * (fresh English i18n instance) + MemoryRouter. i18n creation is async, so the
 * helper is async and returns the Testing Library render result.
 */
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { createI18n } from '@neotavern/i18n';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';

/** QueryClient with query/mutation retries disabled so failed tests fail fast. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

export interface RenderWithProvidersOptions {
  /** Initial history entries for the MemoryRouter. */
  initialEntries?: string[];
}

/**
 * Render `ui` inside QueryClientProvider + I18nextProvider + MemoryRouter.
 * A fresh i18n instance and QueryClient are created per call.
 */
export async function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): Promise<RenderResult> {
  const i18n = await createI18n({ language: 'en' });
  const queryClient = createQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={options.initialEntries}>{ui}</MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/** Build a `Response` with a JSON body and JSON content type (status 200 by default). */
export function jsonResponse(
  body: unknown,
  init: ResponseInit & { headers?: Record<string, string> } = {},
): Response {
  const { headers, ...rest } = init;
  return new Response(JSON.stringify(body), {
    status: 200,
    ...rest,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
