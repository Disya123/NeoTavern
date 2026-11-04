/**
 * Conversation header shared by the Home preview and the live chat: the pinned
 * character identity plus an inline message search. Search state (open/query)
 * lives here so the two routes cannot drift; the active query is reported via
 * `onQueryChange` so the page can highlight matches in its message bubbles.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, MagnifyingGlass, X } from '@phosphor-icons/react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SlotHost } from '../plugins/slots.js';
import { ChatSnapshotsMenu } from './ChatSnapshotsMenu.js';
import styles from './ChatWorkspace.module.css';

export type ChatHeaderProps = {
  /** Character name, or `null` while it is still loading. */
  name: string | null;
  avatar: string | null | undefined;
  /**
   * Plain texts the search matches against. Home passes the greeting only; the
   * live chat passes every message body. The match count is derived from this.
   */
  searchableTexts: string[];
  /** Reports the active query (empty string when search is closed). */
  onQueryChange: (query: string) => void;
  /**
   * Parent chat id when this conversation is a checkpoint/branch child;
   * renders a back-to-parent button. Optional — the Home preview omits it.
   */
  backToParentChatId?: string | null;
  /**
   * Active chat id (live chat only). When present, renders the snapshot
   * (checkpoint/branch) listing trigger over Product Wire.
   */
  chatId?: string | null;
};

export function ChatHeader({
  name,
  avatar,
  searchableTexts,
  onQueryChange,
  backToParentChatId = null,
  chatId = null,
}: ChatHeaderProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const changeQuery = (value: string): void => {
    setQuery(value);
    onQueryChange(value);
  };

  const close = (): void => {
    setOpen(false);
    changeQuery('');
  };

  const matchCount = searchableTexts.reduce((sum, text) => sum + countTextMatches(text, query), 0);

  return (
    <div className={styles.chatHeader} data-slot="chat.header">
      {open ? (
        <div className={styles.chatSearch}>
          <MagnifyingGlass size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            maxLength={500}
            aria-label={t('chat:searchMessages')}
            placeholder={t('chat:searchMessagesPlaceholder')}
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') close();
            }}
          />
          {query.trim() ? (
            <span className={styles.searchMatchCount} role="status" aria-live="polite">
              {t('chat:searchMatchCount', { count: matchCount })}
            </span>
          ) : null}
          <button
            type="button"
            className={styles.headerSearch}
            onClick={close}
            aria-label={t('chat:closeSearch')}
            title={t('chat:closeSearch')}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <>
          <div className={styles.chatIdentity} data-part="character-identity">
            {avatar ? (
              <img
                className={styles.headerAvatar}
                data-part="character-avatar"
                src={avatar}
                alt={t('characters:avatarAlt', { name: name ?? '' })}
              />
            ) : (
              <span
                className={styles.headerAvatarFallback}
                data-part="character-avatar"
                aria-hidden="true"
              >
                {name?.slice(0, 1).toLocaleUpperCase() ?? ''}
              </span>
            )}
            <h1>{name ?? t('common:loading')}</h1>
          </div>
          <SlotHost slot="chat.header.actions" />
          {chatId ? <ChatSnapshotsMenu chatId={chatId} /> : null}
          <button
            type="button"
            className={styles.headerSearch}
            onClick={() => setOpen(true)}
            aria-label={t('chat:searchMessages')}
            title={t('chat:searchMessages')}
          >
            <MagnifyingGlass size={18} aria-hidden="true" />
          </button>
          {backToParentChatId ? (
            <button
              type="button"
              className={styles.headerSearch}
              data-component="back-to-parent"
              onClick={() => navigate(`/chats/${backToParentChatId}`)}
              aria-label={t('chat:backToParentChat')}
              title={t('chat:backToParentChat')}
            >
              <ArrowLeft size={18} aria-hidden="true" />
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function countTextMatches(text: string, query: string): number {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return 0;

  const normalizedText = text.toLocaleLowerCase();
  let count = 0;
  let offset = 0;
  while (offset < normalizedText.length) {
    const matchIndex = normalizedText.indexOf(normalizedQuery, offset);
    if (matchIndex === -1) break;
    count += 1;
    offset = matchIndex + normalizedQuery.length;
  }
  return count;
}
