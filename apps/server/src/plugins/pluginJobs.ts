/**
 * Rev4 §2 `jobs.*` persistence, REST routes and the due-job runner.
 *
 * Dispatch design (deliberately the least-invasive path — no worker protocol
 * change): when a job is due, the runner emits `plugin.job.due`
 * ({pluginId, jobId, name, payload}) on the app event bus and fans out:
 *   - Backend plugins receive it through the EXISTING worker `event.emit`
 *     delivery: a plugin subscribes with `api.events.on('plugin.job.due', cb)`.
 *     `BackendPluginHost.deliverEvent` pushes the envelope to the live
 *     process; no IPC message type beyond the ones the worker already speaks.
 *     (`callback.invoke` was considered but needs a registration-id channel
 *     the worker does not expose for jobs.)
 *   - Web plugins receive the same event over the SSE whitelist
 *     (plugins/events.ts STREAM_EVENTS); apps/web/src/plugins/kernel/jobs.ts
 *     forwards it to the live sandbox session as the kernel `jobs.run` RPC.
 *
 * Persistence: one JSON file per job under `<pluginJobs>/<pluginId>/<jobId>.json`.
 * One-shot jobs (`runAt` only) are removed after firing; interval jobs keep
 * their file and advance `nextRunAt` monotonically.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { nextCronAfter, parseCron } from '../lib/cron.js';
import { AppError, ErrorCodes, randomToken } from '@neotavern/shared';
import { Type } from '@sinclair/typebox';
import type { PluginEventBus } from '@neotavern/plugin-sdk';
import type { AppContext, TypedApp } from '../types.js';
import type { CapabilityBroker } from '../plugin/capabilityBroker.js';
import type { BackendPluginHost } from '../plugin/backendHost.js';

/** Wire event of a due job (bus → SSE → kernel `jobs.run`; bus → worker). */
export const JOB_DUE_EVENT = 'plugin.job.due';
export interface JobDuePayload {
  pluginId: string;
  jobId: string;
  name: string;
  payload?: unknown;
}

const MAX_JOBS_PER_PLUGIN = 100;
const MAX_NAME_LENGTH = 200;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 365 * 24 * 3600 * 1000;
const MAX_RUN_AT_MS = Date.now() + 10 * 365 * 24 * 3600 * 1000;
const SCAN_INTERVAL_MS = 1_000;
// Rev4 stage 5: retries + DLQ.
const MAX_RETRIES = 20;
const MIN_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 3_600_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_ACK_TIMEOUT_MS = 5 * 60_000;
/** Path segments must be safe directory/file names (jobs dir is scanned). */
const ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,127}$/i;

export type JobStatus = 'active' | 'failed';

export interface JobRecord {
  jobId: string;
  pluginId: string;
  name: string;
  runAt?: number;
  intervalMs?: number;
  /** 5-field cron expression (rev4 stage 5). */
  cron?: string;
  payload?: unknown;
  createdAt: number;
  /** Wall-clock time of the next dispatch (`nextRunAt <= now` fires). */
  nextRunAt: number;
  /** Monotonic per-job dispatch counter (replay accounting). */
  runCount: number;
  /** Wall-clock of the last dispatch. */
  lastRunAt?: number;
  /** 'failed' jobs sit in the DLQ: never dispatched until retried. */
  status?: JobStatus;
  /** Consecutive failed attempts (retry accounting; reset on success). */
  attempts?: number;
  /** Max consecutive failures before the job moves to the DLQ. */
  maxRetries?: number;
  /** Base backoff; each retry doubles it (cap 1h). */
  retryDelayMs?: number;
  /** Wall-clock when a retry becomes dispatchable again. */
  nextRetryAt?: number;
  /** Wall-clock of the dispatch currently awaiting the plugin's ack. */
  dispatchAt?: number;
  lastError?: string;
  /** Wall-clock when the job entered the DLQ. */
  failedAt?: number;
}

/** Wire projection of one job (contract §2 `jobs.list`). */
export interface JobPublic {
  jobId: string;
  name: string;
  runAt?: number;
  intervalMs?: number;
  cron?: string;
  payload?: unknown;
  status: JobStatus;
  attempts: number;
  maxRetries?: number;
  lastError?: string;
  failedAt?: number;
}

function toPublic(record: JobRecord): JobPublic {
  return {
    jobId: record.jobId,
    name: record.name,
    ...(record.runAt === undefined ? {} : { runAt: record.runAt }),
    ...(record.intervalMs === undefined ? {} : { intervalMs: record.intervalMs }),
    ...(record.cron === undefined ? {} : { cron: record.cron }),
    ...(record.payload === undefined ? {} : { payload: record.payload }),
    status: record.status ?? 'active',
    attempts: record.attempts ?? 0,
    ...(record.maxRetries === undefined ? {} : { maxRetries: record.maxRetries }),
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
    ...(record.failedAt === undefined ? {} : { failedAt: record.failedAt }),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural re-validation: files under the jobs dir are untrusted input. */
function parseRecord(text: string): JobRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainRecord(raw)) return null;
  const jobId = raw['jobId'];
  const pluginId = raw['pluginId'];
  const name = raw['name'];
  const nextRunAt = raw['nextRunAt'];
  const runCount = raw['runCount'];
  const createdAt = raw['createdAt'];
  if (
    typeof jobId !== 'string' ||
    typeof pluginId !== 'string' ||
    typeof name !== 'string' ||
    typeof nextRunAt !== 'number' ||
    typeof runCount !== 'number' ||
    !Number.isSafeInteger(runCount) ||
    runCount < 0 ||
    typeof createdAt !== 'number'
  ) {
    return null;
  }
  const record: JobRecord = { jobId, pluginId, name, nextRunAt, runCount, createdAt };
  if (typeof raw['runAt'] === 'number') record.runAt = raw['runAt'];
  if (typeof raw['intervalMs'] === 'number') record.intervalMs = raw['intervalMs'];
  if (typeof raw['cron'] === 'string') record.cron = raw['cron'];
  if (typeof raw['lastRunAt'] === 'number') record.lastRunAt = raw['lastRunAt'];
  if (raw['payload'] !== undefined) record.payload = raw['payload'];
  if (raw['status'] === 'active' || raw['status'] === 'failed') record.status = raw['status'];
  if (typeof raw['attempts'] === 'number' && Number.isSafeInteger(raw['attempts'])) {
    record.attempts = raw['attempts'];
  }
  if (typeof raw['maxRetries'] === 'number' && Number.isSafeInteger(raw['maxRetries'])) {
    record.maxRetries = raw['maxRetries'];
  }
  if (typeof raw['retryDelayMs'] === 'number') record.retryDelayMs = raw['retryDelayMs'];
  if (typeof raw['nextRetryAt'] === 'number') record.nextRetryAt = raw['nextRetryAt'];
  if (typeof raw['dispatchAt'] === 'number') record.dispatchAt = raw['dispatchAt'];
  if (typeof raw['lastError'] === 'string') record.lastError = raw['lastError'];
  if (typeof raw['failedAt'] === 'number') record.failedAt = raw['failedAt'];
  return record;
}

export interface PluginJobStore {
  schedule(input: {
    pluginId: string;
    name: string;
    runAt?: number;
    intervalMs?: number;
    /** 5-field cron expression (rev4 stage 5); exclusive with runAt/intervalMs. */
    cron?: string;
    payload?: unknown;
    /** Retry budget: retries allowed after the initial failure (0 = none). */
    retries?: number;
    /** Base backoff in ms; each retry doubles it (default 5s, cap 1h). */
    retryDelayMs?: number;
  }): Promise<JobRecord>;
  list(pluginId: string): Promise<JobRecord[]>;
  cancel(pluginId: string, jobId: string): Promise<void>;
  remove(pluginId: string, jobId: string): Promise<boolean>;
  /**
   * Report the outcome of a dispatch (rev4 stage 5). `ok: false` schedules a
   * backoff retry or moves the job to the DLQ when retries are exhausted.
   * Idempotent: acks for missing/finished/failed jobs are no-ops.
   */
  ack(
    pluginId: string,
    jobId: string,
    outcome: { ok: boolean; error?: string },
  ): Promise<{ acknowledged: boolean }>;
  /** Re-enqueue a DLQ job: active, attempts reset, fires on the next scan. */
  retry(pluginId: string, jobId: string): Promise<JobRecord | null>;
}

export interface PluginJobsRunner {
  /** Fire every job already due right now without waiting for the next tick. */
  scanOnce(): Promise<void>;
  stop(): void;
}

export interface PluginJobsManager extends PluginJobStore {
  runner: PluginJobsRunner;
}

/**
 * Jobs store + periodic due-scanner (contract §2). The 1s scan reads every
 * plugin's job directory, emits due jobs, then either deletes one-shots or
 * advances interval jobs. Overlapping scans are skipped (never pile up).
 */
export function createPluginJobsManager(
  events: PluginEventBus,
  paths: Pick<AppContext['paths'], 'pluginJobs'>,
  options: { scanIntervalMs?: number; now?: () => number; ackTimeoutMs?: number } = {},
): PluginJobsManager {
  const root = paths.pluginJobs;
  const now = options.now ?? (() => Date.now());

  const dirFor = (pluginId: string): string => join(root, pluginId);
  const fileFor = (pluginId: string, jobId: string): string =>
    join(dirFor(pluginId), `${jobId}.json`);

  const writeAtomic = async (record: JobRecord): Promise<void> => {
    if (!ID_RE.test(record.pluginId) || !ID_RE.test(record.jobId)) {
      throw new AppError({ code: ErrorCodes.BAD_REQUEST, params: { reason: 'JOB_ID_INVALID' } });
    }
    const file = fileFor(record.pluginId, record.jobId);
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.partial-${randomToken(8)}`;
    try {
      await writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  };

  const readDir = async (pluginId: string): Promise<JobRecord[]> => {
    if (!ID_RE.test(pluginId)) return [];
    let entries: string[];
    try {
      entries = await readdir(dirFor(pluginId));
    } catch {
      return [];
    }
    const records: JobRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const jobId = entry.slice(0, -'.json'.length);
      if (!ID_RE.test(jobId)) continue;
      const text = await readFile(join(dirFor(pluginId), entry), 'utf8').catch(() => null);
      if (text === null) continue;
      const record = parseRecord(text);
      if (record && record.pluginId === pluginId && record.jobId === jobId) records.push(record);
    }
    return records;
  };

  /** Exponential backoff for attempt N (1-based); capped at 1h. */
  const backoffFor = (record: JobRecord, attempt: number): number => {
    const base = record.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    return Math.min(base * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
  };

  /** One failed attempt: schedule a backoff retry or move to the DLQ. */
  const recordFailure = async (
    record: JobRecord,
    error: string,
    timestamp: number,
  ): Promise<void> => {
    const attempts = (record.attempts ?? 0) + 1;
    const maxRetries = record.maxRetries ?? 0;
    // `maxRetries` is the retry budget: after the initial failure the job
    // may fail `maxRetries` more times before landing in the DLQ.
    if (attempts > maxRetries) {
      await writeAtomic({
        ...record,
        status: 'failed',
        attempts,
        lastError: error,
        failedAt: timestamp,
        dispatchAt: undefined,
        nextRetryAt: undefined,
      });
    } else {
      await writeAtomic({
        ...record,
        attempts,
        lastError: error,
        dispatchAt: undefined,
        nextRetryAt: timestamp + backoffFor(record, attempts),
      });
    }
  };

  /** Successful ack: delete one-shots, advance interval/cron schedules. */
  const recordSuccess = async (record: JobRecord, timestamp: number): Promise<void> => {
    const base = {
      ...record,
      attempts: 0,
      lastError: undefined,
      dispatchAt: undefined,
      nextRetryAt: undefined,
    };
    if (record.intervalMs !== undefined) {
      await writeAtomic({
        ...base,
        // Advance monotonically: missed ticks never burst into replays.
        nextRunAt: Math.max(record.nextRunAt + record.intervalMs, timestamp + record.intervalMs),
      });
    } else if (record.cron !== undefined) {
      await writeAtomic({
        ...base,
        nextRunAt: nextCronAfter(timestamp, parseCron(record.cron)),
      });
    } else {
      await rm(fileFor(record.pluginId, record.jobId), { force: true });
    }
  };

  const store: PluginJobStore = {
    async schedule(input) {
      const name = input.name.trim();
      if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
        throw new AppError({
          code: ErrorCodes.BAD_REQUEST,
          params: { reason: 'JOB_NAME_INVALID', max: MAX_NAME_LENGTH },
        });
      }
      if (input.runAt === undefined && input.intervalMs === undefined && input.cron === undefined) {
        throw new AppError({
          code: ErrorCodes.BAD_REQUEST,
          params: { reason: 'JOB_SCHEDULE_INVALID' },
        });
      }
      if (
        (input.runAt !== undefined ? 1 : 0) +
          (input.intervalMs !== undefined ? 1 : 0) +
          (input.cron !== undefined ? 1 : 0) >
        1
      ) {
        throw new AppError({
          code: ErrorCodes.BAD_REQUEST,
          params: { reason: 'JOB_SCHEDULE_EXCLUSIVE' },
        });
      }
      if (input.cron !== undefined) {
        try {
          parseCron(input.cron);
        } catch {
          throw new AppError({
            code: ErrorCodes.BAD_REQUEST,
            params: { reason: 'JOB_CRON_INVALID', cron: input.cron },
          });
        }
      }
      if (
        input.retries !== undefined &&
        (!Number.isSafeInteger(input.retries) || input.retries < 0 || input.retries > MAX_RETRIES)
      ) {
        throw new AppError({
          code: ErrorCodes.BAD_REQUEST,
          params: { reason: 'JOB_RETRIES_INVALID', max: MAX_RETRIES },
        });
      }
      if (
        input.retryDelayMs !== undefined &&
        (!Number.isSafeInteger(input.retryDelayMs) ||
          input.retryDelayMs < MIN_RETRY_DELAY_MS ||
          input.retryDelayMs > MAX_RETRY_DELAY_MS)
      ) {
        throw new AppError({
          code: ErrorCodes.BAD_REQUEST,
          params: {
            reason: 'JOB_RETRY_DELAY_INVALID',
            min: MIN_RETRY_DELAY_MS,
            max: MAX_RETRY_DELAY_MS,
          },
        });
      }
      if (
        input.runAt !== undefined &&
        (!Number.isSafeInteger(input.runAt) || input.runAt <= 0 || input.runAt > MAX_RUN_AT_MS)
      ) {
        throw new AppError({
          code: ErrorCodes.BAD_REQUEST,
          params: { reason: 'JOB_RUN_AT_INVALID' },
        });
      }
      if (
        input.intervalMs !== undefined &&
        (!Number.isSafeInteger(input.intervalMs) ||
          input.intervalMs < MIN_INTERVAL_MS ||
          input.intervalMs > MAX_INTERVAL_MS)
      ) {
        throw new AppError({
          code: ErrorCodes.BAD_REQUEST,
          params: {
            reason: 'JOB_INTERVAL_INVALID',
            min: MIN_INTERVAL_MS,
            max: MAX_INTERVAL_MS,
          },
        });
      }
      if (input.payload !== undefined) {
        const serialized = JSON.stringify(input.payload);
        if (serialized === undefined || Buffer.byteLength(serialized) > MAX_PAYLOAD_BYTES) {
          throw new AppError({
            code: ErrorCodes.FILE_TOO_LARGE,
            params: { limitBytes: MAX_PAYLOAD_BYTES },
          });
        }
      }
      const existing = await readDir(input.pluginId);
      if (existing.length >= MAX_JOBS_PER_PLUGIN) {
        throw new AppError({
          code: ErrorCodes.BAD_REQUEST,
          params: { reason: 'JOB_LIMIT_EXCEEDED', limit: MAX_JOBS_PER_PLUGIN },
        });
      }
      const timestamp = now();
      const record: JobRecord = {
        jobId: randomToken(16),
        pluginId: input.pluginId,
        name,
        // Interval jobs fire one interval after scheduling; one-shots fire
        // at their runAt (already due → next scan fires them immediately);
        // cron jobs fire at the next cron match.
        nextRunAt:
          input.intervalMs !== undefined
            ? timestamp + input.intervalMs
            : input.cron !== undefined
              ? nextCronAfter(timestamp, parseCron(input.cron))
              : (input.runAt as number),
        runCount: 0,
        createdAt: timestamp,
        ...(input.runAt === undefined ? {} : { runAt: input.runAt }),
        ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
        ...(input.cron === undefined ? {} : { cron: input.cron }),
        ...(input.payload === undefined ? {} : { payload: input.payload }),
        ...(input.retries === undefined ? {} : { maxRetries: input.retries }),
        ...(input.retryDelayMs === undefined ? {} : { retryDelayMs: input.retryDelayMs }),
      };
      await writeAtomic(record);
      return record;
    },

    async list(pluginId) {
      return (await readDir(pluginId)).sort((left, right) => left.nextRunAt - right.nextRunAt);
    },

    async cancel(pluginId, jobId) {
      if (!ID_RE.test(pluginId) || !ID_RE.test(jobId)) {
        throw new AppError({ code: ErrorCodes.NOT_FOUND, params: { jobId } });
      }
      const file = fileFor(pluginId, jobId);
      const text = await readFile(file, 'utf8').catch(() => null);
      if (text === null) {
        throw new AppError({ code: ErrorCodes.NOT_FOUND, params: { jobId } });
      }
      await rm(file, { force: true });
    },

    async remove(pluginId, jobId) {
      if (!ID_RE.test(pluginId) || !ID_RE.test(jobId)) return false;
      const file = fileFor(pluginId, jobId);
      const text = await readFile(file, 'utf8').catch(() => null);
      if (text === null) return false;
      await rm(file, { force: true });
      return true;
    },

    ack: async (pluginId, jobId, outcome) => {
      if (!ID_RE.test(pluginId) || !ID_RE.test(jobId)) return { acknowledged: false };
      const record = await readDir(pluginId).then(
        (records) => records.find((entry) => entry.jobId === jobId) ?? null,
      );
      if (!record || record.dispatchAt === undefined) {
        // Finished, never-dispatched or DLQ: nothing to acknowledge.
        return { acknowledged: false };
      }
      const timestamp = now();
      if (outcome.ok) {
        await recordSuccess(record, timestamp);
      } else {
        await recordFailure(record, outcome.error?.trim() || 'job-failed', timestamp);
      }
      return { acknowledged: true };
    },

    retry: async (pluginId, jobId) => {
      if (!ID_RE.test(pluginId) || !ID_RE.test(jobId)) return null;
      const record = await readDir(pluginId).then(
        (records) => records.find((entry) => entry.jobId === jobId) ?? null,
      );
      if (!record) return null;
      await writeAtomic({
        ...record,
        status: 'active',
        attempts: 0,
        lastError: undefined,
        failedAt: undefined,
        dispatchAt: undefined,
        nextRetryAt: undefined,
        // Fire on the next scan.
        nextRunAt: now(),
      });
      return (await readDir(pluginId).then(
        (records) => records.find((entry) => entry.jobId === jobId) ?? null,
      )) as JobRecord | null;
    },
  };

  let scanning = false;
  const scanOnce = async (): Promise<void> => {
    if (scanning) return; // a slow dispatch must not overlap itself
    scanning = true;
    try {
      const timestamp = now();
      const directories = await readdir(root).catch(() => []);
      for (const pluginId of directories) {
        if (!ID_RE.test(pluginId)) continue;
        for (const record of await readDir(pluginId)) {
          if (record.status === 'failed') continue; // DLQ: only retry() moves it.
          if (record.dispatchAt !== undefined) {
            // A dispatch is awaiting the plugin's ack. A missing ack times
            // out and counts as a failed attempt (crash recovery).
            const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
            if (record.dispatchAt + ackTimeoutMs > timestamp) continue;
            await recordFailure(record, 'ack-timeout', timestamp);
            continue;
          }
          if (record.nextRetryAt !== undefined && record.nextRetryAt > timestamp) continue;
          if (record.nextRunAt > timestamp) continue;
          const due: JobDuePayload = {
            pluginId,
            jobId: record.jobId,
            name: record.name,
            ...(record.payload === undefined ? {} : { payload: record.payload }),
          };
          const ackBased = (record.maxRetries ?? 0) > 0;
          if (ackBased) {
            // Persist the in-flight marker before publishing. A fast sandbox
            // may acknowledge in the same event-loop turn; that ack must see
            // the dispatch instead of being mistaken for a stale early ack.
            await writeAtomic({
              ...record,
              runCount: record.runCount + 1,
              lastRunAt: timestamp,
              dispatchAt: timestamp,
            });
          }
          try {
            events.emit(JOB_DUE_EVENT, due);
          } catch {
            // A broken subscriber must not stall the runner.
          }
          if (ackBased) {
            // The persisted dispatch stays held until the plugin acknowledges.
          } else if (record.intervalMs !== undefined) {
            await writeAtomic({
              ...record,
              runCount: record.runCount + 1,
              lastRunAt: timestamp,
              nextRunAt: Math.max(
                record.nextRunAt + record.intervalMs,
                timestamp + record.intervalMs,
              ),
            });
          } else if (record.cron !== undefined) {
            await writeAtomic({
              ...record,
              runCount: record.runCount + 1,
              lastRunAt: timestamp,
              nextRunAt: nextCronAfter(timestamp, parseCron(record.cron)),
            });
          } else {
            // One-shot without retries: fired and done.
            await rm(fileFor(pluginId, record.jobId), { force: true });
          }
        }
      }
    } finally {
      scanning = false;
    }
  };

  const timer = setInterval(() => void scanOnce(), options.scanIntervalMs ?? SCAN_INTERVAL_MS);
  timer.unref?.();

  return {
    ...store,
    runner: {
      scanOnce,
      stop() {
        clearInterval(timer);
      },
    },
  };
}

function requireJobsCapability(broker: CapabilityBroker, pluginId: string): void {
  if (!broker.check(pluginId, { name: 'jobs.background' })) {
    throw new AppError({
      code: ErrorCodes.PLUGIN_PERMISSION_DENIED,
      params: { pluginId, permission: 'jobs.background' },
    });
  }
}

const jobParams = Type.Object({ id: Type.String(), jobId: Type.String() });
const jobListParams = Type.Object({ id: Type.String() });
const jobListResponse = Type.Object({
  items: Type.Array(
    Type.Object({
      jobId: Type.String(),
      name: Type.String(),
      runAt: Type.Optional(Type.Number()),
      intervalMs: Type.Optional(Type.Number()),
      cron: Type.Optional(Type.String()),
      payload: Type.Optional(Type.Unknown()),
      status: Type.Union([Type.Literal('active'), Type.Literal('failed')]),
      attempts: Type.Number(),
      maxRetries: Type.Optional(Type.Number()),
      lastError: Type.Optional(Type.String()),
      failedAt: Type.Optional(Type.Number()),
    }),
  ),
});
const jobCreateBody = Type.Object({
  name: Type.String(),
  runAt: Type.Optional(Type.Number()),
  intervalMs: Type.Optional(Type.Number()),
  cron: Type.Optional(Type.String()),
  payload: Type.Optional(Type.Unknown()),
  retries: Type.Optional(Type.Number()),
  retryDelayMs: Type.Optional(Type.Number()),
});
const jobCreateResponse = Type.Object({
  jobId: Type.String(),
  name: Type.String(),
  runAt: Type.Optional(Type.Number()),
  intervalMs: Type.Optional(Type.Number()),
  cron: Type.Optional(Type.String()),
  payload: Type.Optional(Type.Unknown()),
  status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('failed')])),
  attempts: Type.Optional(Type.Number()),
  maxRetries: Type.Optional(Type.Number()),
  lastError: Type.Optional(Type.String()),
  failedAt: Type.Optional(Type.Number()),
});
const jobAckBody = Type.Object({
  ok: Type.Boolean(),
  error: Type.Optional(Type.String({ maxLength: 2000 })),
});
const jobAckResponse = Type.Object({ acknowledged: Type.Boolean() });

/**
 * REST routes (contract §4): list / cancel / delete one plugin's background
 * jobs. All handlers gate on the `jobs.background` grant via the broker.
 * Also starts the due-scanner and wires bus→backend-process delivery.
 */
export async function registerPluginJobs(
  app: TypedApp,
  ctx: AppContext,
  broker: CapabilityBroker,
  backendHost: BackendPluginHost,
): Promise<PluginJobsManager> {
  const manager = createPluginJobsManager(ctx.events, { pluginJobs: ctx.paths.pluginJobs });

  // Backend plugins get due events through the worker's existing event.push
  // channel; the web side gets them through the SSE whitelist (events.ts).
  const unsubscribe = ctx.events.on(JOB_DUE_EVENT, (payload) => {
    const due = payload as JobDuePayload;
    backendHost.deliverEvent(due.pluginId, JOB_DUE_EVENT, due);
  });
  app.addHook('onClose', async () => {
    unsubscribe();
    manager.runner.stop();
  });

  app.get(
    '/api/v2/plugins/:id/jobs',
    {
      schema: { params: jobListParams, response: { 200: jobListResponse } },
    },
    async (request) => {
      const pluginId = request.params.id;
      requireJobsCapability(broker, pluginId);
      const items = (await manager.list(pluginId)).map(toPublic);
      return { items };
    },
  );

  // Web kernel `jobs.schedule` persists through this route (contract §2
  // requires server-side persistence; the kernel RPC delegates to it).
  app.post(
    '/api/v2/plugins/:id/jobs',
    {
      schema: {
        params: jobListParams,
        body: jobCreateBody,
        response: { 200: jobCreateResponse },
      },
    },
    async (request) => {
      requireJobsCapability(broker, request.params.id);
      return toPublic(
        await manager.schedule({
          pluginId: request.params.id,
          name: request.body.name,
          ...(request.body.runAt === undefined ? {} : { runAt: request.body.runAt }),
          ...(request.body.intervalMs === undefined ? {} : { intervalMs: request.body.intervalMs }),
          ...(request.body.cron === undefined ? {} : { cron: request.body.cron }),
          ...(request.body.payload === undefined ? {} : { payload: request.body.payload }),
          ...(request.body.retries === undefined ? {} : { retries: request.body.retries }),
          ...(request.body.retryDelayMs === undefined
            ? {}
            : { retryDelayMs: request.body.retryDelayMs }),
        }),
      );
    },
  );

  app.post(
    '/api/v2/plugins/:id/jobs/:jobId/ack',
    {
      schema: { params: jobParams, body: jobAckBody, response: { 200: jobAckResponse } },
    },
    async (request) => {
      requireJobsCapability(broker, request.params.id);
      return manager.ack(request.params.id, request.params.jobId, {
        ok: request.body.ok,
        ...(request.body.error === undefined ? {} : { error: request.body.error }),
      });
    },
  );

  app.post(
    '/api/v2/plugins/:id/jobs/:jobId/retry',
    {
      schema: { params: jobParams, response: { 200: jobCreateResponse } },
    },
    async (request) => {
      requireJobsCapability(broker, request.params.id);
      const record = await manager.retry(request.params.id, request.params.jobId);
      if (!record) {
        throw new AppError({
          code: ErrorCodes.NOT_FOUND,
          params: { jobId: request.params.jobId },
        });
      }
      return toPublic(record);
    },
  );

  app.post(
    '/api/v2/plugins/:id/jobs/:jobId/cancel',
    { schema: { params: jobParams, response: { 200: Type.Object({}) } } },
    async (request) => {
      requireJobsCapability(broker, request.params.id);
      await manager.cancel(request.params.id, request.params.jobId);
      return {};
    },
  );

  app.delete(
    '/api/v2/plugins/:id/jobs/:jobId',
    {
      schema: {
        params: jobParams,
        response: { 200: Type.Object({ deleted: Type.Boolean() }) },
      },
    },
    async (request) => {
      requireJobsCapability(broker, request.params.id);
      const deleted = await manager.remove(request.params.id, request.params.jobId);
      return { deleted };
    },
  );

  return manager;
}
