import { useTranslation } from 'react-i18next';
import { ErrorBoundary } from '@neotavern/ui';
import { ProviderProfileEditor } from '../components/ai-settings/ProviderProfileEditor.js';
import styles from './ProvidersPage.module.css';

export function ProvidersPage() {
  const { t } = useTranslation();

  return (
    <ErrorBoundary name="providers">
      <div className={styles.page} data-component="providers">
        <header className={styles.header}>
          <span>{t('providers:eyebrow')}</span>
          <h1>{t('providers:title')}</h1>
          <p>{t('providers:subtitle')}</p>
        </header>
        <div className={styles.body}>
          <section className={styles.providerSection} aria-label={t('providers:configured')}>
            <ProviderProfileEditor surface="page" />
          </section>
        </div>
      </div>
    </ErrorBoundary>
  );
}
