/**
 * Secret-store status panel (SEC-01.1, Этап 4 slice 7 remainder, M5).
 * Rendered as the Security tab inside the Settings panel.
 *
 * The canonical plane has NO reveal operation: `secrets.status` reports the
 * explicit store mode — kind `portable` (encrypted secrets.enc with a
 * format version), `env` (headless environment provider), `session`
 * (session-only memory store) or `unavailable` (fail-closed) — plus
 * persistent/writable/available flags and the record count. The panel
 * renders that honest mode state and the SEC-01.1 UX framing: portable
 * passphrase lives in the OS vault / Keystore / portable flow (ТЗ §SEC-01.1
 * options 1-3); a value can never cross this DTO, so there is nothing to
 * display, copy or reveal.
 */
import { Key, Lock, LockKey } from '@phosphor-icons/react';
import { Button } from '@neotavern/ui';
import { useTranslation } from 'react-i18next';
import type { SecretsStatusResultDto } from '@neotavern/contracts';
import { useLockSecrets, useSecretsStatus } from '../api/secretsHooks.js';
import { useErrorText } from '../lib/useErrorText.js';
import styles from './SettingsPanel.module.css';

export function SecretsPanel() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const status = useSecretsStatus();
  const lockSecrets = useLockSecrets();

  if (status.isError) {
    return (
      <div className={styles.body} data-part="secrets-settings">
        <p className={styles.error} role="alert">
          {errorText(status.error)}
        </p>
      </div>
    );
  }
  if (!status.data) {
    return (
      <div className={styles.body} data-part="secrets-settings">
        <p className={styles.noBackups}>{t('secrets:loading')}</p>
      </div>
    );
  }

  // Manual lock (SEC-01.1: "auto-lock, ручную блокировку и best-effort
  // zeroization"). Only a locked-able, available portable store can be
  // locked again; after a lock the store is unavailable until the host
  // re-opens it with the master passphrase, so the button disappears and the
  // mode copy flips to the honest locked state.
  const canLock =
    status.data.kind === 'portable' && status.data.available === true && !lockSecrets.isPending;

  return (
    <div className={styles.body} data-part="secrets-settings">
      <section className={styles.section}>
        <header className={styles.sectionHeader}>
          <h2>{t('secrets:title')}</h2>
          <p>{t('secrets:titleHint')}</p>
        </header>
        <div className={styles.secretsMode} data-state={status.data.kind}>
          <span className={styles.backupIcon} aria-hidden="true">
            <SecretIcon kind={status.data.kind} />
          </span>
          <div className={styles.backupCopy}>
            <strong>{modeLabel(t, status.data)}</strong>
            <small>{modeHint(t, status.data)}</small>
          </div>
        </div>
        <ul className={styles.secretsFlags}>
          <li data-state={status.data.persistent ? 'on' : 'off'}>
            <span>{t('secrets:persistent')}</span>
            <strong>{t(status.data.persistent ? 'secrets:yes' : 'secrets:no')}</strong>
          </li>
          <li data-state={status.data.writable ? 'on' : 'off'}>
            <span>{t('secrets:writable')}</span>
            <strong>{t(status.data.writable ? 'secrets:yes' : 'secrets:no')}</strong>
          </li>
          <li data-state={status.data.available ? 'on' : 'off'}>
            <span>{t('secrets:available')}</span>
            <strong>{t(status.data.available ? 'secrets:yes' : 'secrets:no')}</strong>
          </li>
          <li data-state={status.data.recordCount > 0 ? 'on' : 'off'}>
            <span>{t('secrets:recordCount')}</span>
            <strong>{t('secrets:recordCountValue', { count: status.data.recordCount })}</strong>
          </li>
          {status.data.formatVersion !== undefined ? (
            <li data-state="on">
              <span>{t('secrets:formatVersion')}</span>
              <strong>
                {t('secrets:formatVersionValue', { version: status.data.formatVersion })}
              </strong>
            </li>
          ) : null}
        </ul>
        {status.data.available === false && status.data.kind === 'portable' ? (
          <p className={styles.safeHint} role="status">
            {t('secrets:lockedHint')}
          </p>
        ) : null}
        {canLock ? (
          <Button
            size="sm"
            data-part="lock-secrets"
            onClick={() => lockSecrets.mutate()}
            disabled={lockSecrets.isPending}
          >
            {lockSecrets.isPending ? t('secrets:locking') : t('secrets:lock')}
          </Button>
        ) : null}
        {lockSecrets.isError ? (
          <p className={styles.error} role="alert">
            {errorText(lockSecrets.error)}
          </p>
        ) : null}
        <p className={styles.safeHint}>{t('secrets:noRevealHint')}</p>
      </section>
    </div>
  );
}

function SecretIcon({ kind }: { kind: string }) {
  if (kind === 'unavailable') return <Key size={18} aria-hidden="true" />;
  if (kind === 'portable') return <LockKey size={18} aria-hidden="true" />;
  return <Lock size={18} aria-hidden="true" />;
}

function modeLabel(t: (key: string) => string, status: SecretsStatusResultDto): string {
  switch (status.kind) {
    case 'portable':
      return t('secrets:modePortable');
    case 'env':
      return t('secrets:modeEnv');
    case 'session':
      return t('secrets:modeSession');
    case 'unavailable':
      return t('secrets:modeUnavailable');
    default:
      return status.kind;
  }
}

function modeHint(t: (key: string) => string, status: SecretsStatusResultDto): string {
  switch (status.kind) {
    case 'portable':
      return t('secrets:modePortableHint');
    case 'env':
      return t('secrets:modeEnvHint');
    case 'session':
      return t('secrets:modeSessionHint');
    case 'unavailable':
      return t('secrets:modeUnavailableHint');
    default:
      return status.kind;
  }
}
