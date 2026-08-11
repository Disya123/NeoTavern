/**
 * Rev4 tools example plugin (T3, apiVersion 2).
 *
 * A small command palette toolkit that demonstrates the rev4 kernel
 * integration surface:
 *  - `api.commands.register` (capability `ui.commands`): palette commands
 *    with a stable `commandId` and runner isolation (the host runs the runner
 *    through the sandbox RPC, never by calling into plugin internals);
 *  - `api.notifications.show` / `api.notifications.dismiss` (capability
 *    `notifications.show`): host-drawn toasts the plugin cannot fake;
 *  - `api.events.subscribe` (rev4 §E1): kernel-port subscription to
 *    whitelisted app events — here `chat.opened`, no capability required
 *    (only chat-content events gate on `chats.read.current`);
 *  - `api.limits()` and `api.runtime.supports(...)`: explicit degradation
 *    instead of silent fallback (rev4 invariant 8).
 *
 * Every registration is host-tracked; the host disposes it on deactivate or
 * uninstall, so the plugin keeps no cleanup state of its own.
 */

const TOOL_RUNS = 'rev4-tools';

export default {
  async activate(api) {
    // Kernel events slice: subscribe before anything else so the sandbox
    // never misses an app event after activation. Cleanup is host-managed
    // (subscriptions live in the session scope).
    let chatOpenedCount = 0;
    if (api.events && typeof api.events.subscribe === 'function') {
      api.events
        .subscribe('chat.opened', function () {
          chatOpenedCount += 1;
        })
        .catch(function () {});
    }

    if (!api.runtime || !api.runtime.supports('ui.commands', 1)) return;

    const notify = api.notifications.show;
    let lastDismiss = null;

    await api.commands.register(
      'rev4-tools.now',
      { title: 'Rev4 tools: now', category: 'rev4' },
      async () => {
        const now = new Date();
        lastDismiss = notify({
          title: 'Rev4 tools',
          description:
            'local=' + now.toLocaleTimeString() + ' iso=' + now.toISOString().slice(11, 19) + 'Z',
          variant: 'info',
          timeoutMs: 4000,
        });
      },
      { kernel: true },
    );
    await api.commands.register(
      'rev4-tools.roll',
      { title: 'Rev4 tools: roll d20', category: 'rev4' },
      async () => {
        const roll = 1 + Math.floor(Math.random() * 20);
        lastDismiss = notify({
          title: 'Rev4 tools',
          description: 'd20 = ' + roll,
          variant: roll === 20 ? 'success' : 'info',
          timeoutMs: 5000,
        });
      },
      { kernel: true },
    );
    await api.commands.register(
      'rev4-tools.limits',
      { title: 'Rev4 tools: show limits', category: 'rev4' },
      async () => {
        const limits = api.limits();
        const storage = (limits && limits.storage) || {};
        const workers = (limits && limits.workers) || {};
        lastDismiss = notify({
          title: 'Rev4 tools',
          description:
            'kvBytes=' +
            storage.kvBytes +
            ' blobBytes=' +
            storage.blobBytes +
            ' maxMessageBytes=' +
            workers.maxMessageBytes,
          variant: 'info',
          timeoutMs: 5000,
        });
      },
      { kernel: true },
    );
    await api.commands.register(
      'rev4-tools.diagnostics',
      { title: 'Rev4 tools: show diagnostics', category: 'rev4' },
      async () => {
        const snapshot = await api.diagnostics.get();
        notify({
          title: 'Rev4 tools',
          description:
            'protocol=' +
            snapshot.protocolVersion +
            ' sdk=' +
            snapshot.sdkVersion +
            ' instanceId=' +
            snapshot.instanceId +
            ' features=' +
            Object.keys(snapshot.features).length +
            ' grants=' +
            snapshot.grants.length,
          variant: 'info',
          timeoutMs: 6000,
        });
      },
      { kernel: true },
    );
    await api.commands.register(
      'rev4-tools.dismiss',
      { title: 'Rev4 tools: dismiss last toast', category: 'rev4' },
      async () => {
        if (lastDismiss) lastDismiss();
        lastDismiss = null;
      },
      { kernel: true },
    );
    await api.commands.register(
      'rev4-tools.events',
      { title: 'Rev4 tools: show events', category: 'rev4' },
      async () => {
        notify({
          title: 'Rev4 tools',
          description: 'chat opened events: ' + chatOpenedCount,
          variant: 'info',
          timeoutMs: 4000,
        });
      },
      { kernel: true },
    );
    // Count invocations without any host permission: run once and forget.
    await api.commands.register(
      'rev4-tools.run-count',
      { title: 'Rev4 tools: invoke counter', category: 'rev4' },
      async () => {
        window.sessionStorage.setItem(
          TOOL_RUNS,
          String(Number(window.sessionStorage.getItem(TOOL_RUNS) ?? '0') + 1),
        );
        notify({
          title: 'Rev4 tools',
          description:
            'palette invocations this session: ' + window.sessionStorage.getItem(TOOL_RUNS),
          variant: 'info',
          timeoutMs: 3000,
        });
      },
      { kernel: true },
    );
  },
};
