---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0036-android-background-execution.md
---

# ADR-0036: Android Background Execution — bounded foreground service + WorkManager maintenance over the shared kernel handle

Date: 2026-08-13. Status: Accepted (Phase 8).
Related documents: [Android host](../android/README.md),
[Architecture](../architecture/README.md), [Generation durability](../architecture/generation-durability.md),
[Wire contracts](../architecture/wire-contracts.md),
[ADR-0029](0029-wire-contract-toolchain.md), [ADR-0034](0034-android-local-host-jni-transport.md),
ТЗ §8, §19, §63–§66, §78 Фаза 8, §85, §87.

## Context

ТЗ §8/§19 require background execution on the Android host: a generation
the user can see must keep running when the app leaves the foreground, and
maintenance (backups) must happen without user interaction. Phase 5 already
embedded the **same Runtime Kernel** on the device (ADR-0034): the WebView
talks to it over the frozen JS bridge → JNI → mobile-ffi surface, and the
kernel holds an **exclusive data-root lease** — a second writable owner is
rejected with a controlled `DataRootInUse` error (§22). Phase 6 made
generation a durable workflow (`generation_runs`/`generation_events`,
Retry/Keep/Discard, startup recovery of lease-expired runs to
`interrupted`); Phase 7 made providers portable. The web app already keeps
the stream alive while the process lives, but Android may background,
throttle or kill the process at any time — without a host-side lifecycle
adapter the user-visible run silently stops, and nothing ever triggers
`backups.create` on a schedule.

Before this ADR the Android host has exactly one kernel owner — `MainActivity`
— and no platform background surface: no service, no notifications, no
scheduler. Any Phase 8 solution must respect the frozen Phase 5 surface: the
8-method JNI symbol table, the `KernelSession`/`NativeKernel` API and the
`window.__neotavernMobile` bridge protocol are unchanged except for one
**additive** handoff entry point; the wire registry and `schemaHash`
(ADR-0029) stay frozen — no new product operations, no codegen. §87 bans a
custom scheduler; §66 forbids promising exact execution times; §85 forbids
message content in notifications.

## Decision

- **(a) User-visible generation continuation = a bounded foreground
  service sharing the ONE kernel handle.** `GenerationService` is a
  `FOREGROUND_SERVICE_TYPE_DATA_SYNC` service started **only while an
  active generation stream exists**. Activity and service share the single
  `KernelSession` through `KernelHolder` — a pure-Kotlin refcounted holder
  (`acquire()`/`release()`; at zero the session closes and the executor
  shuts down) — **never a second writable kernel**, which the data-root
  lease would reject with `DataRootInUse` (§22). `KernelSession.open()` is
  idempotent, so both owners operate the same open kernel. Streams handed
  off from the WebView bridge are registered process-wide in
  `ForegroundExecutionCoordinator` (first claim wins, idempotent); the
  service drains the claimed stream on the holder executor. The service
  lifecycle is tied to the active stream: it starts on handoff and stops
  itself once the stream reaches a terminal state, the user stops it, or
  the OS expires it.
- **(b) Maintenance = WorkManager unique one-time work, never a custom
  scheduler.** `MaintenanceScheduler` enqueues a WorkManager
  `OneTimeWorkRequest` under the unique work name `neotavern-maintenance`
  running `backups.create` (`MaintenancePolicy.OPERATION_ID`), with
  `BATTERY_NOT_LOW` + `STORAGE_NOT_LOW` constraints (both required). WorkManager
  decides the actual execution time — initial delay ~15 min, period ~12 h
  are documented **best-effort** targets, not guarantees (§66). Execution is
  at-least-once; duplicates are safe because `backups.create` is idempotent
  (a new snapshot container, quota-bounded). There is no boot-time receiver
  and no scheduler daemon (§87).
- **(c) Expiration and process death map onto the existing kernel paths.**
  OS service expiration / force-stop and the user's Stop action are all
  funneled through `session.cancelStream(...)` (`nt_stream_cancel` →
  `generation.cancel`, idempotent) plus `ForegroundExecutionCoordinator
.unclaim`. If the whole process dies instead, no explicit cancel is
  possible — the kernel's startup recovery marks lease-expired runs
  `interrupted` at the next open (§63), and the web app resumes the run with
  `generation.retry` (Phase 6). Recovery never requires a new kernel
  surface.
- **(d) No new JNI/FFI/contract/codegen surface.** The JNI symbol table
  stays at its 8 frozen methods; the wire registry and schema hash are
  unchanged; the only host addition is the additive bridge handoff entry
  point of the Phase 5 JS protocol. Background work is just the existing
  envelope operations (`generation.start` / `generation.retry` streams,
  `generation.cancel` unary, `backups.create` unary) built with
  `EnvelopeBuilder` (byte-identical to the TS `wireEnvelope`).
- **(e) Operation → platform API mapping.**

  | Host activity                      | Platform API                                                                                                                                                                 | Wire / kernel path                                                                                     |
  | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
  | Foreground generation continuation | `ForegroundService` (`ServiceCompat.startForeground`, `FOREGROUND_SERVICE_TYPE_DATA_SYNC`) + `NotificationHelper`                                                            | `generation.start` / `generation.retry` stream on `KernelHolder.session`                               |
  | User stop                          | Notification Stop action: explicit `PendingIntent.getService` → `GenerationService` (`ACTION_STOP`, channel `neotavern_generation`, id 1001) → `onStartCommand` → `stopSelf` | `session.cancelStream` (`nt_stream_cancel` → `generation.cancel`), `unclaim`                           |
  | OS expiration / force-stop         | System FGS stop / process kill                                                                                                                                               | in-process: same cancel path; killed process: startup recovery (`interrupted`) then `generation.retry` |
  | Maintenance backup                 | WorkManager unique `OneTimeWorkRequest` (`neotavern-maintenance`, `BATTERY_NOT_LOW` + `STORAGE_NOT_LOW`)                                                                     | `backups.create` unary envelope                                                                        |
  | Notification presentation          | `NotificationChannel` `neotavern_generation`; `POST_NOTIFICATIONS` runtime permission (API 33+)                                                                              | — (status-only, never message content, §85)                                                            |

  There is **no boot receiver** and **no scheduler daemon**: background work
  is started only by in-app events (stream handoff) and by WorkManager.

## Alternatives

- **A second kernel instance for the service.** The service could open its
  own kernel over the same data root. Rejected: the kernel holds the
  exclusive data-root lease (§22) and answers `DataRootInUse` — a second
  writable kernel is impossible by construction. `KernelHolder` shares the
  one existing handle instead.
- **No foreground service.** Keep generation purely in the WebView and let
  Android do whatever it does in the background. Rejected: ТЗ §8/§19
  require user-visible generation to continue, and without a foreground
  service the process is killed/throttled at any time — the user sees a
  silently dropped run with no stop control and no status.
- **Custom scheduler (alarm manager, own job loop, cron daemon).** Rejected:
  §87 explicitly bans an own scheduler — WorkManager is the system
  scheduler, with system-controlled timing (also required by §66: no exact
  schedule).
- **Eternal foreground service.** A permanent FGS to host "everything".
  Rejected: §87-style always-on background work is out of scope; the
  service is bounded to an active user-visible stream and stops at terminal
  state.

## Consequences

- **API 34 `dataSync` quota.** Android 14+ limits dataSync foreground
  services to a cumulative 6 h per day; a run beyond the quota is stopped
  by the system and lands on the same cancel path as any expiration. The
  app does not promise uninterrupted long-running service time.
- **`POST_NOTIFICATIONS` runtime permission (API 33+).** The FGS requires
  notification permission on Android 13+; denial degrades to a service that
  runs without a visible notification (streams still continue via the
  holder, but the user loses the Stop action).
- **Notification content policy.** The notification carries run state
  (`Generating` / `Complete` / `Failed`) and the Stop action only — never
  chat or message content (§85).
- **No exact-schedule promise.** WorkManager decides actual maintenance
  times (battery/storage constraints gate it further); `backups.create` may
  be delayed or retried. At-least-once with idempotent duplicates.
- **Rollback is cheap.** Disabling the FGS/work paths returns to the
  Phase 5 behavior; foreground UI and durable kernel recovery are
  unaffected — a killed run is still recoverable via `generation.retry`.
- **API-level matrix.** minSdk 26 (`startForegroundService` +
  foreground notifications), API 33+ adds the notification runtime
  permission, API 34+ adds the `dataSync` type and quota — covered by the
  instrumented gate on API 26 and API 34 emulators in nightly.
- **No kernel/platform branching.** The kernel stays Android-agnostic: all
  Phase 8 behavior is a host-side lifecycle adapter in `apps/android`
  speaking the frozen wire registry.
