# resource-runner

Windows-only native process-tree memory containment for heavy local workloads
(plan rev 2.2 Layer A). See
[Resource containment](../../docs/architecture/resource-containment.md) for the
full architecture.

## What it does

Launches a workload root process **suspended**, assigns it to a fresh **Job
Object**, then resumes it — so ALL memory allocated by the whole process tree
counts against the job:

```text
CreateProcessW(CREATE_SUSPENDED)
  → AssignProcessToJobObject   (failure → terminate child, REFUSE, never run uncontained)
  → ResumeThread
```

- **Two-threshold memory control**: soft notification limit (~90% of the cap,
  guaranteed `JOB_OBJECT_MSG_NOTIFICATION_LIMIT`) → `TerminateJobObject` →
  exit `RESOURCE_LIMIT`; hard `JOB_OBJECT_LIMIT_JOB_MEMORY` (100%) as a
  backstop — Windows blocks further commit even if the runner is dead.
- **Host headroom**: `GetPerformanceInfo` (`available_commit =
(CommitLimit − CommitTotal) × PageSize`), effective cap
  `min(configured, available − HOST_RESERVE)` with
  `HOST_RESERVE = max(4 GiB, 25% of the commit limit)`; below the suite
  minimum the runner refuses with exit `SKIPPED`.
- **Additional controls**: `ActiveProcessLimit`, `KILL_ON_JOB_CLOSE`,
  wall-clock deadline → `TerminateJobObject` (exit `TIMEOUT`), inherited
  stdout/stderr (never buffered unbounded).
- **Global scheduler**: optional named mutex (`--lock`); the OS releases it
  automatically when the owner dies — stale locks are impossible.
- **Fail-safe**: `RESOURCE_BUDGET_MODE=contained` is required, otherwise the
  runner refuses (no accidental uncontained run).

## Build

```text
cargo build --manifest-path crates\Cargo.toml -p resource-runner --release
```

## Usage

```text
resource-runner [--cap <MiB>] [--soft <ratio>] [--min-cap <MiB>]
                [--deadline <secs>] [--lock <name>] [--lock-wait <secs>]
                [--cwd <dir>] --cmd <token> [<token> ...]
```

`--cmd` consumes the value and every remaining token (the wrapper always puts
it last). The runner joins the tokens and wraps the whole command as one
quoted `/c` argument for `cmd.exe` — the only pattern that runs both plain
executables and `.cmd` shims (`pnpm.cmd` etc.) through `CreateProcessW`.
Prefer the JS wrapper [`scripts/contained-run.mjs`](../../scripts/contained-run.mjs),
which builds the argv, sets `RESOURCE_BUDGET_MODE=contained` and forwards
exit codes.

Note on compile phases: `cargo test` compiles in debug with parallelism equal
to the core count; a multi-crate suite can need several GiB of process-tree
memory just to build. Size `--cap` accordingly or cap the build with
`cargo test -j 2` — the Job Object will clip an undersized budget exactly as
designed (the workload fails cleanly; the host never feels it).

## Exit codes

| Code  | Meaning                                                               |
| ----- | --------------------------------------------------------------------- |
| 0     | success                                                               |
| 1–255 | workload's own exit code (normal failure)                             |
| 2     | runner error (usage, job creation, failed assignment — refused)       |
| 3     | `SKIPPED: insufficient host memory` (effective cap below `--min-cap`) |
| 4     | `RESOURCE_LIMIT` (job memory violation)                               |
| 5     | `BUSY` (scheduler lock timeout)                                       |
| 6     | `TIMEOUT` (wall-clock deadline)                                       |

## Portability

Windows Job Object: full guarantee. Linux cgroup v2 / macOS rlimit are
**not** equivalent and are not claimed by this crate.

## Testing

`cargo test -p resource-runner` runs pure-logic tests (argument parsing,
soft-ratio bounds, fail-safe policy). The Win32 paths are exercised
behaviorally only on a real Windows host with `RESOURCE_BUDGET_MODE=contained`
(e.g. `pnpm test:contracts:heavy`).
