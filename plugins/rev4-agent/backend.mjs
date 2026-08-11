/**
 * Rev4 agent example plugin — backend worker (T3, apiVersion 2).
 *
 * Runs in an isolated worker process. Demonstrates the backend surface:
 *  - `api.routes.{get,post}` (permission `server.routes`): REST routes are
 *    proxied by the host at /api/plugins/:pluginId/* and reachable from the
 *    sandboxed frontend only through `api.backend.invoke/request`;
 *  - `api.events.on('plugin.chat.updated', ...)`: the namespaced chat relay
 *    (contract §6 A5) carries identifiers only, never message content;
 *  - `api.storage`: host-backed KV, survives worker restarts;
 *  - `api.logger`: leveled host logs with the plugin id stamped in.
 *
 * The host disposes route/event registrations on deactivate or uninstall.
 */

const SEEN_KEY = 'rev4-agent.seen';

export default {
  activate(api) {
    api.logger.info('rev4-agent activated', { pluginId: api.pluginId });

    let startedAt = Date.now();
    let ticks = 0;

    api.routes.get('/agent/status', async () => ({
      ok: true,
      plugin: api.pluginId,
      uptimeMs: Date.now() - startedAt,
      ticks,
      seen: (await api.storage.get(SEEN_KEY)) || { chats: 0, messages: 0 },
    }));

    api.routes.post('/agent/tick', async (request) => {
      ticks += 1;
      const input = request && request.body && typeof request.body === 'object' ? request.body : {};
      const result = { ok: true, tick: ticks, echo: input, at: new Date().toISOString() };
      api.logger.debug('tick handled', result);
      return result;
    });

    api.routes.post('/agent/echo', async (request) => ({
      ok: true,
      echoed: request && request.body ? request.body : null,
    }));

    // Chat lifecycle relay: identifiers only — content stays behind the
    // host's `chats.read.*` gates and never reaches the worker. Storage
    // updates are serialized through a promise chain: the host KV is atomic
    // per write, but read-modify-write races need a queue.
    let updateChain = Promise.resolve();
    api.events.on('plugin.chat.updated', (payload) => {
      updateChain = updateChain.then(async () => {
        const seen = (await api.storage.get(SEEN_KEY)) || { chats: 0, messages: 0 };
        seen.messages += 1;
        await api.storage.set(SEEN_KEY, seen);
        api.logger.debug('chat.updated relayed', {
          chatId: payload && payload.chatId,
          messageId: payload && payload.messageId,
          role: payload && payload.role,
        });
      });
    });

    return {
      dispose() {},
    };
  },

  deactivate() {
    // Route/event registrations are cleaned up by the host.
  },
};
