/**
 * Example backend plugin (ТЗ §7.3). Runs in an isolated worker process with
 * the Node Permission Model; talks to the host only through the provided API.
 * The route is proxied at GET /api/plugins/neotavern.example-hello/hello.
 */
export default {
  activate(api) {
    api.routes.get('/hello', () => ({
      ok: true,
      plugin: api.pluginId,
      message: 'Hello from the example backend plugin',
      time: Date.now(),
    }));
  },

  deactivate() {
    // Nothing to release: route registrations are cleaned up by the host.
  },
};
