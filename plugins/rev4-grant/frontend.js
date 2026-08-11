/**
 * Rev4 runtime grant example plugin (T3, apiVersion 2).
 *
 * Demonstrates the rev4 §B2 capability consent round-trip:
 *  - `api.capabilities.request({ name: 'camera.request' })` — the host shows
 *    the consent dialog, persists the approved grant server-side and resolves
 *    with the grant; denial/timeout reject with `CAPABILITY_DENIED`;
 *  - `api.capabilities.granted('camera.request')` — live check; the sandbox
 *    grant list is refreshed on grant and on `onRevoked`.
 *
 * `camera.request` is intentionally NOT in the manifest: it can only be
 * obtained through the runtime consent UI, never at install time.
 */

export default {
  async activate(api) {
    if (!api.runtime || !api.runtime.supports('ui.commands', 1)) return;
    if (!api.capabilities || typeof api.capabilities.request !== 'function') return;

    const notify = api.notifications.show;

    const describeGrant = function (grant) {
      return (
        'name=' +
        grant.name +
        ' revision=' +
        grant.revision +
        ' scope=' +
        (grant.scope ? JSON.stringify(grant.scope) : 'none')
      );
    };

    await api.commands.register(
      'rev4-grant.request-camera',
      { title: 'Rev4 grant: request camera', category: 'rev4' },
      async () => {
        try {
          const grant = await api.capabilities.request({ name: 'camera.request' });
          notify({
            title: 'Rev4 grant',
            description: 'granted: ' + describeGrant(grant),
            variant: 'success',
            timeoutMs: 6000,
          });
        } catch (error) {
          notify({
            title: 'Rev4 grant',
            description:
              'denied: ' +
              ((error && error.code) || 'INTERNAL') +
              ' reason=' +
              JSON.stringify((error && error.details) || {}),
            variant: 'error',
            timeoutMs: 6000,
          });
        }
      },
      { kernel: true },
    );

    await api.commands.register(
      'rev4-grant.check-camera',
      { title: 'Rev4 grant: check camera', category: 'rev4' },
      async () => {
        const granted = api.capabilities.granted('camera.request');
        notify({
          title: 'Rev4 grant',
          description: 'camera.request granted = ' + granted,
          variant: granted ? 'success' : 'warning',
          timeoutMs: 5000,
        });
      },
      { kernel: true },
    );
  },
};
