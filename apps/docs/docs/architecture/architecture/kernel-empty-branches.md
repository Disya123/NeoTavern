---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/architecture/kernel-empty-branches.md
---

# Kernel-plane empty branches (no silent fallbacks)

Release-gate item 4 requires **no silent fallbacks**: on the kernel plane a
missing capability must be either implemented over Product Wire or announced with
a typed error. The dangerous third state — a branch that quietly fabricates an
empty value while the feature is actually missing — looks identical to "the user
has no data yet", and it is exactly how a half-migrated feature ships.

Gate: `pnpm ui:fallback:check` (`scripts/check-kernel-empty.mjs`, also run in CI
right after the legacy-surface gate).

## Rule

Every `if (isKernelMode()) { … }` branch must do one of three things:

1. **Call the backend** (Product Wire / facade / kernel polling). Nothing to
   register.
2. **Fail closed** — `throw new UnsupportedError('<surface id>')`. Nothing to
   register.
3. **Answer with an empty/neutral value** — allowed only with a colocated marker
   inside the branch (or on the lines immediately above a single-line guard):

   ```ts
   if (isKernelMode()) {
     // kernel-empty: <why this empty value is the truth, not a hiding place>
     return null;
   }
   ```

The marker is the registration: it is written where the reviewer reads the code,
it cannot drift into a separate file, and the reason is part of the diff. A
branch with no call, no throw and no marker fails the gate and names its line.

## Classification

The gate parses the app with the TypeScript compiler API instead of scanning
lines, because the textual shape is misleading in four ordinary cases: a negated
guard (`!isKernelMode()`), a ternary, a branch that returns closures which throw,
and `new UnsupportedError(...)` (a `NewExpression`, not a call). Those are pinned
by `scripts/check-kernel-empty.test.mjs`.

## Registered empty branches

As of round 6 there are exactly three, each with its marker in source:

| Site                                                        | Value                                      | Why it is the truth                                                                                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/api/hooks.ts` (`useAuthSession`)              | `{ required: false, authenticated: true }` | The local kernel transport (Tauri IPC / loopback) has no remote-token session layer, so "not required, authenticated" describes that transport. A remote Web Client does not reach this branch — its auth is host-side. |
| `apps/web/src/api/wireBridge.ts` (`wallpaperBackgroundUrl`) | `null`                                     | The kernel has no URL surface: a wallpaper is rendered from `assets.content` as a data URL (`useBackgroundImageUrl`), so there is no URL to build. `null` is the honest answer, not a broken link.                      |
| `apps/web/src/api/wireBridge.ts` (`themeUserCssUrl`)        | `null`                                     | `user.css` is a file the legacy sidecar serves from the theme directory; the kernel stores theme settings as data and has no user-stylesheet file, so there is no stylesheet to link.                                   |

Adding a fourth row means adding a marker and a line here — that is the whole
point: an empty answer becomes a recorded decision instead of an accident.

## History

The first version of the backgrounds hooks returned `{ items: [] }` on the kernel
plane (round 5-era "honest empty"). Round 4 replaced it with the real asset
catalog (`assets.list({ kind: "background" })`), which is the model this gate
wants: empty means "you have no wallpapers", not "the feature is missing".

## Related

- [UI/API cutover registry](etap4-ui-cutover-registry.md) — the migration program.
- [Host-surface boundary](host-surface-boundary.md) — the fail-closed host calls.
- [Product Wire contracts](wire-contracts.md) — the canonical data plane.
- [Legacy UI surface baseline](ui-legacy-surface.md) — the sibling audit for
  `/api/v2` call sites.
