/**
 * Rev4 cross-plugin service provider example (T3, apiVersion 2).
 *
 * Demonstrates host-mediated services (rev4 §D):
 *  - `api.services.provide({ name, methods, handle })` (capability
 *    `services.provide`) publishes `neotavern.rev4-service.greeter`. The
 *    `handle` function runs in THIS sandbox realm whenever a consumer calls
 *    it — the host never forwards function objects across plugins.
 *  - The returned handle exposes `dispose()`, which unprovides the service
 *    and drops every consumer connection.
 *  - Consumers reach the service only through the host-prefixed id
 *    `neotavern.rev4-service.greeter`; squatting another plugin's id is
 *    impossible by construction.
 *
 * Use together with `plugins/rev4-service-client`, which connects and calls
 * this service from a second sandbox.
 */

export default {
  async activate(api) {
    if (!api.runtime || !api.runtime.supports('services', 1)) return;
    const notify = api.notifications.show;
    const SERVICE = 'greeter';
    let provided = null;

    function dispatch(request) {
      if (request.method === 'greet') {
        const name =
          request.params && typeof request.params.name === 'string' ? request.params.name : 'rev4';
        const upper = request.params && request.params.upper === true;
        return { message: upper ? 'HELLO, ' + name.toUpperCase() + '!' : 'Hello, ' + name + '!' };
      }
      if (request.method === 'echo') {
        return { value: request.params && request.params.value, echoed: true };
      }
      throw new Error('unknown method: ' + request.method);
    }

    await api.commands.register(
      'rev4-service.provide',
      { title: 'Rev4 service: provide greeter', category: 'rev4' },
      async () => {
        if (provided) {
          notify({
            title: 'Rev4 service',
            description: 'already providing ' + provided.serviceId,
            variant: 'info',
            timeoutMs: 6000,
          });
          return;
        }
        provided = await api.services.provide({
          name: SERVICE,
          version: '1.0.0',
          description: 'Greets callers from other sandboxed plugins',
          methods: ['greet', 'echo'],
          handle: dispatch,
        });
        notify({
          title: 'Rev4 service',
          description: 'providing ' + provided.serviceId,
          variant: 'success',
          timeoutMs: 6000,
        });
      },
      { kernel: true },
    );

    await api.commands.register(
      'rev4-service.unprovide',
      { title: 'Rev4 service: stop greeter', category: 'rev4' },
      async () => {
        if (!provided) {
          notify({
            title: 'Rev4 service',
            description: 'greeter is not provided',
            variant: 'warning',
            timeoutMs: 6000,
          });
          return;
        }
        const serviceId = provided.serviceId;
        await provided.dispose();
        provided = null;
        notify({
          title: 'Rev4 service',
          description: 'stopped ' + serviceId,
          variant: 'success',
          timeoutMs: 6000,
        });
      },
      { kernel: true },
    );
  },
};
