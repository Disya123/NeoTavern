/**
 * Rev4 §2 plugin jobs: REST roundtrip, capability gating and the due-job
 * runner (fake timers). Uses a hand-rolled Fastify instance + in-memory db
 * so the broker and manager stay directly reachable.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppDatabase, type AppDatabase } from '@neotavern/db';
import { EventBus, type AppEventMap } from '@neotavern/plugin-sdk';
import { createLogger, sleep } from '@neotavern/shared';
import { createCapabilityBroker } from '../src/plugin/capabilityBroker.js';
import { createPluginJobsManager, registerPluginJobs } from '../src/plugins/pluginJobs.js';
import { createAppInstance, type AppContext, type TypedApp } from '../src/types.js';
import { registerErrorHandler } from '../src/lib/errors.js';

import type { BackendPluginHost } from '../src/plugin/backendHost.js';
import type { PluginJobsManager } from '../src/plugins/pluginJobs.js';
const PLUGIN_ID = 'test.jobs';

let database: AppDatabase;
let bus: EventBus<AppEventMap>;
let app: TypedApp;
let dataDir: string;
let manager: PluginJobsManager;

beforeEach(async () => {
  database = createAppDatabase(':memory:');
  bus = new EventBus<AppEventMap>();
  dataDir = mkdtempSync(join(tmpdir(), 'neotavern-jobs-test-'));
  const logger = createLogger({ level: 'error' });
  app = createAppInstance();
  registerErrorHandler(app, logger);
  const broker = createCapabilityBroker(database.repos.capabilityGrants, bus);
  const ctx = {
    database,
    events: bus,
    logger,
    paths: { pluginJobs: join(dataDir, 'plugin-jobs') },
  } as unknown as AppContext;
  const backendHostStub = { deliverEvent: () => {} } as unknown as BackendPluginHost;
  manager = await registerPluginJobs(app, ctx, broker, backendHostStub);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function grantJobs(): void {
  database.repos.plugins.install({
    id: PLUGIN_ID,
    name: PLUGIN_ID,
    version: '1.0.0',
    manifest: {},
    requestedPermissions: ['jobs.background'],
  });
  database.repos.capabilityGrants.grant({
    pluginId: PLUGIN_ID,
    name: 'jobs.background',
    scope: {},
  });
}

interface Envelope {
  code?: string;
  params?: Record<string, unknown>;
}

/** Wire shape of one job in list/create/retry responses (stage 5). */
interface JobItem {
  jobId: string;
  name: string;
  cron?: string;
  maxRetries?: number;
  status?: string;
  attempts?: number;
  runAt?: number;
  intervalMs?: number;
  lastError?: string;
}

describe('plugin jobs REST', () => {
  it('schedule -> list -> cancel -> delete roundtrip', async () => {
    grantJobs();
    const scheduled = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs`,
      payload: { name: 'nightly', runAt: Date.now() + 3_600_000, payload: { tag: 'x' } },
    });
    expect(scheduled.statusCode).toBe(200);
    const created = scheduled.json() as { jobId: string; name: string; payload?: unknown };
    expect(created.name).toBe('nightly');
    expect(created.payload).toEqual({ tag: 'x' });
    expect(typeof created.jobId).toBe('string');

    const listed = await app.inject({ method: 'GET', url: `/api/v2/plugins/${PLUGIN_ID}/jobs` });
    expect(listed.statusCode).toBe(200);
    const items = (listed.json() as { items: Array<{ jobId: string }> }).items;
    expect(items.map((item) => item.jobId)).toContain(created.jobId);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs/${created.jobId}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);
    const afterCancel = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs`,
    });
    expect((afterCancel.json() as { items: unknown[] }).items).toEqual([]);

    // Cancelled jobs are removed, so DELETE reports not-found.
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs/${created.jobId}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect((deleted.json() as { deleted: boolean }).deleted).toBe(false);

    // A live job deletes for real.
    const second = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs`,
      payload: { name: 'once', runAt: Date.now() + 3_600_000 },
    });
    const secondId = (second.json() as { jobId: string }).jobId;
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs/${secondId}`,
    });
    expect((removed.json() as { deleted: boolean }).deleted).toBe(true);
  });

  it('rejects every route without the jobs.background grant', async () => {
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs`,
      payload: { name: 'x', runAt: Date.now() + 1000 },
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as Envelope).code).toBe('PLUGIN_PERMISSION_DENIED');

    const listDenied = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs`,
    });
    expect(listDenied.statusCode).toBe(403);
  });

  it('validates schedule input', async () => {
    grantJobs();
    const noSchedule = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs`,
      payload: { name: 'never' },
    });
    expect(noSchedule.statusCode).toBe(400);

    const badName = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs`,
      payload: { name: '', runAt: Date.now() + 1000 },
    });
    expect(badName.statusCode).toBe(400);

    const missingName = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs`,
      payload: { runAt: Date.now() + 1000 },
    });
    expect(missingName.statusCode).toBe(422);

    const cancelUnknown = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs/nope/cancel`,
    });
    expect(cancelUnknown.statusCode).toBe(404);
  });

  it('schedules cron jobs and exposes retry/DLQ fields (stage 5)', async () => {
    grantJobs();
    const scheduled = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs`,
      payload: { name: 'nightly-cron', cron: '0 3 * * *', retries: 2, retryDelayMs: 5000 },
    });
    expect(scheduled.statusCode).toBe(200);
    const created = scheduled.json() as JobItem;
    expect(created.cron).toBe('0 3 * * *');
    expect(created.maxRetries).toBe(2);
    expect(created.status).toBe('active');
    expect(created.attempts).toBe(0);
    expect(created.runAt).toBeUndefined();
    expect(created.intervalMs).toBeUndefined();

    const listed = await app.inject({ method: 'GET', url: `/api/v2/plugins/${PLUGIN_ID}/jobs` });
    const listedItems = (listed.json() as { items: JobItem[] }).items;
    const item = listedItems.find((entry) => entry.jobId === created.jobId);
    expect(item?.cron).toBe('0 3 * * *');
  });

  it('rejects invalid cron and retry options (stage 5)', async () => {
    grantJobs();
    const badCron = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs`,
      payload: { name: 'x', cron: '61 * * * *' },
    });
    expect(badCron.statusCode).toBe(400);

    const exclusive = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs`,
      payload: { name: 'x', cron: '* * * * *', runAt: Date.now() + 1000 },
    });
    expect(exclusive.statusCode).toBe(400);

    const badRetries = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs`,
      payload: { name: 'x', runAt: Date.now() + 1000, retries: 21 },
    });
    expect(badRetries.statusCode).toBe(400);

    const badDelay = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs`,
      payload: { name: 'x', runAt: Date.now() + 1000, retryDelayMs: 500 },
    });
    expect(badDelay.statusCode).toBe(400);
  });

  it('ack and retry routes drive the retry state machine (stage 5)', async () => {
    grantJobs();
    const created = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs`,
      payload: { name: 'flaky', runAt: Date.now() - 1000, retries: 1 },
    });
    const jobId = (created.json() as { jobId: string }).jobId;

    await manager.runner.scanOnce();

    const failAck = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs/${jobId}/ack`,
      payload: { ok: false, error: 'boom' },
    });
    expect(failAck.statusCode).toBe(200);
    const failAckBody = failAck.json() as { acknowledged: boolean };
    expect(failAckBody.acknowledged).toBe(true);

    const list1 = await app.inject({ method: 'GET', url: `/api/v2/plugins/${PLUGIN_ID}/jobs` });
    const list1Items = (list1.json() as { items: JobItem[] }).items;
    const item1 = list1Items.find((entry) => entry.jobId === jobId);
    expect(item1?.attempts).toBe(1);
    expect(item1?.lastError).toBe('boom');
    expect(item1?.status).toBe('active');

    // Acks for jobs not awaiting a dispatch are idempotent no-ops.
    const lateAck = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs/${jobId}/ack`,
      payload: { ok: true },
    });
    const lateAckBody = lateAck.json() as { acknowledged: boolean };
    expect(lateAckBody.acknowledged).toBe(false);
    const ghostAck = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs/nope/ack`,
      payload: { ok: true },
    });
    expect(ghostAck.statusCode).toBe(200);

    const retried = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs/${jobId}/retry`,
    });
    expect(retried.statusCode).toBe(200);
    const retriedBody = retried.json() as JobItem;
    expect(retriedBody.status).toBe('active');
    expect(retriedBody.attempts).toBe(0);

    const ghostRetry = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/jobs/nope/retry`,
    });
    expect(ghostRetry.statusCode).toBe(404);
  });
});

describe('plugin jobs runner', () => {
  it('emits plugin.job.due for due jobs and removes one-shots', async () => {
    const runnerBus = new EventBus<AppEventMap>();
    const dir = mkdtempSync(join(tmpdir(), 'neotavern-jobs-runner-'));
    const runner = createPluginJobsManager(runnerBus, { pluginJobs: dir });
    const seen: unknown[] = [];
    runnerBus.on('plugin.job.due', (payload) => seen.push(payload));

    const record = await runner.schedule({
      pluginId: PLUGIN_ID,
      name: 'tick',
      runAt: Date.now() - 1000,
      payload: { n: 1 },
    });

    await runner.runner.scanOnce();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      pluginId: PLUGIN_ID,
      jobId: record.jobId,
      name: 'tick',
      payload: { n: 1 },
    });

    // One-shot is deleted after firing: no second dispatch.
    await runner.runner.scanOnce();
    expect(seen).toHaveLength(1);

    runner.runner.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('interval jobs refire on schedule without bursting', async () => {
    const runnerBus = new EventBus<AppEventMap>();
    const dir = mkdtempSync(join(tmpdir(), 'neotavern-jobs-interval-'));
    const runner = createPluginJobsManager(runnerBus, { pluginJobs: dir });
    const seen: unknown[] = [];
    runnerBus.on('plugin.job.due', (payload) => seen.push(payload));

    await runner.schedule({ pluginId: PLUGIN_ID, name: 'loop', intervalMs: 1000 });

    // Not due until one interval after scheduling.
    await runner.runner.scanOnce();
    expect(seen).toHaveLength(0);

    await sleep(1100);
    await runner.runner.scanOnce();
    expect(seen).toHaveLength(1);

    // Immediate re-scan must not replay the same tick.
    await runner.runner.scanOnce();
    expect(seen).toHaveLength(1);

    await sleep(1100);
    await runner.runner.scanOnce();
    expect(seen).toHaveLength(2);

    runner.runner.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('retries failed dispatches with backoff and moves exhausted jobs to the DLQ (stage 5)', async () => {
    const runnerBus = new EventBus<AppEventMap>();
    const dir = mkdtempSync(join(tmpdir(), 'neotavern-jobs-retry-'));
    let clock = 1_000_000_000_000;
    const runner = createPluginJobsManager(runnerBus, { pluginJobs: dir }, { now: () => clock });
    const seen: unknown[] = [];
    runnerBus.on('plugin.job.due', (payload) => seen.push(payload));

    const record = await runner.schedule({
      pluginId: PLUGIN_ID,
      name: 'flaky',
      runAt: clock - 1000,
      retries: 2,
      retryDelayMs: 2000,
    });

    await runner.runner.scanOnce();
    expect(seen).toHaveLength(1);
    // Held for the ack: still listed and an immediate re-scan must not refire.
    expect((await runner.list(PLUGIN_ID)).map((entry) => entry.jobId)).toContain(record.jobId);
    await runner.runner.scanOnce();
    expect(seen).toHaveLength(1);

    // First failure → attempt 1, retry after the base backoff.
    await runner.ack(PLUGIN_ID, record.jobId, { ok: false, error: 'boom-1' });
    const afterFail = (await runner.list(PLUGIN_ID))[0]!;
    expect(afterFail.attempts).toBe(1);
    expect(afterFail.nextRetryAt).toBe(clock + 2000);
    expect(afterFail.lastError).toBe('boom-1');
    expect(afterFail.status ?? 'active').toBe('active');

    // Not dispatchable before the backoff elapses.
    await runner.runner.scanOnce();
    expect(seen).toHaveLength(1);

    clock += 2000;
    await runner.runner.scanOnce();
    expect(seen).toHaveLength(2);

    // Second failure → attempt 2 of the retry budget → retry again with
    // doubled backoff (2000 * 2^1).
    await runner.ack(PLUGIN_ID, record.jobId, { ok: false, error: 'boom-2' });
    const afterSecondFail = (await runner.list(PLUGIN_ID))[0]!;
    expect(afterSecondFail.attempts).toBe(2);
    expect(afterSecondFail.nextRetryAt).toBe(clock + 4000);
    expect(afterSecondFail.status ?? 'active').toBe('active');

    clock += 4000;
    await runner.runner.scanOnce();
    expect(seen).toHaveLength(3);

    // Third failure → attempts 3 > maxRetries 2 → DLQ.
    await runner.ack(PLUGIN_ID, record.jobId, { ok: false, error: 'boom-3' });
    const inDlq = (await runner.list(PLUGIN_ID))[0]!;
    expect(inDlq.status).toBe('failed');
    expect(inDlq.attempts).toBe(3);
    expect(inDlq.failedAt).toBe(clock);
    expect(inDlq.lastError).toBe('boom-3');

    // DLQ jobs never dispatch again; acks become idempotent no-ops.
    clock += 3_600_000;
    await runner.runner.scanOnce();
    expect(seen).toHaveLength(3);
    const lateAck = await runner.ack(PLUGIN_ID, record.jobId, { ok: true });
    expect(lateAck.acknowledged).toBe(false);

    // retry() re-enqueues; the next scan fires it again.
    const retried = await runner.retry(PLUGIN_ID, record.jobId);
    expect(retried?.status).toBe('active');
    expect(retried?.attempts).toBe(0);
    await runner.runner.scanOnce();
    expect(seen).toHaveLength(4);

    // Success deletes the one-shot.
    await runner.ack(PLUGIN_ID, record.jobId, { ok: true });
    expect(await runner.list(PLUGIN_ID)).toHaveLength(0);

    runner.runner.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists the dispatch marker before a fast listener acknowledges it', async () => {
    const runnerBus = new EventBus<AppEventMap>();
    const dir = mkdtempSync(join(tmpdir(), 'neotavern-jobs-fast-ack-'));
    const runner = createPluginJobsManager(runnerBus, { pluginJobs: dir });
    let acknowledgement: Promise<{ acknowledged: boolean }> | undefined;
    runnerBus.on('plugin.job.due', (payload) => {
      acknowledgement = runner.ack(payload.pluginId, payload.jobId, { ok: true });
    });

    await runner.schedule({
      pluginId: PLUGIN_ID,
      name: 'fast-ack',
      runAt: Date.now() - 1,
      retries: 1,
    });
    await runner.runner.scanOnce();

    if (!acknowledgement) throw new Error('due event was not delivered');
    await expect(acknowledgement).resolves.toEqual({ acknowledged: true });
    expect(await runner.list(PLUGIN_ID)).toHaveLength(0);

    runner.runner.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  it('advances cron jobs on success and DLQs them on exhausted retries (stage 5)', async () => {
    const runnerBus = new EventBus<AppEventMap>();
    const dir = mkdtempSync(join(tmpdir(), 'neotavern-jobs-cron-'));
    let clock = Date.parse('2026-08-07T10:15:30Z');
    const runner = createPluginJobsManager(runnerBus, { pluginJobs: dir }, { now: () => clock });
    const seen: unknown[] = [];
    runnerBus.on('plugin.job.due', (payload) => seen.push(payload));

    const record = await runner.schedule({
      pluginId: PLUGIN_ID,
      name: 'quarter',
      cron: '15 * * * *',
      retries: 1,
    });
    // Next match after 10:15:30 is 11:15:00.
    expect(record.nextRunAt).toBe(Date.parse('2026-08-07T11:15:00Z'));

    clock = Date.parse('2026-08-07T11:15:00Z');
    await runner.runner.scanOnce();
    expect(seen).toHaveLength(1);
    // Held for the ack: no re-fire while awaiting.
    await runner.runner.scanOnce();
    expect(seen).toHaveLength(1);

    await runner.ack(PLUGIN_ID, record.jobId, { ok: true });
    const advanced = (await runner.list(PLUGIN_ID))[0]!;
    expect(advanced.nextRunAt).toBe(Date.parse('2026-08-07T12:15:00Z'));
    expect(advanced.attempts).toBe(0);

    // First failure consumes the retry budget → retry after the backoff.
    clock = Date.parse('2026-08-07T12:15:00Z');
    await runner.runner.scanOnce();
    await runner.ack(PLUGIN_ID, record.jobId, { ok: false, error: 'x' });
    const retrying = (await runner.list(PLUGIN_ID))[0]!;
    expect(retrying.status ?? 'active').toBe('active');
    expect(retrying.attempts).toBe(1);

    // Second failure exceeds the budget → DLQ (never dispatched again).
    clock += 5000;
    await runner.runner.scanOnce();
    expect(seen).toHaveLength(3);
    await runner.ack(PLUGIN_ID, record.jobId, { ok: false, error: 'y' });
    const failed = (await runner.list(PLUGIN_ID))[0]!;
    expect(failed.status).toBe('failed');
    expect(failed.failedAt).toBe(clock);

    clock += 3_600_000;
    await runner.runner.scanOnce();
    expect(seen).toHaveLength(3);

    runner.runner.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ack timeout recovers a stuck dispatch as a failed attempt (stage 5)', async () => {
    const runnerBus = new EventBus<AppEventMap>();
    const dir = mkdtempSync(join(tmpdir(), 'neotavern-jobs-acktimeout-'));
    let clock = 1_000_000_000_000;
    const runner = createPluginJobsManager(
      runnerBus,
      { pluginJobs: dir },
      { now: () => clock, ackTimeoutMs: 1000 },
    );
    const seen: unknown[] = [];
    runnerBus.on('plugin.job.due', (payload) => seen.push(payload));

    await runner.schedule({
      pluginId: PLUGIN_ID,
      name: 'crash',
      runAt: clock - 1,
      retries: 1,
    });
    await runner.runner.scanOnce();
    expect(seen).toHaveLength(1);

    clock += 1001;
    await runner.runner.scanOnce();
    expect(seen).toHaveLength(1); // no new dispatch, just the recovery
    const recovered = (await runner.list(PLUGIN_ID))[0]!;
    expect(recovered.attempts).toBe(1);
    expect(recovered.lastError).toBe('ack-timeout');
    expect(recovered.nextRetryAt).toBe(clock + 5000); // default backoff base

    runner.runner.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
