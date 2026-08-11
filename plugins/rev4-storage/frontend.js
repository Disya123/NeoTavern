/**
 * Rev4 storage example plugin (T3, apiVersion 2).
 *
 * Demonstrates the rev4 kernel storage API only:
 *  - `api.storage.kv` JSON KV with CAS revisions (conflict retry loop);
 *  - `api.storage.blobs` content-addressed binary objects;
 *  - `api.commands` palette command registered through the kernel;
 *  - explicit degradation when the host has no rev4 kernel.
 *
 * Every registration is host-tracked; the host disposes them on
 * deactivate/uninstall, so the plugin keeps no cleanup state of its own.
 */

const SCOPE = 'user';
const KEY = 'visits';
const MAX_CAS_RETRIES = 3;

async function bumpVisits(api) {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const entry = await api.storage.kv.get(SCOPE, KEY);
    const current =
      entry && entry.value && typeof entry.value.count === 'number' ? entry.value.count : 0;
    try {
      const saved = await api.storage.kv.set(
        SCOPE,
        KEY,
        { count: current + 1, updatedAt: new Date().toISOString() },
        entry ? entry.revision : undefined,
      );
      return { count: current + 1, revision: saved.revision };
    } catch (error) {
      // Another writer won the race: re-read and retry (rev4 §E3).
      if (error && error.code === 'REVISION_CONFLICT') continue;
      throw error;
    }
  }
  throw new Error('REVISION_CONFLICT: too many concurrent writers');
}

async function snapshotBlob(api) {
  const entry = await api.storage.kv.get(SCOPE, KEY);
  const payload = JSON.stringify(entry && entry.value ? entry.value : { count: 0 });
  const bytes = new TextEncoder().encode(payload);
  return api.storage.blobs.put('visits-snapshot.json', 'application/json', bytes);
}

export default {
  async activate(api) {
    // Explicit degradation (rev4 invariant 8): no silent fallback.
    if (!api.runtime || !api.runtime.supports('storage.kv', 1)) return;

    api.ui.toolbarActions.register({
      id: 'rev4-storage-snapshot',
      title: 'Rev4 storage snapshot',
      run: async () => {
        const visits = await bumpVisits(api);
        const blob = await snapshotBlob(api);
        api.notify({
          title: 'Rev4 storage',
          description: 'visits=' + visits.count + ' blob=' + blob.blobId.slice(0, 8),
          variant: 'success',
        });
      },
    });

    if (api.runtime.supports('ui.commands', 1)) {
      await api.commands.register(
        'rev4-storage.show',
        { title: 'Show rev4 storage state' },
        async () => {
          const entry = await api.storage.kv.get(SCOPE, KEY);
          const list = await api.storage.blobs.list();
          api.notify({
            title: 'Rev4 storage',
            description:
              'kv=' +
              JSON.stringify(entry && entry.value ? entry.value : null) +
              ' blobs=' +
              (list && list.items ? list.items.length : 0),
            variant: 'info',
          });
        },
      );
    }
  },
};
