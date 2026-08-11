import { ArrowRight, ChatsCircle, Plus } from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, ErrorBoundary, Skeleton } from '@neotavern/ui';
import { useChats } from '../api/hooks.js';
import { useErrorText } from '../lib/useErrorText.js';
import { SystemSurfaceLink } from '../components/SystemSurfaceLink.js';
import workspaceStyles from '../components/ChatWorkspace.module.css';
import styles from './ChatsPage.module.css';

export function ChatsPage() {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const chats = useChats();
  const items = chats.data?.pages.flatMap((page) => page.items) ?? [];
  const dateFormatter = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
  });

  return (
    <ErrorBoundary name="chats">
      <div className={styles.page} data-component="chat-browser">
        <header className={styles.header}>
          <div>
            <span>{t('chat:libraryEyebrow')}</span>
            <h1>{t('navigation:chats')}</h1>
            <p>{t('chat:librarySubtitle')}</p>
          </div>
          <Button asChild variant="primary">
            <SystemSurfaceLink to="/characters">
              <Plus aria-hidden="true" />
              {t('chat:newChat')}
            </SystemSurfaceLink>
          </Button>
        </header>

        {chats.isLoading ? (
          <div className={styles.skeletons} aria-label={t('common:loading')}>
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton className={styles.skeleton} key={index} />
            ))}
          </div>
        ) : chats.isError ? (
          <EmptyChats
            title={t('chat:errorTitle')}
            description={errorText(chats.error)}
            action={<Button onClick={() => void chats.refetch()}>{t('common:retry')}</Button>}
          />
        ) : items.length === 0 ? (
          <EmptyChats
            title={t('chat:noChatsTitle')}
            description={t('chat:noChatsDescription')}
            action={
              <Button asChild variant="primary">
                <SystemSurfaceLink to="/characters">{t('chat:chooseCharacter')}</SystemSurfaceLink>
              </Button>
            }
          />
        ) : (
          <div className={styles.content}>
            <div className={styles.list}>
              {items.map((chat) => (
                <Link
                  key={chat.id}
                  to={`/chats/${chat.id}`}
                  className={styles.item}
                  data-component="chat-item"
                >
                  <span className={styles.icon} aria-hidden="true">
                    <ChatsCircle size={24} weight="duotone" />
                  </span>
                  <span className={styles.copy}>
                    <strong>{chat.title}</strong>
                    <span>
                      {t('chat:messages', { count: chat.messageCount })}
                      <span aria-hidden="true"> · </span>
                      {dateFormatter.format(chat.updatedAt)}
                    </span>
                  </span>
                  <ArrowRight className={styles.arrow} aria-hidden="true" />
                </Link>
              ))}
            </div>
            {chats.hasNextPage ? (
              <Button
                className={styles.loadMore}
                onClick={() => void chats.fetchNextPage()}
                disabled={chats.isFetchingNextPage}
              >
                {t('common:loadMore')}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </ErrorBoundary>
  );
}

function EmptyChats({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className={`${workspaceStyles.chatState} ${styles.empty}`} data-component="chat-state">
      <span className={workspaceStyles.chatStateIcon} aria-hidden="true">
        <ChatsCircle size={32} weight="duotone" />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
