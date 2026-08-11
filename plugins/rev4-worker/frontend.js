/**
 * Rev4 worker example plugin (apiVersion 2, rev4 §C2).
 *
 * Demonstrates isolated compute workers:
 *  - `api.workers.spawn` with a manifest-declared entry
 *    (`workers: ["workers/double.js"]` in plugin.json) — the host verifies
 *    the bundle (size, MIME, allowlist) and streams it into the sandbox,
 *  - capability-gated degradation: without `compute.worker` the command
 *    reports the missing grant instead of failing silently (rev4 §0
 *    invariant 8);
 *  - message round-trip and explicit `terminate()`; the host also kills the
 *    worker on session teardown and capability revocation;
 *  - module workers: a `.mjs` entry (`workers/triple.mjs`) is constructed
 *    as `new Worker(blobUrl, { type: 'module' })` (ADR-0018).
 */
export default {
  async activate(api) {
    if (!api.runtime || !api.runtime.supports('ui.commands', 1)) return;

    const notify = api.notifications.show;

    async function spawnRoundTrip(entry, message) {
      const worker = await api.workers.spawn({ entry });
      try {
        return await new Promise((resolve, reject) => {
          const offError = worker.onError((errorMessage) => {
            offMessage();
            reject(new Error(errorMessage));
          });
          const offMessage = worker.onMessage((data) => {
            offError();
            resolve(data);
          });
          worker.postMessage(message);
        });
      } finally {
        worker.terminate();
      }
    }

    await api.commands.register(
      'rev4-worker.spawn',
      { title: 'Rev4 worker: spawn + round-trip', category: 'rev4' },
      async () => {
        if (!api.capabilities.granted('compute.worker')) {
          notify({
            title: 'Rev4 worker',
            description: 'compute.worker not granted',
            variant: 'error',
            timeoutMs: 5000,
          });
          return;
        }
        try {
          const reply = await spawnRoundTrip('workers/double.js', { value: 21 });
          notify({
            title: 'Rev4 worker',
            description: 'doubled 21 -> ' + reply.doubled,
            variant: 'success',
            timeoutMs: 5000,
          });
        } catch (error) {
          notify({
            title: 'Rev4 worker',
            description:
              'round-trip failed: ' + (error && error.message ? error.message : String(error)),
            variant: 'error',
            timeoutMs: 8000,
          });
        }
      },
      { kernel: true },
    );

    await api.commands.register(
      'rev4-worker.spawn-module',
      { title: 'Rev4 worker: module spawn + round-trip', category: 'rev4' },
      async () => {
        if (!api.capabilities.granted('compute.worker')) {
          notify({
            title: 'Rev4 worker',
            description: 'compute.worker not granted',
            variant: 'error',
            timeoutMs: 5000,
          });
          return;
        }
        try {
          const reply = await spawnRoundTrip('workers/triple.mjs', { value: 14 });
          notify({
            title: 'Rev4 worker',
            description: 'tripled 14 -> ' + reply.tripled,
            variant: 'success',
            timeoutMs: 5000,
          });
        } catch (error) {
          notify({
            title: 'Rev4 worker',
            description:
              'module round-trip failed: ' +
              (error && error.message ? error.message : String(error)),
            variant: 'error',
            timeoutMs: 8000,
          });
        }
      },
      { kernel: true },
    );

    await api.commands.register(
      'rev4-worker.granted',
      { title: 'Rev4 worker: capability state', category: 'rev4' },
      async () => {
        notify({
          title: 'Rev4 worker',
          description: 'compute.worker granted: ' + api.capabilities.granted('compute.worker'),
          variant: 'info',
          timeoutMs: 4000,
        });
      },
      { kernel: true },
    );
  },
};
