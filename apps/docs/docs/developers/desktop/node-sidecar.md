# Node sidecar (removed)

:::warning Removed in round 60b
The Node sidecar — a packaged Fastify process started by the Tauri shell — no
longer exists. The shell now opens the Rust kernel in-process and talks to it over
Product Wire envelopes; see [Kernel transport](tauri-shell.md).
:::

This page is kept so old links resolve. What it used to describe:

- `apps/server` packaged with `pkg` into a per-platform binary under
  `src-tauri/binaries/`, spawned as a child process;
- a `NEOTA_LEGACY_SERVER=1` switch that chose the sidecar instead of the kernel;
- an HTTP transport on a loopback port, with `/api/v2/*` routes.

All three were deleted with the Fastify contour (`apps/server`, `packages/db`,
`packages/neobackend/src/legacyBackend.ts`). The rollback path is a git revert to
`d763df4a^`, not a runtime flag.
