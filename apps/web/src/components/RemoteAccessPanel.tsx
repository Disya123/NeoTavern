/**
 * Remote access settings (Phase 9 desktop slice).
 *
 * Desktop-shell-only: the panel renders nothing in a plain browser (no
 * `kernel_remote_*` IPC there). Status is server state (ARCH-06) — polled
 * via TanStack Query while the server is running — and every mutation goes
 * through the typed `remoteAccess` API, surfacing `REMOTE_*` codes as
 * localized error text.
 *
 * Security posture (ТЗ §10): pairing is opt-in per device, issued tokens are
 * shown exactly once (component state only, never persisted or logged), and
 * the server is off by default with a loopback bind and auth enabled.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ActionBar, ActionBarGroup, Button } from '@neotavern/ui';
import {
  parseRemoteError,
  RemoteAccessError,
  remotePair,
  remoteRevoke,
  remoteStart,
  remoteStop,
  remoteStatus,
  type RemoteStartPayload,
} from '../api/remoteAccess.js';
import { isTauriRuntime } from '../api/tauriTransport.js';
import styles from './RemoteAccessPanel.module.css';

/** Stable mapping of `REMOTE_*` command error codes to i18n keys. */
const ERROR_KEYS: Record<string, string> = {
  REMOTE_INSECURE_BIND: 'remoteErrInsecureBind',
  REMOTE_PUBLIC_BIND_REQUIRES_AUTH: 'remoteErrPublicBindRequiresAuth',
  REMOTE_AUTH_DISABLED: 'remoteErrAuthDisabled',
  REMOTE_NOT_RUNNING: 'remoteErrNotRunning',
  REMOTE_MUST_STOP_FIRST: 'remoteErrMustStopFirst',
  REMOTE_START_FAILED: 'remoteErrStartFailed',
  REMOTE_IO: 'remoteErrIo',
  REMOTE_INTERNAL: 'remoteErrInternal',
};

type Action = 'start' | 'stop' | 'pair' | 'revoke' | null;

/**
 * Localize a remote-access failure: `RemoteAccessError` and `CODE: message`
 * strings map to their i18n key, everything else falls back to the generic
 * start-error text.
 */
function remoteErrorMessage(
  t: (key: string) => string,
  error: unknown,
): string {
  if (error instanceof RemoteAccessError) {
    const key = ERROR_KEYS[error.code];
    if (key) return t(key);
    return error.message || t('remoteErrInternal');
  }
  const text =
    error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  if (text !== null) {
    const parsed = parseRemoteError(text);
    if (parsed) {
      const key = ERROR_KEYS[parsed.code];
      if (key) return t(key);
      return parsed.message;
    }
  }
  return t('remoteStartError');
}

export function RemoteAccessPanel() {
  const { t } = useTranslation('settings');
  const tauri = isTauriRuntime();
  const statusQuery = useQuery({
    queryKey: ['remote-access-status'],
    queryFn: remoteStatus,
    enabled: tauri,
    refetchInterval: (query) => (query.state.data?.running ? 5000 : false),
    retry: false,
  });
  const status = statusQuery.data ?? null;
  const running = status?.running ?? false;

  const [bind, setBind] = useState<'127.0.0.1' | '::1'>('127.0.0.1');
  const [port, setPort] = useState('0');
  const [authEnabled, setAuthEnabled] = useState(true);
  const [origins, setOrigins] = useState('');
  const [pairLabel, setPairLabel] = useState('');
  const [busy, setBusy] = useState<Action>(null);
  const [issued, setIssued] = useState<{ id: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // "Copied" feedback resets after a moment; the timer is torn down on
  // unmount or a later copy.
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!tauri) return null;

  const lastError =
    actionError ?? (status?.lastError ? remoteErrorMessage(t, status.lastError) : null);

  const start = async (): Promise<void> => {
    setBusy('start');
    setActionError(null);
    setIssued(null);
    try {
      const payload: RemoteStartPayload = {
        bind,
        port: Number(port) || 0,
        authEnabled,
        allowedOrigins: origins
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      };
      await remoteStart(payload);
      await statusQuery.refetch();
    } catch (error) {
      setActionError(remoteErrorMessage(t, error));
    } finally {
      setBusy(null);
    }
  };

  const stop = async (): Promise<void> => {
    setBusy('stop');
    setActionError(null);
    setIssued(null);
    try {
      await remoteStop();
      await statusQuery.refetch();
    } catch (error) {
      setActionError(remoteErrorMessage(t, error));
    } finally {
      setBusy(null);
    }
  };

  const pair = async (): Promise<void> => {
    setBusy('pair');
    setActionError(null);
    setIssued(null);
    try {
      const label = pairLabel.trim();
      setIssued(await remotePair(label || undefined));
    } catch (error) {
      setActionError(remoteErrorMessage(t, error));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (id: string): Promise<void> => {
    setBusy('revoke');
    setActionError(null);
    try {
      await remoteRevoke(id);
      await statusQuery.refetch();
    } catch (error) {
      setActionError(remoteErrorMessage(t, error));
    } finally {
      setBusy(null);
    }
  };

  const copyToken = async (): Promise<void> => {
    const token = issued?.token;
    if (!token) return;
    await navigator.clipboard?.writeText(token);
    setCopied(true);
  };

  return (
    <div className={styles.panel} data-component="remote-access-panel">
      {lastError ? (
        <p className={styles.error} role="alert" aria-label={t('remoteLastError')} data-part="remote-error">
          {lastError}
        </p>
      ) : null}

      <section className={styles.section} aria-label={t('remoteAccess')} data-part="remote-status">
        <header className={styles.sectionHeader}>
          <h2>{t('remoteAccess')}</h2>
          <span className={running ? styles.badgeRunning : styles.badgeStopped} role="status">
            {t(running ? 'remoteRunning' : 'remoteStopped')}
          </span>
        </header>
        <dl className={styles.metrics}>
          {running && status?.bind ? (
            <div className={styles.metric}>
              <dt>{t('remoteBind')}</dt>
              <dd>{status.bind}</dd>
            </div>
          ) : null}
          {running && status?.port !== null ? (
            <div className={styles.metric}>
              <dt>{t('remotePort')}</dt>
              <dd>{status?.port ?? 0}</dd>
            </div>
          ) : null}
          <div className={styles.metric}>
            <dt>{t('remoteStreams')}</dt>
            <dd>{status?.streams ?? 0}</dd>
          </div>
          <div className={styles.metric}>
            <dt>{t('remoteAuditEvents')}</dt>
            <dd>{status?.auditEvents ?? 0}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.section} data-part="remote-config">
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="remote-bind">
            {t('remoteBind')}
          </label>
          <select
            id="remote-bind"
            data-component="input"
            value={bind}
            disabled={busy !== null}
            onChange={(event) => setBind(event.target.value as '127.0.0.1' | '::1')}
          >
            <option value="127.0.0.1">127.0.0.1</option>
            <option value="::1">::1</option>
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="remote-port">
            {t('remotePort')}
          </label>
          <input
            id="remote-port"
            data-component="input"
            type="number"
            min={0}
            max={65535}
            value={port}
            disabled={busy !== null}
            onChange={(event) => setPort(event.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.checkboxLabel} htmlFor="remote-auth">
            <input
              id="remote-auth"
              type="checkbox"
              checked={authEnabled}
              disabled={busy !== null}
              onChange={(event) => setAuthEnabled(event.target.checked)}
            />
            {t('remoteAuth')}
          </label>
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="remote-origins">
            {t('remoteOrigins')}
          </label>
          <textarea
            id="remote-origins"
            data-component="input"
            rows={3}
            value={origins}
            disabled={busy !== null}
            onChange={(event) => setOrigins(event.target.value)}
          />
        </div>
        <ActionBar collapse="stack" className={styles.actions} data-part="remote-actions">
          <ActionBarGroup placement="primary">
            <Button
              variant="primary"
              disabled={busy !== null || running}
              onClick={() => void start()}
            >
              {t('remoteStart')}
            </Button>
            <Button variant="ghost" disabled={busy !== null || !running} onClick={() => void stop()}>
              {t('remoteStop')}
            </Button>
          </ActionBarGroup>
        </ActionBar>
      </section>

      <section className={styles.section} data-part="remote-credentials">
        <header className={styles.sectionHeader}>
          <h2>{t('remoteCredentials')}</h2>
        </header>
        {status?.credentials.length ? (
          <ul className={styles.credentials}>
            {status.credentials.map((credential) => (
              <li key={credential.id} className={styles.credential}>
                <span className={styles.credentialCopy}>
                  <strong>{credential.label ?? credential.id}</strong>
                  <small>{credential.id}</small>
                </span>
                {credential.revoked ? (
                  <span className={styles.revokedBadge}>{t('remoteRevoked')}</span>
                ) : (
                  <Button size="sm" disabled={busy !== null} onClick={() => void revoke(credential.id)}>
                    {t('remoteRevoke')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.empty}>{t('remoteEmptyCredentials')}</p>
        )}
        <div className={styles.pairRow}>
          <input
            data-component="input"
            aria-label={t('remotePairLabel')}
            value={pairLabel}
            disabled={busy !== null}
            onChange={(event) => setPairLabel(event.target.value)}
          />
          <Button disabled={busy !== null} onClick={() => void pair()}>
            {t('remotePair')}
          </Button>
        </div>
      </section>

      {issued ? (
        <div className={styles.tokenBox} data-part="issued-token" role="status">
          <div className={styles.tokenHeader}>
            <h3>{t('remoteToken')}</h3>
            <button
              type="button"
              className={styles.dismiss}
              aria-label={t('common:close')}
              onClick={() => setIssued(null)}
            >
              ×
            </button>
          </div>
          <code className={styles.tokenValue}>{issued.token}</code>
          <p className={styles.tokenHint}>{t('remoteTokenHint')}</p>
          <ActionBar collapse="stack" className={styles.tokenActions}>
            <ActionBarGroup placement="primary">
              <Button variant="primary" onClick={() => void copyToken()}>
                {copied ? t('remoteCopied') : t('remoteCopy')}
              </Button>
            </ActionBarGroup>
          </ActionBar>
        </div>
      ) : null}
    </div>
  );
}
