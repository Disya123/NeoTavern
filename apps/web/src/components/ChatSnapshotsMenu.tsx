/**
 * Snapshot (checkpoint/branch) listing for the current chat (М5 slice 46).
 *
 * The trigger is a header action; opening it fetches the child chats of the
 * active chat over Product Wire `chats.snapshots.list` (kernel plane only).
 * On the legacy plane the capability does not exist — the trigger is hidden
 * entirely (ARC-02: honest `CAPABILITY_UNAVAILABLE` instead of a silent
 * downgrade). Each row opens the child chat via its own route.
 */
import { useEffect, useRef, useState } from 'react';
import { GitBranch } from '@phosphor-icons/react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { isKernelMode } from '../api/backend.js';
import { listChatSnapshots } from '../api/wireBridge.js';
import styles from './ChatSnapshotsMenu.module.css';

export type ChatSnapshotsMenuProps = {
  /** Active chat whose snapshots (child chats) are listed. */
  chatId: string;
};

export function ChatSnapshotsMenu({ chatId }: ChatSnapshotsMenuProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);

  const query = useQuery({
    queryKey: ['chat-snapshots', chatId],
    queryFn: () => listChatSnapshots(chatId),
    enabled: open,
    staleTime: 30_000,
  });

  // Close on outside click / Escape while the panel is open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (hostRef.current && !hostRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Kernel-only capability (slice 46): the legacy plane has no snapshot-list
  // contract, so the honest state is "not available" — hide the trigger.
  if (!isKernelMode()) return null;

  const snapshots = query.data?.items ?? [];

  return (
    <div className={styles.host} ref={hostRef} data-component="chat-snapshots-menu">
      <button
        type="button"
        className={styles.trigger}
        data-part="trigger"
        onClick={() => setOpen((value) => !value)}
        aria-label={t('chat:snapshotsList')}
        title={t('chat:snapshotsList')}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <GitBranch size={18} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className={styles.panel}
          data-part="panel"
          role="menu"
          aria-label={t('chat:snapshotsListTitle')}
        >
          <div className={styles.panelTitle} data-part="title">
            {t('chat:snapshotsListTitle')}
          </div>
          {query.isPending ? (
            <div className={styles.state} data-part="state">
              {t('common:loading')}
            </div>
          ) : query.isError ? (
            <div className={styles.state} data-part="state">
              {t('chat:snapshotsUnavailable')}
            </div>
          ) : snapshots.length === 0 ? (
            <div className={styles.state} data-part="state">
              {t('chat:snapshotsEmpty')}
            </div>
          ) : (
            <ul className={styles.list} data-part="list">
              {snapshots.map((snapshot) => (
                <li key={snapshot.id}>
                  <button
                    type="button"
                    className={styles.item}
                    role="menuitem"
                    data-part="item"
                    onClick={() => {
                      setOpen(false);
                      navigate(`/chats/${snapshot.id}`);
                    }}
                  >
                    <span className={styles.itemTitle} data-part="item-title">
                      {snapshot.title}
                    </span>
                    <span className={styles.itemMeta} data-part="item-meta">
                      <span data-part="origin">
                        {snapshot.origin === 'branch'
                          ? t('chat:branchBadge')
                          : t('chat:checkpointBadge')}
                      </span>
                      <span data-part="count">
                        {t('chat:snapshotMessageCount', {
                          count: snapshot.messageCount,
                        })}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
