import { Key, ShieldCheck } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthSession } from '@neotavern/contracts';
import { Button, Skeleton } from '@neotavern/ui';
import { useAuthSession, useLogin } from '../api/hooks.js';
import { ApiNetworkError, setCsrfToken } from '../api/client.js';
import { useErrorText } from '../lib/useErrorText.js';
import styles from './AuthGate.module.css';

export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const session = useAuthSession();
  const login = useLogin();
  const errorText = useErrorText();
  const [token, setToken] = useState('');

  useEffect(() => {
    const requireAuthentication = (): void => {
      setCsrfToken(null);
      queryClient.setQueryData<AuthSession>(['auth-session'], {
        required: true,
        authenticated: false,
      });
    };
    window.addEventListener('neotavern-auth-required', requireAuthentication);
    return () => window.removeEventListener('neotavern-auth-required', requireAuthentication);
  }, [queryClient]);

  if (session.isPending) {
    return (
      <main className={styles.page} data-component="auth-gate">
        <div className={styles.loading} role="status" aria-label={t('auth:checking')}>
          <Skeleton className={styles.loadingItem} />
          <Skeleton className={styles.loadingItem} />
          <Skeleton className={styles.loadingItem} />
        </div>
      </main>
    );
  }

  if (session.error instanceof ApiNetworkError) {
    return (
      <>
        <div className={styles.offline} role="status">
          {navigator.onLine ? t('auth:unavailableShell') : t('auth:offlineShell')}
        </div>
        {children}
      </>
    );
  }

  if (session.error) {
    return (
      <main className={styles.page} data-component="auth-gate">
        <section className={styles.panel}>
          <span className={styles.icon}>
            <ShieldCheck aria-hidden="true" />
          </span>
          <div>
            <p className={styles.eyebrow}>{t('auth:connectionRequired')}</p>
            <h1>{t('auth:unavailable')}</h1>
            <p>{errorText(session.error)}</p>
          </div>
          <Button variant="primary" onClick={() => void session.refetch()}>
            {t('common:retry')}
          </Button>
        </section>
      </main>
    );
  }

  if (!session.data?.required || session.data.authenticated) return children;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!token || login.isPending) return;
    login.mutate(
      { token },
      {
        onSuccess: () => setToken(''),
      },
    );
  };

  return (
    <main className={styles.page} data-component="auth-gate">
      <section className={styles.panel}>
        <span className={styles.icon}>
          <Key weight="duotone" aria-hidden="true" />
        </span>
        <div>
          <p className={styles.eyebrow}>{t('auth:remoteMode')}</p>
          <h1>{t('auth:title')}</h1>
          <p>{t('auth:hint')}</p>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="remote-access-token">{t('auth:token')}</label>
          <input
            id="remote-access-token"
            type="password"
            value={token}
            autoComplete="current-password"
            required
            maxLength={1024}
            disabled={login.isPending}
            onChange={(event) => {
              setToken(event.target.value);
              if (login.error) login.reset();
            }}
          />
          <small>{t('auth:tokenHint')}</small>
          {login.error ? (
            <p className={styles.error} role="alert">
              {errorText(login.error)}
            </p>
          ) : null}
          <Button variant="primary" type="submit" disabled={!token || login.isPending}>
            {login.isPending ? t('auth:signingIn') : t('auth:signIn')}
          </Button>
        </form>
      </section>
    </main>
  );
}
