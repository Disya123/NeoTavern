/**
 * Rev4 lifecycle example plugin (T3, apiVersion 2) — rev4 §J2.
 *
 * Demonstrates the host-driven lifecycle hooks:
 *  - `suspend()` / `resume()` — the host calls them when the tab hides and
 *    returns (visibilitychange); the plugin mirrors the state on
 *    `<html data-lifecycle-state>` so e2e suites can observe it;
 *  - `beforeUpdate()` / `afterUpdate()` / `rollback()` / `uninstall()` —
 *    the host calls them around package updates (and on uninstall); each
 *    invocation is appended to a persistent KV log (`storage.user` scope)
 *    that survives the sandbox replacement, so the sequence is observable
 *    after an update and even after a failed update rolled back.
 *
 * The hooks are best-effort by contract: the host never waits for them —
 * a throwing hook degrades to `handled: false` and the state machine moves
 * on (explicit degradation, rev4 invariant 8).
 */

const LOG_KEY = 'lifecycle.log';

const plugin = {
  async activate(api) {
    if (!api.runtime || !api.runtime.supports('lifecycle.hooks', 1)) return;

    const kv = api.storage && api.storage.kv;
    const notify = api.notifications && api.notifications.show;

    // KV log with CAS retries: the host can invoke hooks while the plugin
    // is mid-update, and only one sandbox writes at a time in practice.
    const appendLog = async (entry) => {
      if (!kv) return;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await kv.get('user', LOG_KEY).catch(() => null);
        const log = Array.isArray(current && current.value) ? current.value : [];
        log.push(entry);
        try {
          await kv.set(
            'user',
            LOG_KEY,
            log,
            current && typeof current.revision === 'number' ? current.revision : undefined,
          );
          return;
        } catch (error) {
          if (!error || error.code !== 'REVISION_CONFLICT' || attempt === 2) throw error;
        }
      }
    };

    document.documentElement.setAttribute('data-lifecycle-state', 'active');

    // ── hooks ───────────────────────────────────────────────────────────────
    plugin.suspend = () => {
      document.documentElement.setAttribute('data-lifecycle-state', 'suspended');
    };
    plugin.resume = () => {
      document.documentElement.setAttribute('data-lifecycle-state', 'active');
    };
    plugin.beforeUpdate = async (detail) => {
      const info =
        detail && detail.version
          ? 'v' + detail.version + (detail.previousVersion ? ' <- v' + detail.previousVersion : '')
          : 'unknown';
      try {
        await appendLog({ hook: 'beforeUpdate', version: info, at: Date.now() });
      } catch (error) {
        if (notify) {
          notify({
            title: 'Rev4 lifecycle',
            description:
              'beforeUpdate KV error: ' + (error && error.code ? error.code : String(error)),
            variant: 'error',
            timeoutMs: 8000,
          });
        }
        return;
      }
      if (notify) {
        notify({
          title: 'Rev4 lifecycle',
          description: 'beforeUpdate ' + info,
          variant: 'info',
          timeoutMs: 8000,
        });
      }
    };
    plugin.afterUpdate = async (detail) => {
      const info = detail && detail.version ? 'v' + detail.version : 'unknown';
      try {
        await appendLog({ hook: 'afterUpdate', version: info, at: Date.now() });
      } catch (error) {
        if (notify) {
          notify({
            title: 'Rev4 lifecycle',
            description:
              'afterUpdate KV error: ' + (error && error.code ? error.code : String(error)),
            variant: 'error',
            timeoutMs: 8000,
          });
        }
        return;
      }
      if (notify) {
        notify({
          title: 'Rev4 lifecycle',
          description: 'afterUpdate ' + info,
          variant: 'info',
          timeoutMs: 8000,
        });
      }
    };
    plugin.rollback = (detail) => {
      const info = detail && detail.failedVersion ? 'failed v' + detail.failedVersion : 'unknown';
      void appendLog({ hook: 'rollback', version: info, at: Date.now() }).catch(() => {});
    };
    plugin.uninstall = () => {
      // Best-effort last word: the KV log is removed with the plugin, so
      // this only demonstrates that the hook fires before teardown.
      void appendLog({ hook: 'uninstall', at: Date.now() }).catch(() => {});
    };

    await api.commands.register(
      'rev4-lifecycle.log',
      { title: 'Rev4 lifecycle: show hook log', category: 'rev4' },
      async () => {
        const current = kv ? await kv.get('user', LOG_KEY).catch(() => null) : null;
        const log = Array.isArray(current && current.value) ? current.value : [];
        if (notify) {
          notify({
            title: 'Rev4 lifecycle',
            description:
              'hooks: ' + (log.length > 0 ? log.map((e) => e.hook).join(', ') : '(none)'),
            variant: 'info',
            timeoutMs: 6000,
          });
        }
      },
      { kernel: true },
    );
  },

  // The per-activation closure above installs the hooks; this placeholder
  // keeps the plugin definition valid before activate() runs.
  deactivate() {},
};

export default plugin;
