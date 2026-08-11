/**
 * Rev4 crash-isolation example plugin (T3, apiVersion 2) — rev4 §M3.
 *
 * Demonstrates the host crash detection and restart budget:
 *  - `rev4-crash.boom` navigates the sandbox document away
 *    (`location.replace('about:blank')`). The kernel session port closes,
 *    the host detects the lost sandbox (fast signal: port close; slow
 *    signal: heartbeat deadline) and restarts the frame under the restart
 *    budget, showing a host-owned crash notification. The fresh sandbox
 *    re-registers the command, so the plugin recovers on its own.
 *
 * A navigation is the honest simulation of a dead sandbox in the e2e
 * browser: a main-thread spin inside the iframe shares the renderer
 * process, so the host cannot schedule its heartbeat at all (the in-page
 * heartbeat deadline covers site-isolated Chrome, where the sandbox runs
 * in its own process).
 */

const plugin = {
  async activate(api) {
    if (!api.runtime || !api.runtime.supports('lifecycle.hooks', 1)) return;

    await api.commands.register(
      'rev4-crash.boom',
      { title: 'Rev4 crash: blow up the sandbox (host restarts it)', category: 'rev4' },
      async () => {
        // The sandbox document is replaced: the session port closes and the
        // host restarts the frame under the crash budget.
        window.location.replace('about:blank');
      },
      { kernel: true },
    );
  },

  deactivate() {},
};

export default plugin;
