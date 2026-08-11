# @neotavern/contracts

TypeBox API schemas — the single source of truth. The backend validates requests
with these schemas (Fastify Type Provider), the frontend uses the inferred
`Static<…>` types. Types are not duplicated manually (AGENTS.md §5).

## Public API

- Entities: `CharacterSchema`, `ChatSchema`, `MessageSchema`, `PersonaSchema`,
  `ProviderConfigSchema`, `AppSettingsSchema`, `SearchQuerySchema` and their
  `Create`/`Update`/`ListQuery` variants.
- Common: `IdSchema`, `CursorPageSchema`, `CursorPageQuerySchema`, `ErrorEnvelopeSchema`, `AckSchema`.
- Generation: `GenerationRequestSchema`, `GenerationEventSchema`, `TokenUsageSchema`,
  `ChatGenerateRequestSchema`.
- Diagnostics: `DiagnosticsSnapshotSchema` and `CacheCleanupResultSchema`;
  the snapshot contains only aggregates and explicit privacy invariants.
- `validateSchema(schema, input)` / `isValid()` — runtime validation via TypeBox.

## Dependencies

- `@sinclair/typebox`, `@neotavern/shared`.

## Commands

```bash
pnpm --filter @neotavern/contracts build
```

## Constraints

The `ProviderConfig` schema never contains an API key value (only `hasApiKey`).
Changing a schema changes the API contract (see [docs/api](../../docs/api/README.md)).
