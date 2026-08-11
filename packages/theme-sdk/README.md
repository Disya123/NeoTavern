# @neotavern/theme-sdk

Theme SDK: three theme levels (tokens, skins, shells). Pure TS without DOM —
generates CSS variables; the host (`apps/web`) applies them.

## Public API

- `TOKEN_NAMES`, `DEFAULT_LIGHT_TOKENS`, `DEFAULT_DARK_TOKENS` — the token
  contract.
- `validateThemeManifest()` — validation of `theme.json`.
- `resolveTokens(theme, mode, parents)` — inheritance and mode resolution.
- `buildThemeVariables(theme, mode, parents)` → `Record<'--st-…', value>`.
- `resolveNavigationRailLayout(theme, parents)` — inherited order of the
  `main`/`bottom` groups and the optional `menu-toggle`.
- `resolveManagementTabsLayout(theme, parents)` — inherited pinning of the top
  Personas/Characters tab row on desktop.
- `resolveThemeShellLayout(theme, parents)` — a single resolved shell
  contract.
- `tokensToCssVariables()`, `dataHook()`, `getSafeModeFromSearch()`.

`componentsCss` and `shell` in `theme.json` point only to CSS files inside the
package. The Theme SDK does not execute theme JavaScript.

`shellLayout.navigationRail` is a verifiable declarative part of the shell:
item identifiers can be rearranged between `main` and `bottom`, and
`menu-toggle` can be moved or removed. Unspecified system sections are added
back by the host, keeping access to Settings and safe mode.

`shellLayout.managementTabs.pinned` controls the tabs of the full-size
Personas/Characters panels. The default value `false` keeps the tablist in the
normal flow of the shared menu ScrollArea, so it scrolls up with the content;
`true` pins it via sticky at the inset boundary on desktop. The mobile bottom
position remains a host breakpoint contract.

## Inheritance

Merge order: mode defaults → parent chain (root → closest) → theme. Dark mode
falls back to the theme's light tokens when no dark tokens exist.

## Dependencies

- `@neotavern/contracts`, `@neotavern/shared`.

## Commands

```bash
pnpm --filter @neotavern/theme-sdk build
pnpm exec vitest run packages/theme-sdk
```

## Constraints

DOM application and safe-mode startup logic live in `apps/web/src/theme/`. A
theme gets no access to chats, API keys or the filesystem. See
[docs/theme-sdk](../../docs/theme-sdk/README.md).
