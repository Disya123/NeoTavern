/**
 * Rev4 OAuth example plugin (T3, apiVersion 2).
 *
 * Demonstrates host-mediated OAuth (rev4 §K5):
 *  - `api.auth.list/get/connect/revoke` (capability `auth.connections`):
 *    server-stored connections for the service declared in the manifest
 *    `authClients`. The host builds the authorization-code + PKCE URL and
 *    opens the consent in a new tab; the server exchanges the code, so
 *    plugin code never sees token values.
 *  - `api.network.fetch(..., { connectionId })` (capability `auth.connections`
 *    plus the network allowlist): an authenticated fetch proxied by the host
 *    — the sandbox only sees the response, never the Authorization header.
 *
 * The user completes the OAuth consent in the host's connection manager
 * (Plugins → Connections). The `rev4-auth.check` command below runs a
 * signed request once a connection exists and reports the verified account.
 */

const CHECK_ENDPOINT = 'http://127.0.0.1:8080/me';

export default {
  async activate(api) {
    if (!api.runtime || !api.runtime.supports('auth.connections', 1)) return;
    const notify = api.notifications.show;

    await api.commands.register(
      'rev4-auth.list',
      { title: 'Rev4 auth: list connections', category: 'rev4' },
      async () => {
        const connections = await api.auth.list();
        notify({
          title: 'Rev4 auth',
          description:
            'connections=' +
            connections.length +
            (connections[0]
              ? ' service=' + connections[0].serviceId + ' status=' + connections[0].status
              : ' (none — open Plugins → Connections to sign in)'),
          variant: 'info',
          timeoutMs: 6000,
        });
      },
      { kernel: true },
    );

    await api.commands.register(
      'rev4-auth.check',
      { title: 'Rev4 auth: signed request', category: 'rev4' },
      async () => {
        const connections = await api.auth.list();
        const connection = connections.find(function (c) {
          return c.status === 'connected';
        });
        if (!connection) {
          notify({
            title: 'Rev4 auth',
            description: 'no active connection — open Plugins → Connections first',
            variant: 'warning',
            timeoutMs: 6000,
          });
          return;
        }
        try {
          const response = await api.network.fetch(CHECK_ENDPOINT, {
            method: 'GET',
            connectionId: connection.connectionId,
          });
          notify({
            title: 'Rev4 auth',
            description: 'status=' + response.status + ' body=' + response.bodyText.slice(0, 200),
            variant: response.status === 200 ? 'success' : 'warning',
            timeoutMs: 6000,
          });
        } catch (error) {
          const detail =
            error && typeof error === 'object' && 'code' in error
              ? String(error.code)
              : error && error instanceof Error
                ? error.message
                : 'unknown';
          notify({
            title: 'Rev4 auth',
            description: 'signed request failed: ' + detail,
            variant: 'warning',
            timeoutMs: 8000,
          });
        }
      },
      { kernel: true },
    );
  },
};
