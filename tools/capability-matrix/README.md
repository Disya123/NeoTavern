# capability-matrix

Deterministic generator of the NeoTavern capability / status / host matrix
(ARC-10, ТЗ 10/10 rev2 §13.3). It merges the canonical Product Wire registry
(the built `@neotavern/contracts` wire layer) with the hand-maintained
`docs/release-manifest.json` and emits:

- `docs/capability-matrix.json` — machine-readable rows;
- `docs/capability-matrix.md` — the Markdown matrix linked from README and
  docs (GENERATED — do not edit by hand).

## Inputs

- `packages/contracts` (TypeBox wire registry) — rebuilt automatically via
  `pnpm --filter @neotavern/contracts build`.
- `docs/release-manifest.json` — capability entries with per-host statuses.

Allowed statuses (ТЗ §19.3): `Designed`, `Implemented`, `Integrated`,
`Packaged`, `Released`, `Deprecated` — plus `Not supported` for explicitly
unsupported capabilities (e.g. the standalone browser runtime, ARC-12).
Allowed host keys: `desktop`, `headless`, `android`, `webClient`.

## Usage

```bash
node tools/capability-matrix/generate.mjs            # write docs/capability-matrix.{md,json}
node tools/capability-matrix/generate.mjs --check    # CI gate: exit 1 if generated files differ
```

## Rules

- **Every Product Wire operation must be referenced by EXACTLY ONE capability.**
  The generator fails on an operation that is unreferenced, referenced twice,
  or that references an unknown operation id.
- **Per-host statuses are validated**: unknown host keys and statuses outside
  {Designed, Implemented, Integrated, Packaged, Released, Deprecated, Not
  supported} fail the generator.
- `--check` compares byte-for-byte against the committed files and exits 1 on
  any difference — a stale matrix blocks CI (ARC-10).
