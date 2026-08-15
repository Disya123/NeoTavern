import {
  ArrowCounterClockwise,
  CaretDown,
  CaretUp,
  ClockCounterClockwise,
  X,
} from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Message, MessageContentRevision } from '@neotavern/contracts';
import { ErrorCodes } from '@neotavern/shared';
import { Dialog, DialogContent } from '@neotavern/ui';
import { ApiError } from '../api/client.js';
import { useMessageRevisions, useRestoreMessageRevision } from '../api/hooks.js';
import { useErrorText } from '../lib/useErrorText.js';
import styles from './MessageRevisionHistoryCard.module.css';

export interface MessageRevisionHistoryCardProps {
  open: boolean;
  message: Message;
  onClose: () => void;
}

/** Manual content-edit history. Swipe variants intentionally live elsewhere. */
export function MessageRevisionHistoryCard({
  open,
  message,
  onClose,
}: MessageRevisionHistoryCardProps) {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const revisionsQuery = useMessageRevisions(message.chatId, message.id, open);
  const restore = useRestoreMessageRevision();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<{ id: string; text: string } | null>(null);

  const revisions = useMemo(
    () => revisionsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [revisionsQuery.data],
  );

  const formatDate = (timestamp: number): string =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(timestamp));

  const restoreRevision = async (revision: MessageContentRevision): Promise<void> => {
    setRestoreError(null);
    try {
      await restore.mutateAsync({
        chatId: message.chatId,
        messageId: message.id,
        revisionId: revision.id,
        content: revision.content,
        expectedRevision: message.revision,
      });
    } catch (error) {
      setRestoreError({
        id: revision.id,
        text:
          error instanceof ApiError && error.code === ErrorCodes.MESSAGE_CONFLICT
            ? t('chat:revisionConflict')
            : errorText(error),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className={styles.dialog} title={t('chat:revisionHistory')}>
        <div
          className={styles.card}
          data-component="message-revision-history-card"
          data-state={revisionsQuery.isPending ? 'loading' : 'ready'}
        >
          <div
            className={styles.dragHandle}
            data-part="revision-history-drag-handle"
            aria-hidden="true"
          />
          <header className={styles.header} data-part="revision-history-header">
            <span className={styles.title}>
              <ClockCounterClockwise aria-hidden="true" />
              {t('chat:revisionHistory')}
            </span>
            <button
              type="button"
              className={styles.iconButton}
              onClick={onClose}
              aria-label={t('common:close')}
            >
              <X aria-hidden="true" />
            </button>
          </header>

          <div className={styles.scrollArea} data-part="revision-history-list">
            <RevisionContent
              id="current"
              label={t('chat:currentVersion')}
              content={message.content}
              timestamp={message.updatedAt ?? message.createdAt}
              expanded={expandedId === 'current'}
              onToggle={() => setExpandedId((value) => (value === 'current' ? null : 'current'))}
              formatDate={formatDate}
              current
            />

            <div className={styles.sectionLabel} data-part="revision-history-section-label">
              {t('chat:previousVersions')}
            </div>

            {revisionsQuery.isPending ? (
              <p className={styles.status} role="status">
                {t('common:loading')}
              </p>
            ) : revisions.length === 0 ? (
              <p className={styles.status} data-part="revision-history-empty">
                {t('chat:noPreviousVersions')}
              </p>
            ) : (
              revisions.map((revision) => (
                <RevisionContent
                  key={revision.id}
                  id={revision.id}
                  label={t('chat:revisionVersion', { number: revision.position + 1 })}
                  content={revision.content}
                  timestamp={revision.createdAt}
                  expanded={expandedId === revision.id}
                  onToggle={() =>
                    setExpandedId((value) => (value === revision.id ? null : revision.id))
                  }
                  formatDate={formatDate}
                  restoreLabel={t('chat:restoreVersion')}
                  restoring={restore.isPending && restore.variables?.revisionId === revision.id}
                  onRestore={() => void restoreRevision(revision)}
                  error={restoreError?.id === revision.id ? restoreError.text : null}
                />
              ))
            )}

            {revisionsQuery.hasNextPage ? (
              <button
                type="button"
                className={styles.loadMore}
                onClick={() => void revisionsQuery.fetchNextPage()}
                disabled={revisionsQuery.isFetchingNextPage}
              >
                {revisionsQuery.isFetchingNextPage
                  ? t('common:loading')
                  : t('chat:loadMoreVersions')}
              </button>
            ) : null}

            {revisionsQuery.isError ? (
              <p className={styles.error} role="alert">
                {errorText(revisionsQuery.error)}
              </p>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface RevisionContentProps {
  id: string;
  label: string;
  content: string;
  timestamp: number;
  expanded: boolean;
  onToggle: () => void;
  formatDate: (timestamp: number) => string;
  current?: boolean;
  restoreLabel?: string;
  restoring?: boolean;
  onRestore?: () => void;
  error?: string | null;
}

function RevisionContent({
  id,
  label,
  content,
  timestamp,
  expanded,
  onToggle,
  formatDate,
  current = false,
  restoreLabel,
  restoring = false,
  onRestore,
  error = null,
}: RevisionContentProps) {
  const { t } = useTranslation();
  return (
    <article
      className={styles.revision}
      data-part="revision-history-item"
      data-state={current ? 'current' : 'archived'}
      data-revision-id={id}
    >
      <header className={styles.revisionHeader}>
        <strong>{label}</strong>
        <time dateTime={new Date(timestamp).toISOString()}>{formatDate(timestamp)}</time>
      </header>
      <div
        className={expanded ? styles.revisionContentExpanded : styles.revisionContent}
        data-part="revision-history-content"
      >
        {content}
      </div>
      <div className={styles.revisionActions}>
        <button type="button" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? <CaretUp aria-hidden="true" /> : <CaretDown aria-hidden="true" />}
          <span>{expanded ? t('chat:collapseVersion') : t('chat:viewFullVersion')}</span>
        </button>
        {onRestore && restoreLabel ? (
          <button type="button" onClick={onRestore} disabled={restoring}>
            <ArrowCounterClockwise aria-hidden="true" />
            <span>{restoreLabel}</span>
          </button>
        ) : null}
      </div>
      {error ? (
        <p className={styles.error} data-part="revision-history-error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}
