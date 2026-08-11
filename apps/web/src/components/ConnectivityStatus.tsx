import { useEffect, useState } from 'react';
import { WifiSlash } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

/** Announces browser connectivity changes without replacing the chat workspace. */
export function ConnectivityStatus() {
  const { t } = useTranslation();
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const handleOnline = (): void => setOnline(true);
    const handleOffline = (): void => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (online) return null;
  return (
    <div data-component="connectivity-status" data-state="offline" role="status">
      <WifiSlash size={18} aria-hidden="true" />
      <span>{t('status:offline')}</span>
    </div>
  );
}
