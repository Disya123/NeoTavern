---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0008-json-additional-parameters.md
---

# ADR-0008: JSON instead of YAML for additional parameters

- **Status:** Accepted
- **Context.** Classic SillyTavern defines "Additional Parameters"
  (include body / exclude body / include headers) as YAML strings that are
  parsed on the client before sending. NeoTavern reproduces this behavior in
  its stack (React 19 + TypeBox + a single `provider-sdk`).

## Decision

Store the values as **structured JSON** in `settings` of the provider
configuration: `customIncludeBody` (object), `customExcludeBody`
(array of strings), `customIncludeHeaders` (string→string object). The UI
edits them as JSON text with local validation; the server re-checks the forms
in `normalizeCatalogConfig` and rejects invalid values with code
`PROVIDER_CONFIG_INVALID`. Overriding the `Authorization`, `Content-Type`,
`Content-Length` headers is forbidden. Overriding and excluding the reserved
body keys (`stream`, `stream_options`, `model`, `messages`, `prompt`,
`input`) is also forbidden — they belong to the adapter
(`RESERVED_CUSTOM_BODY_KEYS` in `@neotavern/contracts`).

## Alternatives

YAML (as in ST1) — requires a new runtime dependency (yaml parser), gives
weaker typing and integrates worse with TypeBox. "Raw text without structure"
— server-side validation and header protection are impossible.

## Consequences

No new dependency; strict schemas in `@neotavern/contracts`; identical
validation on client and server (shared `additionalParamIssues`). A
deliberate deviation from ST1: the user enters JSON, not YAML.
