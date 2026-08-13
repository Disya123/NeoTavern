---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0004-typebox-contracts.md
---

# ADR-0004: TypeBox 0.34 + type-provider v5

- **Status:** Accepted
- **Context.** Fastify 5 requires a type provider; the new `typebox@1.x` package
  was not yet stable in the ecosystem at the time of development.

## Decision

`@sinclair/typebox@0.34` + `@fastify/type-provider-typebox@5.x`
(supports Fastify 5). Schemas — a single source in `@neotavern/contracts`.

## Alternatives

`typebox@1.x` + provider v6 (new API, higher risk).

## Consequences

A stable, well-studied combination; if needed, the migration to typebox 1.x
is localized to `contracts`.
