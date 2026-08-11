/**
 * rev4 plugin OAuth manager: lists the plugin's external service connections
 * stored server-side. Connect starts an authorization-code + PKCE flow in a
 * new tab; the server completes the token exchange, so plugin code never sees
 * tokens. Revoke wipes the stored credentials.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, DialogContent } from '@neotavern/ui';
import type { PluginAuthClient } from '@neotavern/plugin-sdk';
import {
  usePluginAuthConnect,
  usePluginAuthConnections,
  usePluginAuthRevoke,
} from '../api/hooks.js';

export interface PluginAuthDialogProps {
  pluginId: string | null;
  authClients: readonly PluginAuthClient[];
  onOpenChange: (open: boolean) => void;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isAuthClient(value: unknown): value is PluginAuthClient {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isString(record['serviceId']) &&
    isString(record['name']) &&
    isString(record['authorizationUrl']) &&
    isString(record['tokenUrl']) &&
    isString(record['clientId']) &&
    Array.isArray(record['scopes']) &&
    record['scopes'].every(isString)
  );
}

/** Reads the plugin's manifest `authClients` (a versioned public contract). */
export function extractAuthClients(
  manifest: Readonly<Record<string, unknown>>,
): PluginAuthClient[] {
  const raw = manifest['authClients'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isAuthClient);
}

export function PluginAuthDialog({ pluginId, authClients, onOpenChange }: PluginAuthDialogProps) {
  const { t } = useTranslation();
  const connections = usePluginAuthConnections(pluginId);
  const connect = usePluginAuthConnect();
  const revoke = usePluginAuthRevoke();
  const [connectError, setConnectError] = useState<string | null>(null);

  const modalLayer = useMemo(() => {
    // The app shell always renders a layer slot; when a system surface
    // (e.g. the plugins manager) is open its own slot portals later in the
    // DOM, so nested dialogs must target the LAST slot to stay above the
    // surface's overlay.
    const slots = document.querySelectorAll<HTMLElement>('[data-slot="modal.layer"]');
    return slots[slots.length - 1] ?? null;
  }, [pluginId === null]);

  useEffect(() => {
    setConnectError(null);
  }, [pluginId]);

  const handleConnect = useCallback(
    (serviceId: string) => {
      setConnectError(null);
      const client = authClients.find((c) => c.serviceId === serviceId);
      if (!client) return;
      connect.mutate(
        { pluginId: pluginId!, input: { serviceId } },
        {
          onSuccess: (result) => {
            if (result.authorizationUrl) {
              window.open(result.authorizationUrl, '_blank', 'noopener');
            }
          },
          onError: () => setConnectError(t('plugins:authError')),
        },
      );
    },
    [authClients, connect, pluginId, t],
  );

  const handleRevoke = useCallback(
    (connectionId: string) => {
      revoke.mutate({ pluginId: pluginId!, input: { connectionId } });
    },
    [pluginId, revoke],
  );

  return (
    <Dialog open={pluginId !== null} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('plugins:authDialogTitle')}
        description={t('plugins:authDialogHint')}
        container={modalLayer}
      >
        <div data-component="plugin-auth-manager" data-plugin={pluginId ?? ''}>
          {authClients.length === 0 ? (
            <p data-part="empty" data-role="no-oauth-clients">
              {t('plugins:noPermissions')}
            </p>
          ) : (
            <ul data-part="client-list" data-role="oauth-client-list">
              {authClients.map((client) => {
                const existing = connections.data?.items.find(
                  (c) => c.serviceId === client.serviceId,
                );
                const busy = connect.isPending || revoke.isPending;
                return (
                  <li key={client.serviceId} data-service={client.serviceId}>
                    <div data-part="client-info" data-role="oauth-client-info">
                      <strong>{client.name}</strong>
                      <code>{client.serviceId}</code>
                      {existing ? (
                        <span
                          data-part="status"
                          data-role="oauth-status"
                          data-status={existing.status}
                        >
                          {t(`plugins:authStatus_${existing.status}`)}
                        </span>
                      ) : null}
                      {existing?.scopes.length ? (
                        <span data-part="scopes" data-role="oauth-scopes">
                          {t('plugins:authScopes')}: {existing.scopes.join(', ')}
                        </span>
                      ) : null}
                    </div>
                    <div data-part="client-actions" data-role="oauth-client-actions">
                      {existing && existing.status === 'pending' ? (
                        <span data-part="pending-hint" data-role="oauth-pending-hint">
                          {t('plugins:authOpenPending')}
                        </span>
                      ) : null}
                      {existing && existing.status === 'connected' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          data-part="revoke"
                          disabled={busy}
                          onClick={() => handleRevoke(existing.connectionId)}
                        >
                          {t('plugins:authRevoke')}
                        </Button>
                      ) : (
                        <Button
                          variant="primary"
                          size="sm"
                          data-part="connect"
                          disabled={busy}
                          onClick={() => handleConnect(client.serviceId)}
                        >
                          {t('plugins:authConnect')}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {connectError ? (
            <p data-part="error" data-role="oauth-error">
              {connectError}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
