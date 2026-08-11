# @neotavern/shared

Common types and utilities. Isomorphic package (no `node:` imports) — used by
both backend and frontend. Zero runtime dependencies.

## Public API

- `uuidv7()`, `isUuid()`, `randomToken()` — stable identifiers (UUIDv7).
- `AppError`, `ErrorCodes`, `toAppError()`, `isAppError()` — errors with
  machine-readable codes.
- `Result`, `ok`, `err`, `map`, `unwrap` — explicit error handling at
  boundaries.
- `createLogger()`, `redactSecrets()` — structured logging with secret
  masking.
- `withTimeout()`, `combinedSignal()`, `sleep()` — timeouts/AbortSignal
  helpers.
- `clamp`, `deepMerge`, `stableStringify`, `assertNever`.
- `replaceMacros()`, `buildMacroContext()`, `MacroContext` — prompt macro
  substitution (`{{user}}`, `{{char}}`, time/date, `{{random:…}}`, custom
  variables).

## Dependencies

None.

## Commands

```bash
pnpm --filter @neotavern/shared build      # tsc -b
pnpm exec vitest run packages/shared # tests
```

## Constraints

Contains no API domain types (they live in `@neotavern/contracts`).
