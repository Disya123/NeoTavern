# @neotavern/legacy-compat

Compatibility layer for existing SillyTavern extensions (AGENTS.md §18).

## Public API

- `LegacyEventSource`, `event_types` — event bus compatible with `eventSource`.
- `createLegacyContext()`, `setLegacyBridge()` — the `getContext()` surface.
- `LEGACY_ISLANDS`, `islandElementId()`, `appendToIsland()` — unmanaged
  DOM islands (`legacy.chat.actions`, `legacy.toolbar`, …).
- Subpath `@neotavern/legacy-compat/globals`: `installLegacyCompat(bridge?)` —
  installs `window.SillyTavern`, `window.eventSource`, `window.event_types`,
  `window.extension_settings`, `window.$`/`window.jQuery`.

## Guarantees

Implemented documented contracts:

- `window.SillyTavern.getContext()` with characters, active chat/character,
  `sendChatMessage()`, request headers and extension settings;
- `window.eventSource` / `window.event_types`;
- `window.extension_settings`, `window.$` / `window.jQuery`;
- unmanaged DOM islands for settings, chat/character actions, toolbar, drawer
  and modal.

Extension settings persistence goes through `/api/v2/legacy/extension-settings`
and is namespaced by the installed plugin's namespace.

Legacy package entry points are a trusted compatibility mode:
`legacy.frontend` runs in the main window, `legacy.backend` gets an isolated
Express application under `/api/plugins/{id}`. Both require the `legacy.trusted`
manifest permission, explicit consent, and are disabled in safe mode.

## Best effort (not guaranteed)

Looking up internal elements by arbitrary CSS classes, modifying foreign DOM,
importing private core files, monkey patching, depending on the exact HTML
order, and old APIs not listed above (including arbitrary slash/prompt hooks).

## Dependencies

- `jquery`.

## Commands

```bash
pnpm --filter @neotavern/legacy-compat typecheck
pnpm exec vitest run packages/legacy-compat
```

## Constraints

`./globals` requires a DOM (browser) — do not import it directly in node tests.
The server-side legacy host (Express) lives in `apps/server/src/legacy/`.
