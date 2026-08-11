# @neotavern/web

NeoTavern frontend: React 19 SPA (no SSR), Vite 8 as bundler/dev server.

## Running

```bash
pnpm --filter @neotavern/web dev       # Vite dev server (proxies /api → 127.0.0.1:8000)
pnpm --filter @neotavern/web build     # production build into dist/
pnpm --filter @neotavern/web test      # jsdom component tests
pnpm test:e2e                    # production E2E + axe WCAG A/AA
```

The root E2E command builds the production frontend, starts a local Fastify
server and checks the main user scenarios, keyboard navigation and
WCAG A/AA via axe-core.

In local dev the proxy does not forward the browser `Origin` to the loopback API,
so the Vite fallback port does not trigger a CORS error. With
`NEOTA_REMOTE_ACCESS=true` the header is preserved for exact trusted-origin
checking.

## Architecture

- **TanStack Query** — server state (explicit staleTime, invalidation).
- **Zustand** — local UI state only (theme, language, sidebar).
- **React Router** — routes: `/characters`, `/chats/:id`, `/providers`, `/settings`.
- **@neotavern/ui** (Radix) — components; **@neotavern/i18n** — translations; **@neotavern/theme-sdk** — themes.
- **@neotavern/legacy-compat** — window globals for legacy extensions.

## Pages

- `CharactersPage` — virtualized catalog (`@tanstack/react-virtual`),
  cursor pagination, search, creation.
- `ChatPage` — message viewport (older messages load in batches) + composer;
  streaming via SSE with token batching through `requestAnimationFrame`
  (≤30 updates/s).
- `ProvidersPage`, `SettingsPage` (language, theme, active provider/persona, backups).

## Performance

List virtualization, cursor pagination, lazy heavy modules, an Error Boundary
per major area. Initial bundle ~160 KB gzip (< 2 MB budget).

## Dependencies

Monorepo workspace packages via Vite aliases to sources; `react`,
`react-router-dom`, `@tanstack/*`, `zustand`, `react-i18next`.

## Limitations

Vite is only the bundler/dev server, not the application's Plugin API
(that is `@neotavern/plugin-sdk`).
