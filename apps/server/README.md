# @neotavern/server

NeoTavern backend: Fastify 5, SQLite, providers, prompt pipeline,
SSE generation, legacy host.

## Running

```bash
pnpm --filter @neotavern/server dev     # tsx watch (development)
pnpm --filter @neotavern/server start   # node dist/main.js (after build)
```

Environment variables:

- `NEOTA_HOST` (default `127.0.0.1` — loopback only),
- `NEOTA_PORT` (8000),
- `NEOTA_DATA_DIR` (`./data`),
- `NEOTA_WEB_DIR` (if set, serves the built SPA single-process; the CORS default
  becomes the server's own origin — the browser talks to the same port),
- `NEOTA_LOG_LEVEL`, `NEOTA_CORS_ORIGIN` (default `http://127.0.0.1:5173` —
  the Vite dev server; with `NEOTA_WEB_DIR` set, the default is
  `http://127.0.0.1:<NEOTA_PORT>`);
- `NEOTA_REMOTE_ACCESS=true` — explicit opt-in to remote mode;
- `NEOTA_PUBLIC_ORIGIN=https://host.example` — the exact trusted Origin;
- `NEOTA_REMOTE_TOKEN` — bootstrap token of at least 32 characters;
- `NEOTA_REMOTE_ALLOW_INSECURE_HTTP=true` — test/trusted networks only;
  production remote mode requires HTTPS.

## Structure

```
src/
  main.ts            # entry point: DB + registry + buildApp + listen + graceful shutdown
  app.ts             # assembly: CORS, CSP, error handler, modules, static
  config.ts          # configuration from env
  types.ts           # TypedApp (TypeBox type provider), AppContext
  lib/               # errors, sse, paths
  pipeline/          # macros, instruct, contextShift, promptPipeline, tokens
  plugin/            # process host, iframe bootstrap, capability IPC
  worker/            # permission-limited Node.js plugin runtime + ESM loader
  plugins/           # routes: auth, characters, chats, personas, providers,
                     #         settings, search, generate (SSE), backups,
                     #         themes, plugin manager, migration,
                     #         diagnostics/cache maintenance, meta
  legacy/host.ts     # trusted Express compatibility (/api/plugins/{id})
```

Each module is an isolated Fastify plugin. Schemas come from `@neotavern/contracts`.

## Dependencies

`fastify`, `@fastify/cors`, `@fastify/static`, `@fastify/express` (legacy only),
`@fastify/type-provider-typebox`, `@sinclair/typebox`, `handlebars`, `express`,
and the monorepo workspace packages.

## Tests

```bash
pnpm exec vitest run apps/server   # integration (Fastify inject) + pipeline
```

## Limitations

By default, access is loopback only. A non-loopback bind without explicit remote
mode is rejected at startup. Remote mode uses a bounded HttpOnly session,
Origin/CSRF checks for browser mutations, login rate limiting and Bearer tokens
for explicit API clients. A native backend plugin always runs as a separate
Node.js process with capability-checked IPC; a trusted legacy backend requires
`legacy.trusted`. See [API](../../docs/api/README.md),
[Plugin SDK](../../docs/plugin-sdk/README.md) and
[ADR-0005](../../docs/adr/0005-remote-session-auth.md).
