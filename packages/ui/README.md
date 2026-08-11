# @neotavern/ui

Base headless components on Radix Primitives, styled via cascade layers +
semantic tokens and stable `data-*` hooks.

## Public API

- `Button`, `IconButton`, `Dialog`, `DropdownMenu`, `Tabs`, `Switch`,
  `Separator`, `ScrollArea`, `Tooltip`, `TooltipProvider`, `TextField`,
  `TextArea`, `Spinner`, `Card`, `ErrorBoundary`, `Combobox`, `ModelMenu`,
  `Badge`, `Segmented`, `SelectField`.
- `DropdownMenuItem` accepts `asChild` — renders the item as an arbitrary
  element (e.g. `<a href>`), preserving Radix menu semantics.
- `cx()` — class merging.
- Importing the package pulls in the base styles
  (layers/reset/tokens/base/components).

## Styling

- layers: `@layer reset, tokens, base, components, plugin-base, theme, user`;
- components are marked with
  `data-component`/`data-part`/`data-role`/`data-state`;
- tokens only (`--st-*`), no hardcoded colors/fonts (AGENTS.md §14);
- Radix accessibility preserved (focus, dialog/menu semantics).

## Dependencies

- `@radix-ui/*`; peer: `react`, `react-dom`.

## Commands

```bash
pnpm --filter @neotavern/ui typecheck
```

## Constraints

Consumed from sources (Vite alias in `apps/web`); CSS Modules are used at the
application level, base components via data hooks (the theme contract).

`ModelMenu` is mirrored in the plugin sandbox (`api.ui.modelMenu`): the host
snapshots the resolved tokens (`PLUGIN_UI_TOKENS`,
`apps/web/src/plugins/themeTokens.ts`) into the kernel handshake and forwards
them on theme change, so the sandbox widget uses the same colors/geometry as
the host component; the built-in palette is only a fallback without a
handshake.
