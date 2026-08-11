# @neotavern/i18n

Localization: i18next, en/ru resources, error-code localization, pseudo-locale.

## Public API

- `createI18n({ language })` → an isolated i18next instance.
- `en`, `ru`, `pseudoLocale`, the `Resources` type (structural check of
  translations).
- `localizeError(instance, code, params)` — error code → translated message.
- `SUPPORTED_LANGUAGES`, `languageDirection(code)` (RTL for ar/he/fa/ur),
  `NAMESPACES`.

## Namespaces

`common`, `navigation`, `chat`, `characters`, `settings`, `providers`, `errors`,
`validation`, `accessibility`. Plugins/themes use isolated namespaces.

## Requirements

- fallback: regional → base → en;
- plurals/dates/numbers via `Intl`;
- the backend sends an error code, the frontend localizes it;
- user content is not translated automatically.

## Dependencies

- `i18next`.

## Commands

```bash
pnpm --filter @neotavern/i18n typecheck
pnpm exec vitest run packages/i18n
```
