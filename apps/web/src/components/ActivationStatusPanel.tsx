/**
 * Data-root activation status panel (ТЗ §10.2–§10.3, М5 slice 38), rendered
 * in the Settings Data tab: which layout version the data root uses, which
 * root is active, the durable activation journal and whether an activation
 * is pending (Windows restart-to-complete). Strictly read-only — the panel
 * renders the honest kernel state; on the legacy plane (no activation
 * journal) it shows an honest empty state.
 */
import { Warning } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useDataActivationStatus } from '../api/hooks.js';
import { useErrorText } from '../lib/useErrorText.js';
import styles from './SettingsPanel.module.css';

export function ActivationStatusPanel() {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const status = useDataActivationStatus();
  const dateFormatter = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  if (status.isError) {
    return (
      <section className={styles.section} data-part="data-activation">
        <header className={styles.sectionHeader}>
          <h2>{t('settings:dataActivation')}</h2>
        </header>
        <p className={styles.error} role="alert">
          {errorText(status.error)}
        </p>
      </section>
    );
  }
  if (!status.data) {
    return (
      <section className={styles.section} data-part="data-activation">
        <header className={styles.sectionHeader}>
          <h2>{t('settings:dataActivation')}</h2>
          <p>{t('settings:dataActivationUnavailable')}</p>
        </header>
      </section>
    );
  }

  const { data } = status;
  return (
    <section className={styles.section} data-part="data-activation" data-layout={data.layoutVersion}>
      <header className={styles.sectionHeader}>
        <h2>{t('settings:dataActivation')}</h2>
        <p>{t('settings:dataActivationHint')}</p>
      </header>
      <dl className={styles.activationMeta}>
        <div className={styles.activationMetaRow}>
          <dt>{t('settings:dataActivationLayout')}</dt>
          <dd>
            {data.layoutVersion === 2
              ? t('settings:dataActivationLayoutV2')
              : t('settings:dataActivationLayoutV1')}
          </dd>
        </div>
        <div className={styles.activationMetaRow}>
          <dt>{t('settings:dataActivationActiveRoot')}</dt>
          <dd className={styles.activationPath}>{data.activeRoot}</dd>
        </div>
        {data.activeRootId ? (
          <div className={styles.activationMetaRow}>
            <dt>{t('settings:dataActivationActiveRootId')}</dt>
            <dd>{data.activeRootId}</dd>
          </div>
        ) : null}
      </dl>
      {data.pending ? (
        <p className={styles.activationPending} role="alert" data-part="data-activation-pending">
          <Warning aria-hidden="true" />
          {t('settings:dataActivationPending')}
        </p>
      ) : null}
      <h3 className={styles.activationJournalTitle}>
        {t('settings:dataActivationJournal')}
      </h3>
      {data.entries.length === 0 ? (
        <p className={styles.noBackups}>{t('settings:dataActivationNoJournal')}</p>
      ) : (
        <ul className={styles.activationJournal} data-part="data-activation-journal">
          {data.entries.map((entry) => (
            <li key={entry.id} className={styles.activationEntry} data-status={entry.status}>
              <span className={styles.activationEntryKind}>{entry.kind}</span>
              <span className={styles.activationEntryStatus}>{entry.status}</span>
              <span className={styles.activationEntryTimes}>
                {dateFormatter.format(Date.parse(entry.createdAt))}
              </span>
              {entry.error ? (
                <span className={styles.activationEntryError}>{entry.error}</span>
              ) : null}
              <code className={styles.activationEntryRoots}>
                {entry.fromRoot} → {entry.toRoot}
              </code>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
