import {
  ArrowCounterClockwise,
  Check,
  ClockCounterClockwise,
  DotsThree,
  PencilSimple,
  User,
  X,
} from '@phosphor-icons/react';
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { Message } from '@neotavern/contracts';
import type { MacroContext } from '@neotavern/shared';
import { expandDisplayMacros } from '../lib/macros.js';
import { useMediaQuery } from '../lib/useMediaQuery.js';
import styles from './MessageBubble.module.css';
import { MessageDetailsCard } from './MessageDetailsCardV2.js';
import { MessageRevisionHistoryCard } from './MessageRevisionHistoryCard.js';
import { MessageSwipePager } from './MessageSwipePager.js';
import { PluginMessageActions } from './PluginMessageActions.js';
import { PluginRenderedMessage } from './PluginMessageRenderers.js';
import { SlotHost } from '../plugins/slots.js';
import {
  BLOCKS_CHANGED_EVENT,
  ensureBlocksLoaded,
  getBlocksForMessage,
  mountBlockContainers,
} from '../plugins/kernel/blocks.js';
import { ConfirmActionDialog } from './ConfirmActionDialog.js';
import {
  getAvailableBuiltinActions,
  getBuiltinActionIcon,
  getBuiltinActionLabels,
  type BuiltinMessageActionId,
  type MessageActionCaps,
} from './messageActions.js';

const SWIPE_THRESHOLD_PX = 56;

export interface MessageSwipeControls {
  current: number;
  total: number;
  disabled?: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

export interface MessageBubbleProps {
  message: Message;
  streaming?: boolean;
  /** Overrides `message.content` while streaming (in-place regeneration). */
  streamingContent?: string;
  /** Optimistic message not yet confirmed by the server; suppresses actions. */
  pending?: boolean;
  assistantIdentity?: {
    name: string;
    avatar: string | null;
  };
  searchQuery?: string;
  /** Greeting or stored-variant swipe controls; the page decides which. */
  swipe?: MessageSwipeControls;
  /** When set, `{{user}}` / `{{char}}` and related macros are expanded for display only. */
  macroContext?: MacroContext;
  /** Active branch of the parent chat, handed to plugin message actions. */
  branchId?: string | null;
  /** Inline editor error (e.g. CAS conflict); shown next to the textarea. */
  editError?: string | null;
  /** Whether the regenerate action is enabled for this message (last assistant). */
  canRegenerate?: boolean;
  onSaveEdit?: (messageId: string, content: string) => Promise<void>;
  onDelete?: (messageId: string) => Promise<void>;
  onToggleContext?: (message: Message) => Promise<void>;
  onCopy?: (message: Message) => Promise<void> | void;
  onRegenerate?: () => void;
  /** Create a snapshot of the chat up to this message (checkpoint or branch). */
  onCreateCheckpoint?: (message: Message, kind: 'checkpoint' | 'branch', replace: boolean) => void;
  onOpenCheckpoint?: (message: Message) => void;
  /** Shift+click on an existing flag: create a fresh checkpoint and open it. */
  onReplaceCheckpoint?: (message: Message) => void;
  onDeleteCheckpoint?: (message: Message) => Promise<void> | void;
  /** Roll the whole chat back to this message (kernel `chats.snapshots.rollback`). */
  onRollbackTo?: (message: Message) => Promise<void> | void;
  /** Open the durable prompt plan of this message's generation run (ТЗ §9.2). */
  onViewPromptPlan?: (message: Message) => void;
}

export const MessageBubble = memo(MessageBubbleInner);

function MessageBubbleInner({
  message,
  streaming = false,
  streamingContent,
  pending: isPending = false,
  assistantIdentity,
  searchQuery,
  swipe,
  onSaveEdit,
  onDelete,
  onToggleContext,
  onCopy,
  onRegenerate,
  onCreateCheckpoint,
  onOpenCheckpoint,
  onReplaceCheckpoint,
  onDeleteCheckpoint,
  onRollbackTo,
  onViewPromptPlan,
  macroContext,
  branchId = null,
  editError = null,
  canRegenerate = false,
}: MessageBubbleProps) {
  const { t, i18n } = useTranslation();
  const isUser = message.role === 'user';
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(message.content);
  const [pending, setPending] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [checkpointDeleteOpen, setCheckpointDeleteOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const [cardMode, setCardMode] = useState<'details' | 'edit'>('details');
  const [revisionHistoryOpen, setRevisionHistoryOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const blockRootRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const articleRef = useRef<HTMLElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const [blockCount, setBlockCount] = useState(() => getBlocksForMessage(message.id).length);
  const excludedFromContext = message.meta['manualExcluded'] === true;
  const messageAuthor = message.name?.trim() || undefined;
  const author = isUser
    ? (messageAuthor ?? t('chat:you'))
    : (messageAuthor ?? assistantIdentity?.name ?? t('chat:assistant'));
  const assistantAvatar = isUser ? null : assistantIdentity?.avatar;
  const swipeEnabled = swipe !== undefined && swipe.total > 1 && !streaming && !editing;
  // In-place regeneration streams into the same bubble; the raw streamed text
  // replaces the content (macros stay unexpanded while streaming).
  const rawContent = streaming ? (streamingContent ?? message.content) : message.content;
  const displayContent = editing
    ? message.content
    : macroContext && !streaming
      ? expandDisplayMacros(rawContent, macroContext)
      : rawContent;
  const timestamp = useMemo(() => {
    if (message.createdAt <= 0) return null;
    const date = new Date(message.createdAt);
    if (!Number.isFinite(date.getTime())) return null;
    return {
      dateTime: date.toISOString(),
      label: new Intl.DateTimeFormat(i18n.language, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date),
    };
  }, [i18n.language, message.createdAt]);
  useEffect(() => {
    const update = (event: Event): void => {
      const detail = (event as CustomEvent<{ messageId?: unknown }>).detail;
      if (detail?.messageId === message.id) {
        setBlockCount(getBlocksForMessage(message.id).length);
      }
    };
    // Persistent blocks (rev4 stage 4): pull the server-side attachments
    // into the host cache on mount; BLOCKS_CHANGED then drives the count.
    void ensureBlocksLoaded(message.chatId, message.id);
    setBlockCount(getBlocksForMessage(message.id).length);
    globalThis.addEventListener(BLOCKS_CHANGED_EVENT, update);
    return () => globalThis.removeEventListener(BLOCKS_CHANGED_EVENT, update);
  }, [message.chatId, message.id]);

  useEffect(() => {
    const root = blockRootRef.current;
    const anchor = articleRef.current;
    if (!root || blockCount === 0) return undefined;
    return mountBlockContainers(message.id, root, anchor ?? undefined);
  }, [message.id, blockCount]);

  useLayoutEffect(() => {
    const textarea = editorRef.current;
    if (!editing || !textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [content, editing]);

  // Keep the editor draft in sync when the committed content changes outside
  // the editor (swipe, remote edit) so a stale draft is never reopened.
  useEffect(() => {
    if (!editing) setContent(message.content);
  }, [message.content, editing]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const cancelEdit = (): void => {
    setContent(message.content);
    setEditing(false);
  };

  const saveEdit = async (): Promise<void> => {
    const nextContent = content.trim();
    if (!onSaveEdit || nextContent.length === 0 || nextContent === message.content) {
      setEditing(false);
      return;
    }
    setPending(true);
    try {
      await onSaveEdit(message.id, nextContent);
      setEditing(false);
    } catch {
      // CAS conflict or network failure: keep the draft open; the page
      // surfaces the error (footer + inline editor error).
    } finally {
      setPending(false);
    }
  };

  const onEditorKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void saveEdit();
    } else if (event.key === 'Escape' && !pending) {
      event.preventDefault();
      cancelEdit();
    }
  };

  const copyMessage = async (): Promise<void> => {
    if (!onCopy) return;
    try {
      await onCopy(message);
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // The page reports clipboard failures; the button just stops pulsing.
    }
  };

  const deleteMessage = async (): Promise<void> => {
    if (!onDelete) return;
    setPending(true);
    try {
      await onDelete(message.id);
      setDeleteOpen(false);
    } finally {
      setPending(false);
    }
  };

  const deleteCheckpoint = async (): Promise<void> => {
    if (!onDeleteCheckpoint) return;
    setPending(true);
    try {
      await onDeleteCheckpoint(message);
      setCheckpointDeleteOpen(false);
    } finally {
      setPending(false);
    }
  };

  const rollbackToHere = async (): Promise<void> => {
    if (!onRollbackTo) return;
    setPending(true);
    try {
      await onRollbackTo(message);
      setRollbackOpen(false);
    } finally {
      setPending(false);
    }
  };

  const toggleContext = async (): Promise<void> => {
    if (!onToggleContext) return;
    setPending(true);
    try {
      await onToggleContext(message);
    } finally {
      setPending(false);
    }
  };

  const handleFlagClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    if (event.shiftKey) {
      onReplaceCheckpoint?.(message);
    } else {
      onOpenCheckpoint?.(message);
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!swipeEnabled || swipe.disabled || event.button !== 0) return;
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!swipeEnabled || swipe.disabled || pointerStartRef.current === null) return;
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX || Math.abs(deltaX) <= Math.abs(deltaY)) return;
    if (deltaX < 0) swipe.onNext();
    else swipe.onPrevious();
  };

  const onPointerCancel = (): void => {
    pointerStartRef.current = null;
  };

  const hasActions = true;
  // Desktop shows every available action inline; the ≤600px compact header
  // swaps them for pencil + ellipsis that open the MessageDetailsCard.
  const isMobile = useMediaQuery('(max-width: 600px)');
  const caps: MessageActionCaps = {
    context: Boolean(onToggleContext),
    edit: Boolean(onSaveEdit),
    copy: Boolean(onCopy),
    regenerate: Boolean(onRegenerate),
    history: !isUser,
    branch: Boolean(onCreateCheckpoint),
    checkpointOpen: Boolean(onOpenCheckpoint),
    checkpointCreate: Boolean(onCreateCheckpoint),
    deleteCheckpoint: Boolean(onDeleteCheckpoint),
    delete: Boolean(onDelete),
    rollback: Boolean(onRollbackTo),
  };
  const availableActions = getAvailableBuiltinActions(message, caps, canRegenerate);
  // Base labels, then the two message-state-dependent ones resolved here
  // (the shared helper has no message in scope).
  const labels = useMemo(() => {
    const base = getBuiltinActionLabels(t);
    if (excludedFromContext) base.context = t('chat:includeInContext');
    if (message.checkpointChatId) base.checkpoint = t('chat:openCheckpoint');
    return base;
  }, [t, excludedFromContext, message.checkpointChatId]);
  const copyLabel = copied ? t('chat:copied') : t('chat:copyMessage');

  const handleBuiltinAction = (id: BuiltinMessageActionId): void => {
    switch (id) {
      case 'context':
        void toggleContext();
        break;
      case 'edit':
        setEditing(true);
        break;
      case 'copy':
        void copyMessage();
        break;
      case 'regenerate':
        onRegenerate?.();
        break;
      case 'history':
        setRevisionHistoryOpen(true);
        break;
      case 'branch':
        onCreateCheckpoint?.(message, 'branch', false);
        break;
      case 'checkpoint':
        if (message.checkpointChatId) onOpenCheckpoint?.(message);
        else onCreateCheckpoint?.(message, 'checkpoint', false);
        break;
      case 'delete':
        setDeleteOpen(true);
        break;
      case 'delete-checkpoint':
        setCheckpointDeleteOpen(true);
        break;
      case 'rollback':
        setRollbackOpen(true);
        break;
    }
  };

  // Card save: unlike the inline editor, a failure must propagate so the card
  // stays open in edit mode and surfaces the error (C3).
  const saveCardEdit = async (content: string): Promise<void> => {
    if (!onSaveEdit) return;
    await onSaveEdit(message.id, content);
  };

  return (
    <>
      <article
        ref={articleRef}
        data-component="chat-message"
        data-role={message.role}
        data-state={streaming ? 'streaming' : editing ? 'editing' : isPending ? 'pending' : 'done'}
        data-context-state={excludedFromContext ? 'excluded' : 'included'}
        data-swipeable={swipeEnabled ? 'true' : undefined}
        className={isUser ? styles.rowUser : styles.rowAssistant}
        aria-label={author}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <header className={styles.messageHeader} data-part="message-header">
          <span
            className={styles.avatar}
            data-part="message-avatar"
            data-state={assistantAvatar ? 'image' : 'fallback'}
            aria-hidden="true"
          >
            {assistantAvatar ? (
              <img className={styles.avatarImage} src={assistantAvatar} alt="" />
            ) : !isUser && assistantIdentity ? (
              <span className={styles.avatarInitial}>
                {assistantIdentity.name.slice(0, 1).toLocaleUpperCase()}
              </span>
            ) : (
              <User size={18} weight="fill" />
            )}
          </span>
          <span className={styles.identity} data-part="message-identity">
            <span className={styles.author} data-part="message-author">
              {author}
            </span>
            {timestamp ? (
              <time
                className={styles.timestamp}
                data-part="message-timestamp"
                dateTime={timestamp.dateTime}
              >
                {timestamp.label}
              </time>
            ) : null}
          </span>
          {!streaming && !isPending && hasActions ? (
            <div
              className={styles.actionBar}
              data-component="message-action-bar"
              data-state={pending ? 'busy' : 'idle'}
              data-part={isMobile ? 'message-actions-compact' : 'message-actions-inline'}
            >
              {isMobile ? (
                <>
                  {onSaveEdit ? (
                    <button
                      type="button"
                      className={styles.actionButton}
                      data-action="edit"
                      onClick={() => {
                        setCardMode('edit');
                        setCardOpen(true);
                      }}
                      disabled={pending}
                      aria-label={t('chat:editMessage')}
                      title={t('chat:editMessage')}
                    >
                      <PencilSimple aria-hidden="true" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.actionButton}
                    data-action="details"
                    onClick={() => {
                      setCardMode('details');
                      setCardOpen(true);
                    }}
                    disabled={pending}
                    aria-label={t('chat:messageDetails')}
                    title={t('chat:messageDetails')}
                  >
                    <DotsThree size={18} aria-hidden="true" />
                  </button>
                </>
              ) : (
                <>
                  {availableActions
                    .filter((id) => id !== 'history' && id !== 'regenerate')
                    .map((id) => {
                      const IconComponent = getBuiltinActionIcon(message, id);
                      const label = id === 'copy' ? copyLabel : labels[id];
                      const openCheckpoint =
                        id === 'checkpoint' && message.checkpointChatId !== null;
                      return (
                        <button
                          key={id}
                          type="button"
                          className={styles.actionButton}
                          data-action={id}
                          onClick={openCheckpoint ? handleFlagClick : () => handleBuiltinAction(id)}
                          disabled={pending || (id === 'edit' && editing)}
                          aria-pressed={id === 'context' ? excludedFromContext : undefined}
                          aria-label={label}
                          title={label}
                        >
                          <IconComponent
                            weight={openCheckpoint ? 'fill' : undefined}
                            aria-hidden="true"
                          />
                        </button>
                      );
                    })}
                  <PluginMessageActions message={message} branchId={branchId} placement="all" />
                  <SlotHost
                    slot="chat.message.actions"
                    context={{ messageId: message.id, chatId: message.chatId }}
                  />
                </>
              )}
            </div>
          ) : null}
        </header>
        <div className={styles.content} data-part="message-content">
          {editing ? (
            <div className={styles.editor} data-part="message-editor">
              <label className={styles.srOnly} htmlFor={`message-${message.id}`}>
                {t('chat:editMessage')}
              </label>
              <textarea
                ref={editorRef}
                id={`message-${message.id}`}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                onKeyDown={onEditorKeyDown}
                disabled={pending}
                rows={4}
              />
              {editError ? (
                <p className={styles.editorError} data-part="message-editor-error" role="alert">
                  {editError}
                </p>
              ) : null}
              <div className={styles.editorActions}>
                <button type="button" onClick={cancelEdit} disabled={pending}>
                  <X size={15} aria-hidden="true" />
                  <span>{t('common:cancel')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void saveEdit()}
                  disabled={pending || content.trim().length === 0}
                >
                  <Check size={15} aria-hidden="true" />
                  <span>{t('common:save')}</span>
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.messageFrame} data-part="message-frame">
              <PluginRenderedMessage
                message={message}
                displayContent={displayContent}
                className={styles.bubble}
                streaming={streaming}
                highlightQuery={searchQuery}
              />
              {assistantAvatar ? (
                <span className={styles.messageArt} data-part="message-art" aria-hidden="true">
                  <img src={assistantAvatar} alt="" />
                </span>
              ) : null}
            </div>
          )}
          {blockCount > 0 ? (
            <div ref={blockRootRef} className={styles.pluginBlocks} data-part="plugin-blocks" />
          ) : null}
          {!editing && !streaming && !isPending && (!isUser || swipeEnabled) ? (
            <div
              className={styles.versionControls}
              data-component="message-version-controls"
              data-part="message-version-controls"
            >
              {!isUser ? (
                <div className={styles.versionQuickActions} data-part="message-version-actions">
                  <button
                    type="button"
                    className={styles.actionButton}
                    aria-label={t('chat:revisionHistory')}
                    title={t('chat:revisionHistory')}
                    data-action="history"
                    onClick={() => setRevisionHistoryOpen(true)}
                  >
                    <ClockCounterClockwise aria-hidden="true" />
                    <span>{t('chat:historyShort')}</span>
                  </button>
                  {canRegenerate && onRegenerate ? (
                    <button
                      type="button"
                      className={styles.actionButton}
                      data-action="regenerate"
                      onClick={onRegenerate}
                      aria-label={t('chat:regenerate')}
                      title={t('chat:regenerate')}
                    >
                      <ArrowCounterClockwise aria-hidden="true" />
                      <span>{t('chat:regenerate')}</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
              {swipeEnabled && swipe ? (
                <MessageSwipePager
                  current={swipe.current}
                  total={swipe.total}
                  disabled={pending || swipe.disabled}
                  onPrevious={swipe.onPrevious}
                  onNext={swipe.onNext}
                />
              ) : null}
            </div>
          ) : null}
          <span className={styles.srOnly} role="status" aria-live="polite">
            {copied ? t('chat:copied') : ''}
          </span>
        </div>
      </article>
      <ConfirmActionDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!pending) setDeleteOpen(open);
        }}
        title={t('chat:deleteMessage')}
        description={t('chat:deleteMessageConfirm')}
        confirmLabel={t('common:delete')}
        busy={pending}
        danger
        onConfirm={() => void deleteMessage()}
      />
      <ConfirmActionDialog
        open={checkpointDeleteOpen}
        onOpenChange={(open) => {
          if (!pending) setCheckpointDeleteOpen(open);
        }}
        title={t('chat:deleteCheckpoint')}
        description={t('chat:deleteCheckpointConfirm')}
        confirmLabel={t('common:delete')}
        busy={pending}
        danger
        onConfirm={() => void deleteCheckpoint()}
      />
      <ConfirmActionDialog
        open={rollbackOpen}
        onOpenChange={(open) => {
          if (!pending) setRollbackOpen(open);
        }}
        title={t('chat:rollbackToHere')}
        description={t('chat:rollbackConfirm')}
        confirmLabel={t('chat:rollbackConfirmLabel')}
        busy={pending}
        danger
        onConfirm={() => void rollbackToHere()}
      />
      <MessageDetailsCard
        open={cardOpen}
        initialMode={cardMode}
        message={message}
        assistantIdentity={assistantIdentity}
        macroContext={macroContext ?? null}
        branchId={branchId}
        canRegenerate={canRegenerate}
        busy={pending}
        editError={editError}
        actions={availableActions}
        labels={labels}
        pluginActions={
          <PluginMessageActions message={message} branchId={branchId} placement="all" />
        }
        onClose={() => setCardOpen(false)}
        onEdit={() => {}}
        onCopy={() => void copyMessage()}
        onToggleContext={() => void toggleContext()}
        onHistory={() => {
          setCardOpen(false);
          setRevisionHistoryOpen(true);
        }}
        onBuiltinAction={(id) => {
          setCardOpen(false);
          if (id === 'regenerate') onRegenerate?.();
          else if (id === 'branch') onCreateCheckpoint?.(message, 'branch', false);
          else if (id === 'checkpoint') {
            if (message.checkpointChatId) onOpenCheckpoint?.(message);
            else onCreateCheckpoint?.(message, 'checkpoint', false);
          } else if (id === 'delete') setDeleteOpen(true);
          else if (id === 'delete-checkpoint') setCheckpointDeleteOpen(true);
        }}
        onSaveEdit={saveCardEdit}
        onViewPromptPlan={onViewPromptPlan}
      />
      <MessageRevisionHistoryCard
        open={revisionHistoryOpen}
        message={message}
        onClose={() => setRevisionHistoryOpen(false)}
      />
    </>
  );
}
