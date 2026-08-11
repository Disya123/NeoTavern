/**
 * Popup result screen for the plugin OAuth callback (rev4 §K5).
 *
 * After the user approves on the IdP page, the server redirects the popup to
 * `#/plugin-auth-result?pluginId=…&serviceId=…&status=connected|error&reason=…`.
 * This screen renders the outcome and, on success, closes the popup itself
 * after a short delay so the user can see the confirmation. The Connections
 * dialog already polls the same status, so the popup is a thin cosmetic layer
 * and never receives any token material.
 */
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@neotavern/ui';

const AUTO_CLOSE_DELAY_MS = 1600;

export interface PluginAuthResultQuery {
  pluginId: string | null;
  serviceId: string | null;
  status: 'connected' | 'error' | 'unknown';
  reason: string | null;
}

/** Parse the `#/plugin-auth-result` hash produced by the OAuth callback. */
export function parseAuthResultHash(hash: string): PluginAuthResultQuery {
  const match = /^#\/plugin-auth-result\?(.*)$/u.exec(hash);
  if (!match) {
    return { pluginId: null, serviceId: null, status: 'unknown', reason: null };
  }
  const params = new URLSearchParams(match[1]);
  const status = params.get('status');
  return {
    pluginId: params.get('pluginId'),
    serviceId: params.get('serviceId'),
    status: status === 'connected' || status === 'error' ? status : 'unknown',
    reason: params.get('reason'),
  };
}

export interface PluginAuthResultProps {
  /** Defaults to the current location hash (injected for tests). */
  hash?: string;
}

export function PluginAuthResult({ hash }: PluginAuthResultProps) {
  const { t } = useTranslation();
  const query = useMemo(
    () => parseAuthResultHash(hash ?? window.location.hash),
    // The popup hash never changes after mount; the injected prop is stable.
    [hash],
  );
  const serviceLabel = query.serviceId ?? t('plugins:authResultUnknown');

  useEffect(() => {
    if (query.status !== 'connected') return;
    const timer = window.setTimeout(() => {
      window.close();
    }, AUTO_CLOSE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query.status]);

  return (
    <main
      data-component="plugin-auth-result"
      data-part={query.status}
      data-plugin={query.pluginId ?? ''}
    >
      <header>
        <h1>{t('plugins:authResultTitle')}</h1>
      </header>
      {query.status === 'connected' ? (
        <>
          <p data-part="message" data-role="auth-result-message">
            {t('plugins:authResultConnected', { service: serviceLabel })}
          </p>
          <p data-part="hint">{t('plugins:authResultConnectedHint')}</p>
        </>
      ) : null}
      {query.status === 'error' ? (
        <>
          <p data-part="message" data-role="auth-result-message">
            {t('plugins:authResultError', { service: serviceLabel })}
          </p>
          {query.reason ? (
            <p data-part="reason" data-role="auth-result-reason">
              {query.reason}
            </p>
          ) : null}
          <p data-part="hint">{t('plugins:authResultErrorHint')}</p>
          <div data-part="actions">
            <Button variant="primary" data-part="close" onClick={() => window.close()}>
              {t('plugins:authResultClose')}
            </Button>
          </div>
        </>
      ) : null}
      {query.status === 'unknown' ? (
        <p data-part="message" data-role="auth-result-message">
          {t('plugins:authResultUnknown')}
        </p>
      ) : null}
    </main>
  );
}
