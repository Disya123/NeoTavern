/**
 * Rev4 cross-plugin service consumer example (T3, apiVersion 2).
 *
 * Demonstrates consuming a service provided by another sandboxed plugin
 * (rev4 §D) through `services.connect`:
 *  - `api.services.list()` (capability `services.connect`) discovers what the
 *    host currently has registered;
 *  - `api.services.connect(serviceId)` binds a host-owned connection;
 *  - `api.services.invoke(connectionId, method, params)` routes the call to
 *    the PROVIDER's own sandbox and resolves with its return value;
 *  - `api.services.disconnect(connectionId)` releases the binding.
 *
 * Use together with `plugins/rev4-service` (the provider). When the provider
 * is disabled, calls degrade to a graceful notification instead of crashing.
 */

const PROVIDER_PREFIX = 'neotavern.rev4-service.greeter';

export default {
  async activate(api) {
    if (!api.runtime || !api.runtime.supports('services', 1)) return;
    const notify = api.notifications.show;

    function describeError(error) {
      if (error && typeof error === 'object' && 'code' in error) return String(error.code);
      if (error && error instanceof Error) return error.message;
      return 'unknown';
    }

    await api.commands.register(
      'rev4-service-client.call',
      { title: 'Rev4 service: call greeter', category: 'rev4' },
      async () => {
        try {
          const items = await api.services.list();
          const entry = items.find(function (service) {
            return service.serviceId === PROVIDER_PREFIX;
          });
          if (!entry) {
            notify({
              title: 'Rev4 service client',
              description: 'greeter not found — is the provider plugin providing it?',
              variant: 'warning',
              timeoutMs: 6000,
            });
            return;
          }
          const connection = await api.services.connect(entry.serviceId);
          try {
            const greet = await api.services.invoke(connection.connectionId, 'greet', {
              name: 'rev4',
              upper: true,
            });
            const echo = await api.services.invoke(connection.connectionId, 'echo', { value: 42 });
            notify({
              title: 'Rev4 service client',
              description: 'greet=' + JSON.stringify(greet) + ' echo=' + JSON.stringify(echo),
              variant: 'success',
              timeoutMs: 8000,
            });
          } finally {
            await api.services.disconnect(connection.connectionId).catch(function () {});
          }
        } catch (error) {
          notify({
            title: 'Rev4 service client',
            description: 'call failed: ' + describeError(error),
            variant: 'warning',
            timeoutMs: 8000,
          });
        }
      },
      { kernel: true },
    );

    await api.commands.register(
      'rev4-service-client.list',
      { title: 'Rev4 service: list', category: 'rev4' },
      async () => {
        try {
          const items = await api.services.list();
          notify({
            title: 'Rev4 service client',
            description:
              'services=' + items.length + (items[0] ? ' first=' + items[0].serviceId : ''),
            variant: 'info',
            timeoutMs: 6000,
          });
        } catch (error) {
          notify({
            title: 'Rev4 service client',
            description: 'list failed: ' + describeError(error),
            variant: 'warning',
            timeoutMs: 6000,
          });
        }
      },
      { kernel: true },
    );
  },
};
