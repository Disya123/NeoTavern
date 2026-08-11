/**
 * Rev4 multi-window example plugin (T3, apiVersion 2) — rev4 §J3.
 *
 * Demonstrates the background-singleton model: the plugin UI activates in
 * every window, but only the host-elected primary window runs the background
 * consumer (here: a KV counter). The election lives in the host
 * (`WindowRoleManager` over BroadcastChannel, lease expiry on death);
 * the plugin only reads the role and reacts to transitions:
 *  - `api.windows.role()` → `{role, windowId, installationId, isBackground}`;
 *  - `api.events.on('window.background.changed', …)` — host-generated push
 *    whenever the role changes (no capability, no SSE subscription);
 *  - the primary window writes `background.state` ({owner, ticks}) into the
 *    user-scope KV; secondaries write nothing — the KV proves the
 *    singleton, and the counter keeps ticking after a primary dies.
 *
 * The counter state lives in ONE KV key: `storage.kv.set` guards the whole
 * (plugin, scope) state row with a single CAS revision, so two sequential
 * sets would always conflict on the second write (read-modify-write CAS).
 */

const STATE_KEY = 'background.state';

const plugin = {
  async activate(api) {
    if (!api.windows) return;
    const kv = api.storage && api.storage.kv;
    const notify = api.notifications && api.notifications.show;

    let tickTimer = null;
    let owner = null;

    const writeTick = async () => {
      if (!kv || owner === null) return;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await kv.get('user', STATE_KEY).catch(() => null);
        const state =
          current && typeof current.value === 'object' && current.value !== null
            ? current.value
            : {};
        const ticks = typeof state.ticks === 'number' ? state.ticks : 0;
        try {
          await kv.set(
            'user',
            STATE_KEY,
            { owner, ticks: ticks + 1 },
            current && typeof current.revision === 'number' ? current.revision : undefined,
          );
          return;
        } catch (error) {
          if (!error || error.code !== 'REVISION_CONFLICT' || attempt === 2) throw error;
        }
      }
    };

    const applyRole = (snapshot) => {
      document.documentElement.setAttribute('data-bg-role', snapshot.role);
      if (snapshot.isBackground) {
        if (tickTimer) return; // already running
        owner = snapshot.windowId;
        tickTimer = setInterval(writeTick, 2000);
      } else {
        if (tickTimer) {
          clearInterval(tickTimer);
          tickTimer = null;
        }
        owner = null;
      }
    };

    const initial = await api.windows.role();
    applyRole(initial);
    const offRole = api.events.on('window.background.changed', (snapshot) => applyRole(snapshot));

    await api.commands.register(
      'rev4-multiwindow.role',
      { title: 'Rev4 multiwindow: show role', category: 'rev4' },
      async () => {
        const current = await api.windows.role();
        if (notify) {
          notify({
            title: 'Rev4 multiwindow',
            description: `role: ${current.role} window=${current.windowId}`,
            variant: 'info',
            timeoutMs: 8000,
          });
        }
      },
      { kernel: true },
    );

    await api.commands.register(
      'rev4-multiwindow.status',
      { title: 'Rev4 multiwindow: show background owner', category: 'rev4' },
      async () => {
        const current = await kv.get('user', STATE_KEY).catch(() => null);
        const state =
          current && typeof current.value === 'object' && current.value !== null
            ? current.value
            : {};
        const currentOwner = typeof state.owner === 'string' ? state.owner : '(none)';
        const ticks = typeof state.ticks === 'number' ? state.ticks : 0;
        if (notify) {
          notify({
            title: 'Rev4 multiwindow',
            description: `owner=${currentOwner} ticks=${ticks}`,
            variant: 'info',
            timeoutMs: 8000,
          });
        }
      },
      { kernel: true },
    );

    plugin.deactivate = () => {
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      offRole();
    };
  },

  // The per-activation closure installs the role handlers; this placeholder
  // keeps the plugin definition valid before activate() runs.
  async deactivate() {},
};

export default plugin;
