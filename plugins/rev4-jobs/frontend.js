/**
 * Rev4 jobs example plugin (T3, apiVersion 2) — rev4 stage 5.
 *
 * Demonstrates the background-job lifecycle with retries and the DLQ:
 *  - `api.jobs.schedule` with `retries`/`retryDelayMs` (one-shot or cron);
 *  - `api.jobs.onRun` handler reporting outcomes via `api.jobs.ack` — the
 *    job is held until the ack, retried with exponential backoff on failure,
 *    and moves to the DLQ when the retry budget is exhausted;
 *  - `api.jobs.list` / `api.jobs.retry` to inspect the DLQ and re-enqueue;
 *  - cron schedules (`minute hour dom month dow`) via `api.jobs.schedule`.
 *
 * The two retry demos use the same failure pattern (first two dispatches
 * ack `ok: false`): `flaky` has a retry budget of 2 and survives, `dlq`
 * has a budget of 1 and lands in the DLQ until retried.
 */

const attemptCounts = {};

export default {
  async activate(api) {
    if (!api.capabilities || !api.capabilities.granted('jobs.background')) return;

    const notify = api.runtime.supports('ui.notifications', 1) ? api.notifications.show : null;
    const failFor = (payload) =>
      payload && typeof payload['failFor'] === 'number' ? payload['failFor'] : 2;

    api.jobs.onRun(async (ctx) => {
      attemptCounts[ctx.jobId] = (attemptCounts[ctx.jobId] ?? 0) + 1;
      const attempt = attemptCounts[ctx.jobId];
      if (attempt <= failFor(ctx.payload)) {
        await api.jobs.ack(ctx.jobId, { ok: false, error: 'transient-' + attempt });
        return;
      }
      await api.jobs.ack(ctx.jobId, { ok: true });
      if (notify) {
        notify({
          title: 'Rev4 jobs',
          description:
            (ctx.payload && ctx.payload['marker']) +
            ' delivered after ' +
            attempt +
            ' dispatch(es)',
          variant: 'success',
          timeoutMs: 4000,
        });
      }
    });

    await api.commands.register(
      'rev4-jobs.flaky',
      { title: 'Rev4 jobs: flaky one-shot with retries', category: 'rev4' },
      async () => {
        const scheduled = await api.jobs.schedule({
          name: 'flaky',
          runAt: Date.now() + 1000,
          retries: 2,
          retryDelayMs: 1000,
          payload: { failFor: 2, marker: 'flaky' },
        });
        if (notify) {
          notify({
            title: 'Rev4 jobs',
            description: 'flaky scheduled ' + scheduled.jobId.slice(0, 8) + ' (retries 2)',
            variant: 'info',
            timeoutMs: 3000,
          });
        }
      },
      { kernel: true },
    );

    await api.commands.register(
      'rev4-jobs.cron',
      { title: 'Rev4 jobs: cron schedule then cancel', category: 'rev4' },
      async () => {
        // Every hour at the current UTC minute — far enough away that the
        // demo never waits for an actual fire.
        const minute = new Date().getUTCMinutes();
        const scheduled = await api.jobs.schedule({
          name: 'cron-demo',
          cron: minute + ' * * * *',
          payload: { failFor: 99, marker: 'cron' },
        });
        if (notify) {
          notify({
            title: 'Rev4 jobs',
            description:
              'cron scheduled ' + scheduled.jobId.slice(0, 8) + ' (' + minute + ' * * * *)',
            variant: 'info',
            timeoutMs: 3000,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
        try {
          const listed = await api.jobs.list();
          for (const job of (listed && listed.items) || []) {
            if (job && job.name === 'cron-demo') await api.jobs.cancel(job.jobId);
          }
          if (notify) {
            notify({
              title: 'Rev4 jobs',
              description: 'cron job cancelled',
              variant: 'info',
              timeoutMs: 3000,
            });
          }
        } catch (error) {
          if (notify) {
            notify({
              title: 'Rev4 jobs',
              description:
                'cron cancel failed: ' +
                String(error && error.message) +
                ' ' +
                JSON.stringify(error && error.details),
              variant: 'error',
              timeoutMs: 5000,
            });
          }
        }
      },
      { kernel: true },
    );

    await api.commands.register(
      'rev4-jobs.dlq',
      { title: 'Rev4 jobs: DLQ roundtrip', category: 'rev4' },
      async () => {
        const scheduled = await api.jobs.schedule({
          name: 'dlq-demo',
          runAt: Date.now() + 500,
          retries: 1,
          retryDelayMs: 1000,
          payload: { failFor: 2, marker: 'dlq' },
        });
        const jobId = scheduled.jobId;

        // Poll the job list until the exhausted retry budget lands it in
        // the DLQ (status 'failed'), then re-enqueue it.
        const dlqSeen = await new Promise((resolve) => {
          let tries = 0;
          const poll = async () => {
            tries += 1;
            const listed = await api.jobs.list();
            const job = ((listed && listed.items) || []).find((entry) => entry.jobId === jobId);
            if (job && job.status === 'failed') {
              resolve(job);
              return;
            }
            if (tries >= 24) {
              resolve(null);
              return;
            }
            setTimeout(poll, 500);
          };
          setTimeout(poll, 500);
        });

        if (!dlqSeen) {
          if (notify) {
            notify({
              title: 'Rev4 jobs',
              description: 'DLQ roundtrip timed out',
              variant: 'error',
              timeoutMs: 4000,
            });
          }
          return;
        }
        if (notify) {
          notify({
            title: 'Rev4 jobs',
            description:
              'job in DLQ: lastError=' + dlqSeen.lastError + ' attempts=' + dlqSeen.attempts,
            variant: 'warning',
            timeoutMs: 4000,
          });
        }
        await api.jobs.retry(jobId);

        // After the retry the next dispatch succeeds and the one-shot is
        // deleted; the delivery notification comes from the onRun handler.
      },
      { kernel: true },
    );
  },
};
