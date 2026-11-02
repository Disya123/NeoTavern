# Release gate status (kernel default switch)

The public desktop default flips from the legacy sidecar to the Kernel only when
every row below is satisfiable **on packaged artifacts**. This page records the
verified state so the remaining work is explicit instead of hopeful — a row is
`PASS` only with the command and its result, never by intention.

Related: [ADR-0038](../adr/0038-canonical-rust-kernel-core.md),
[ADR-0059](../adr/0059-react-primary-pivot.md), `docs/desktop/README.md`,
capability matrix (`docs/capability-matrix.json`, generated), [cutover registry](etap4-ui-cutover-registry.md).

## Verified

| Row | Condition                                | Evidence                                                                                          | Status                           |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------- |
| G1  | Rust lints clean under the CI invocation | `cargo clippy --workspace --all-targets -- -D warnings` (from `crates/`) → exit 0                 | **PASS** (round 7)               |
| G2  | Repository formatting clean              | `pnpm format:check` → "All matched files use Prettier code style"                                 | **PASS** (round 8)               |
| G3  | No silent kernel-plane fallbacks         | `pnpm ui:fallback:check` → 3 registered `kernel-empty:` branches, AST classifier, CI step present | **PASS** (round 6)               |
| G4  | Legacy UI surface audited and frozen     | `pnpm ui:api:check` → 51 sites, per-site fingerprints + owner/removal records                     | **PASS** (round 5 audit closure) |
| G5  | Product Wire contract determinism        | `node tools/contract-codegen/codegen.mjs --check` → 143 ops in sync                               | **PASS**                         |

## Not satisfied

| Row | Condition                                                              | What is actually missing                                                                                                                                     | Status   |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| G6  | Every mandatory Desktop capability `Packaged` in the capability matrix | 0 of 43 rows are `Packaged` on desktop; 30 `Integrated`, 8 `Implemented`. Promotion needs packaged-artifact evidence, which this environment cannot produce. | **FAIL** |
| G7  | `app.db` → `database.sqlite` migration verified on packaged artifacts  | No importer exists in the Kernel at all (`git grep app.db` hits only docs). A migration harness has to be built from scratch before it can be verified.      | **FAIL** |
| G8  | Rollback verified                                                      | Depends on G7: nothing to roll back from until the importer exists.                                                                                          | **FAIL** |
| G9  | Playwright E2E on the packaged build                                   | Not run in any round of this program.                                                                                                                        | **FAIL** |
| G10 | Accessibility (WCAG 2.2 AA) and visual regression gates                | Not run in any round of this program.                                                                                                                        | **FAIL** |

## Consequence

The switch is blocked by G6–G10, not by the migration of features: the Rust
kernel, the wire plane and the React contour are ready enough that every UI
consumer flipped in rounds 1–5 has a Product Wire path, but "ready enough" is
not the gate. Until G6–G10 pass on packaged artifacts, the sidecar stays the
public default and the Kernel stays an explicit Preview
(`NEOTA_KERNEL=1`, conflict policy in `apps/desktop/src-tauri/src/lib.rs`).

Deleting `fastify`/`drizzle`/`api/v2` is the last step of the same gate: it can
only happen when the legacy plane is provably unnecessary, which is exactly what
G6–G8 measure.
