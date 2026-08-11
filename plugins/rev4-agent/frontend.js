/**
 * Rev4 agent example plugin вЂ” frontend (T3, apiVersion 2).
 *
 * Talks to its own backend worker exclusively through the host proxy
 * (`api.backend.invoke` в†’ /api/plugins/:pluginId/*): the sandbox never gets
 * direct network access to app endpoints. Demonstrates:
 *  - `api.backend.invoke(path, input)` JSON convenience layer;
 *  - `api.chats.current` / `api.chats.append` (capabilities
 *    `chats.read.current` / `chats.write.plugin`);
 *  - explicit degradation when `compute.backend` was not granted.
 */

export default {
  async activate(api) {
    if (!api.capabilities || !api.capabilities.granted('compute.backend')) return;

    const notify = api.runtime.supports('ui.notifications', 1) ? api.notifications.show : null;

    await api.commands.register(
      'rev4-agent.tick',
      { title: 'Rev4 agent: tick backend', category: 'rev4' },
      async () => {
        const result = await api.backend.invoke('/agent/tick', {
          source: 'command-palette',
          nonce: Math.floor(Math.random() * 1e6),
        });
        if (notify) {
          notify({
            title: 'Rev4 agent',
            description:
              'tick=' +
              String(result && result.tick) +
              ' echoed=' +
              JSON.stringify(result && result.echo),
            variant: 'success',
            timeoutMs: 4000,
          });
        }
      },
      { kernel: true },
    );
    await api.commands.register(
      'rev4-agent.status',
      { title: 'Rev4 agent: backend status', category: 'rev4' },
      async () => {
        const result = await api.backend.invoke('/agent/status');
        if (notify) {
          notify({
            title: 'Rev4 agent',
            description:
              'uptime=' +
              Math.round((result && result.uptimeMs) / 1000) +
              's ticks=' +
              String(result && result.ticks) +
              ' seen=' +
              JSON.stringify(result && result.seen),
            variant: 'info',
            timeoutMs: 5000,
          });
        }
      },
      { kernel: true },
    );
    await api.commands.register(
      'rev4-agent.append',
      { title: 'Rev4 agent: append plugin message', category: 'rev4' },
      async () => {
        const current = await api.chats.current();
        if (!current || !current.chatId) {
          throw new Error('no current chat');
        }
        const appended = await api.chats.append({
          chatId: current.chatId,
          content: '[rev4-agent] heartbeat ' + new Date().toISOString(),
        });
        if (notify) {
          notify({
            title: 'Rev4 agent',
            description: 'appended ' + appended.messageId.slice(0, 8),
            variant: 'success',
            timeoutMs: 3000,
          });
        }
      },
      { kernel: true },
    );
  },
};
