---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/architecture/resource-containment.md
---

# Resource containment (plan rev 2.2)

Every untrusted byte stream and every heavy local workload is bounded so a
pathological input or an OOM-prone test can never take the host down with it.
This page documents the two halves: the **bounded pipeline** for wire
payloads and the **process-tree memory containment** for heavy workloads.

## Invariant

> Любой недоверенный byte stream ограничивается до полного чтения; parse
> ограничивает глубину и cardinality во время построения структур;
> application не материализует результат сверх contract budget; serialization
> и transport output ограничены во время записи. Любой heavy workload
> запускается suspended внутри OS resource domain с process-tree
> memory/process/time limits и резервом памяти для хоста. Heavy workloads
> сериализованы глобальным scheduler. Превышение бюджета приводит к
> детерминированному завершению только resource domain, а не к memory
> pressure всего хоста.

## Bounded pipeline (вход → parse → результат → serialization → transport)

Each stage has its own limit; no stage may materialize more than the contract
budget:

| Stage                 | Mechanism                                                                                                                                                                                                                  | Fails as                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Transport read        | `read_body_limited` in `remote-http` (Content-Length pre-check + bounded chunked read; 413 before parse)                                                                                                                   | HTTP 413 `QUOTA_EXCEEDED`                      |
| Kernel вход (линия 2) | `enforce_request_limit(op, req)` in `runtime_kernel::dispatch` / `dispatch_stream` / `handle_unary` / `generation::stream_start` — byte-length gate BEFORE any parse, transport-agnostic (CLI/FFI/JNI/Tauri all pass here) | `PAYLOAD_TOO_LARGE` product error              |
| Parse                 | generated DTO checkers; serde_json recursion limit (128, `unbounded_depth` never enabled)                                                                                                                                  | `ContractViolation` / `RecursionLimitExceeded` |
| Result construction   | cardinality caps (`maxArrayItems`/`maxObjectKeys`/`maxStringBytes`) applied where collections are created; page size tuned so `pageLimit × 1 MiB ≤ responseLimitBytes`                                                     | bounded by construction                        |
| Serialization         | `product::encode_limited` → `serde_json::to_writer` + `LimitedWriter` (refuses past `limit`, mid-write)                                                                                                                    | `PAYLOAD_TOO_LARGE`                            |
| Response precision    | per-op `operation_response_limit(op)` post-check in `handle_unary` (bounded ≤ registry max during serialization, per-op limit enforced after)                                                                              | `PAYLOAD_TOO_LARGE`                            |

Byte limits are **generated**, never hand-written: `codegen.mjs` emits
`operation_request_limit` / `operation_response_limit` plus the registry-wide
maxima (`DEFAULT_REQUEST_LIMIT_BYTES` / `DEFAULT_RESPONSE_LIMIT_BYTES`) into
`crates/contracts-generated/src/generated.rs` from the same registry that
feeds `contract-manifest.json`. The generated-limits-vs-manifest test
(`crates/contracts-generated/tests/generated_limits_vs_manifest.rs`) proves
the two can never drift for any of the 64 operations.

`PAYLOAD_TOO_LARGE` is a product error code carried in the wire
`ProductErrorDto` (`params`: `operationId`, `bytes`, `limit`); it is a free
string in the wire schema, so no contract/hash change is required.

Behavioral (not grep) coverage:

- `crates/runtime-kernel/tests/kernel_payload_gates.rs` — over-limit +
  invalid JSON → `PAYLOAD_TOO_LARGE` (gate before parser); over-limit + valid
  JSON → `PAYLOAD_TOO_LARGE` (gate before schema check); unknown op + huge
  body → `OperationNotFound` (op gate first); stream dispatch over-limit →
  `PAYLOAD_TOO_LARGE`.
- `crates/runtime-kernel/src/product.rs` unit tests — `LimitedWriter` refuses
  past the limit mid-write; `encode_limited` → `PAYLOAD_TOO_LARGE`, never a
  panic; under-limit round-trips.
- `crates/adapters/remote-http/tests/remote_http.rs` — over-limit
  Content-Length answered 413 **without reading the body** (declared
  Content-Length 1 MiB, zero body bytes sent, prompt 413 proves
  `poll_count == 0`); chunked over-limit → same 413.

## Spec-first memory budgets for heavy test suites (Layer B)

`packages/contracts/test/_budget.ts` is the shared budget helper:

- `assertPayloadSpecCap(spec)` runs on a **spec** (declared byte counts) —
  never on a materialized payload, so the guard itself cannot allocate
  proportional to what it guards. It throws BEFORE any `.repeat()` /
  `Array.from()` in the builder.
- Hard caps: 16 MiB payload, 64 MiB batch, depth 1024, 200k array items,
  100k object keys. Hard limits fail CI; ms/op and heap/RSS deltas are
  diagnostic only.
- Heavy benches run in their OWN `node --expose-gc` child
  (`test/_bench-child.mjs`) that builds the payload inside itself from a
  small spec over argv; the parent (`bench.test.ts`) only asserts the returned
  metrics. After `exit` the OS returns all memory.
- `fuzz.test.ts` (fast-check, seeded `SEED=20260815`) drives every
  `WIRE_SCHEMAS` entry with chaos payloads plus a pathological section
  (100k nulls, 1 MiB string, 1000-deep trees, 50k-key objects) — each
  builder carries a spec and goes through the cap check.
- Structural guards: `budget-guard.test.ts` parses the actual package.json
  and vitest configs and asserts `maxWorkers: 2` +
  `--max-old-space-size=2048` for both root and `apps/web` vitest, and
  `workers: 1` / `fullyParallel: false` for Playwright.

## Native process-tree containment (Layer A, Windows)

`crates/resource-runner` (`resource-runner.exe`) launches a workload with:

```text
CreateProcessW(CREATE_SUSPENDED)
  → AssignProcessToJobObject   (failure → terminate child, REFUSE, never run uncontained)
  → ResumeThread
```

No `BREAKAWAY_OK` / `SILENT_BREAKAWAY_OK`: every descendant inherits the job,
so ALL memory of the process tree counts against the job limit. Two-threshold
memory control:

- soft: `JobObjectNotificationLimitInformation` (~90% of the cap) — the
  guaranteed `JOB_OBJECT_MSG_NOTIFICATION_LIMIT` → `TerminateJobObject` →
  exit `RESOURCE_LIMIT`;
- hard: `JOB_OBJECT_LIMIT_JOB_MEMORY` at 100% — Windows blocks further
  commit even if the runner itself is dead.

Host headroom uses `GetPerformanceInfo` (NOT `GlobalMemoryStatusEx` — its
available page-file is per-process): `available_commit =
(CommitLimit − CommitTotal) × PageSize`, a second threshold on
`PhysicalAvailable`, effective cap `min(configured, available − reserve)`
with `HOST_RESERVE = max(4 GiB, 25% of the commit limit)`, and exit
`SKIPPED: insufficient host memory` when the effective cap falls below the
suite minimum. Additional controls: `ActiveProcessLimit`, `KILL_ON_JOB_CLOSE`,
a wall-clock deadline → `TerminateJobObject` (exit `TIMEOUT`), and inherited
stdout/stderr (never buffered unbounded).

Global scheduler: an optional named mutex (`--lock`) serializes heavy
commands host-wide; the OS releases it automatically when the owner dies —
stale locks are impossible. `RESOURCE_BUDGET_MODE=contained` is a direct-run
fail-safe: the runner refuses to launch a workload unless the caller sets it.

`scripts/contained-run.mjs` is the JS wrapper: it resolves the built
`resource-runner.exe`, passes the full command line as one `--cmd` argument
(wrapped through `cmd /c` — `CreateProcessW` cannot run `.cmd` directly),
sets `RESOURCE_BUDGET_MODE=contained`, and forwards exit codes
(3 = SKIPPED, 4 = RESOURCE_LIMIT, 5 = BUSY, 6 = TIMEOUT). On non-Windows it
refuses (Job Objects are Windows-only; Linux cgroup v2 / macOS rlimit are
documented as NOT equivalent and are not claimed).

Root scripts:

```text
pnpm contained:run -- -- <cmd>                # low-level wrapper
pnpm test:contracts:heavy                     # fuzz + bench inside the runner
pnpm test:rust-fuzz:contained                 # cargo fuzz_deserialization inside the runner
```

Compile phases need adequate budgets: `cargo test` builds in debug with
core-count parallelism, so a multi-crate suite can need several GiB of
process-tree memory before a single test runs. Size `--cap` accordingly or
limit the build (`cargo test -j 2`); an undersized cap is clipped cleanly by
the Job Object — the workload fails, the host never feels it.

The wrapper refuses to run heavy stages uncontained, and every vitest/Playwright
run is bounded (workers + heap) so even a non-contained invocation cannot
multiply heap pressure.

## Portability honesty

- Windows Job Object: full guarantee (above).
- Linux: cgroup v2 (`memory.max` + `pids.max`) where available, else per-process
  `prlimit` — **not** equivalent to process-tree containment; documented, not claimed.
- macOS: best-effort per-process rlimit only; no equivalence claim.
