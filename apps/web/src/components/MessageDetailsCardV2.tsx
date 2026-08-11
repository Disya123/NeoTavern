/** Mobile ST1-style message details, action menu and editor. */
import {
  CalendarBlank,
  ChatCircleDots,
  ClockCounterClockwise,
  Copy,
  Eye,
  EyeSlash,
  Lightning,
  PencilSimple,
  Plus,
  Robot,
  Timer,
  User,
  X,
} from '@phosphor-icons/react';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent } from '@neotavern/ui';
import { parseMessageGenerationMeta, type Message } from '@neotavern/contracts';
import type { MacroContext } from '@neotavern/shared';
import { expandDisplayMacros } from '../lib/macros.js';
import { getBuiltinActionIcon, type BuiltinMessageActionId } from './messageActions.js';
import { PluginMessageActions } from './PluginMessageActions.js';
import { PluginRenderedMessage } from './PluginMessageRenderers.js';
import styles from './MessageDetailsCardV2.module.css';

export type MessageDetailsMode = 'details' | 'actions' | 'edit';

export interface MessageDetailsCardProps {
  open: boolean;
  initialMode: 'details' | 'edit';
  message: Message;
  assistantIdentity?: { name: string; avatar: string | null } | null;
  macroContext?: MacroContext | null;
  branchId?: string | null;
  canRegenerate: boolean;
  busy: boolean;
  editError?: string | null;
  actions: readonly BuiltinMessageActionId[];
  labels: Record<BuiltinMessageActionId, string>;
  pluginActions?: ReactNode;
  onClose: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onToggleContext: () => void;
  onHistory: () => void;
  onBuiltinAction: (id: BuiltinMessageActionId) => void;
  onSaveEdit: (content: string) => Promise<void>;
}

const DRAG_DISMISS_THRESHOLD_PX = 56;

export function MessageDetailsCard({
  open,
  initialMode,
  message,
  assistantIdentity = null,
  macroContext = null,
  branchId = null,
  busy,
  editError = null,
  actions,
  labels,
  onClose,
  onEdit,
  onCopy,
  onToggleContext,
  onHistory,
  onBuiltinAction,
  onSaveEdit,
}: MessageDetailsCardProps) {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<MessageDetailsMode>(initialMode);
  const [draft, setDraft] = useState(message.content);
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const prevOpenRef = useRef(open);
  const dragStartYRef = useRef<number | null>(null);

  const isUser = message.role === 'user';
  const excludedFromContext = message.meta['manualExcluded'] === true;
  const messageAuthor = message.name?.trim() || undefined;
  const author = isUser
    ? (messageAuthor ?? t('chat:you'))
    : (messageAuthor ?? assistantIdentity?.name ?? t('chat:assistant'));

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setMode(initialMode);
      setDraft(message.content);
    }
    prevOpenRef.current = open;
  }, [open, initialMode, message.content]);

  useLayoutEffect(() => {
    const textarea = editorRef.current;
    if (mode !== 'edit' || !textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = String(textarea.scrollHeight) + 'px';
  }, [draft, mode]);

  const sent = useMemo(() => {
    if (message.createdAt <= 0) return null;
    const date = new Date(message.createdAt);
    if (!Number.isFinite(date.getTime())) return null;
    return new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }, [i18n.language, message.createdAt]);

  const generation = useMemo(
    () => parseMessageGenerationMeta(message.meta['generation']),
    [message.meta],
  );
  const model =
    generation?.model ?? (typeof message.meta['model'] === 'string' ? message.meta['model'] : null);
  const generationTime = useMemo(() => {
    if (!generation) return null;
    const seconds = new Intl.NumberFormat(i18n.language, {
      maximumFractionDigits: 1,
    }).format(generation.durationMs / 1000);
    return seconds + t('chat:secondsShort');
  }, [generation, i18n.language, t]);
  const displayContent = useMemo(
    () => (macroContext ? expandDisplayMacros(message.content, macroContext) : message.content),
    [macroContext, message.content],
  );

  const tokenCount = useMemo(() => {
    if (generation?.usage?.totalTokens != null) return generation.usage.totalTokens;
    if (typeof message.meta['tokenCount'] === 'number') return message.meta['tokenCount'];
    if (typeof message.meta['tokens'] === 'number') return message.meta['tokens'];
    const budget = message.meta['tokenBudget'] as
      | { promptTokens?: number; completionTokens?: number }
      | undefined;
    if (budget && typeof budget.completionTokens === 'number') return budget.completionTokens;
    return null;
  }, [generation, message.meta]);
  const quickActions = actions.filter((id) => id !== 'copy' && id !== 'edit');
  const menuActions = actions.filter((id) => id !== 'delete');
  const hasDelete = actions.includes('delete');
  const DeleteIcon = getBuiltinActionIcon(message, 'delete');

  const closeCard = (): void => {
    setDraft(message.content);
    onClose();
  };
  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    dragStartYRef.current = event.clientY;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const startY = dragStartYRef.current;
    dragStartYRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (startY !== null && event.clientY - startY >= DRAG_DISMISS_THRESHOLD_PX) {
      closeCard();
    }
  };

  const cancelDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    dragStartYRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const cancelEdit = (): void => {
    setDraft(message.content);
    if (initialMode === 'edit') onClose();
    else setMode('details');
  };

  const handleEditSwitch = (): void => {
    setDraft(message.content);
    setMode('edit');
    onEdit();
  };

  const saveEdit = async (): Promise<void> => {
    const nextContent = draft.trim();
    if (nextContent.length === 0 || saving) return;
    if (nextContent === message.content) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await onSaveEdit(nextContent);
      onClose();
    } catch {
      // Keep the draft open; the parent localizes and supplies editError.
    } finally {
      setSaving(false);
    }
  };

  const onEditorKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void saveEdit();
    } else if (event.key === 'Escape' && !saving) {
      event.preventDefault();
      cancelEdit();
    }
  };

  const runBuiltinAction = (id: BuiltinMessageActionId): void => {
    if (id === 'edit') handleEditSwitch();
    else if (id === 'copy') onCopy();
    else if (id === 'context') onToggleContext();
    else if (id === 'history') onHistory();
    else onBuiltinAction(id);
  };

  const isBusy = busy || saving;
  const editorId = 'message-details-' + message.id;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && closeCard()}>
      <DialogContent className={styles.dialog} title={t('chat:messageDetails')}>
        <div
          className={styles.card}
          data-component="message-details-card"
          data-state={mode}
          data-role={message.role}
        >
          {mode === 'edit' ? (
            <div className={styles.editor} data-part="details-editor">
              <label className={styles.srOnly} htmlFor={editorId}>
                {t('chat:editMessage')}
              </label>
              <textarea
                ref={editorRef}
                id={editorId}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onEditorKeyDown}
                disabled={isBusy}
                rows={4}
              />
              {editError ? (
                <p className={styles.editorError} data-part="details-editor-error" role="alert">
                  {editError}
                </p>
              ) : null}
              <div className={styles.editorActions}>
                <button type="button" onClick={cancelEdit} disabled={isBusy}>
                  {t('common:cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void saveEdit()}
                  disabled={isBusy || draft.trim().length === 0}
                >
                  {t('chat:confirmEdit')}
                </button>
              </div>
            </div>
          ) : mode === 'actions' ? (
            <div className={styles.actionMode} data-part="details-action-menu">
              <button
                type="button"
                className={styles.dragHandle}
                data-part="drag-handle"
                aria-label={t('chat:dragDownToClose')}
                onPointerDown={startDrag}
                onPointerUp={finishDrag}
                onPointerCancel={cancelDrag}
              />
              <header className={styles.actionHeader}>
                <MessageIdentity
                  author={author}
                  isUser={isUser}
                  avatar={assistantIdentity?.avatar ?? null}
                  assistantName={assistantIdentity?.name ?? null}
                />
                <button
                  type="button"
                  className={styles.closeActions}
                  onClick={() => setMode('details')}
                  aria-label={t('chat:closeActionMenu')}
                >
                  <X aria-hidden="true" />
                </button>
              </header>
              <div className={styles.preview} data-part="details-action-preview">
                {displayContent}
              </div>
              <div className={styles.actionScroll}>
                {hasDelete ? (
                  <section className={styles.actionGroup} data-part="details-danger-zone">
                    <h3>{t('chat:dangerZone')}</h3>
                    <button
                      type="button"
                      className={styles.dangerAction}
                      data-action="delete"
                      onClick={() => onBuiltinAction('delete')}
                      disabled={isBusy}
                    >
                      <DeleteIcon aria-hidden="true" />
                      <span>{t('chat:deleteMessageWithHistory')}</span>
                    </button>
                  </section>
                ) : null}
                <section className={styles.actionGroup} data-part="details-core-actions">
                  <h3>{t('chat:messageActions')}</h3>
                  {menuActions.map((id) => {
                    const IconComponent = getBuiltinActionIcon(message, id);
                    return (
                      <button
                        key={id}
                        type="button"
                        className={styles.listAction}
                        data-action={id}
                        onClick={() => runBuiltinAction(id)}
                        disabled={isBusy}
                        aria-pressed={id === 'context' ? excludedFromContext : undefined}
                      >
                        <IconComponent
                          aria-hidden="true"
                          weight={
                            id === 'checkpoint' && message.checkpointChatId ? 'fill' : undefined
                          }
                        />
                        <span>{labels[id]}</span>
                      </button>
                    );
                  })}
                  <PluginMessageActions
                    message={message}
                    branchId={branchId}
                    placement="all"
                    variant="list"
                  />
                </section>
              </div>
            </div>
          ) : (
            <div className={styles.details}>
              <button
                type="button"
                className={styles.dragHandle}
                data-part="drag-handle"
                aria-label={t('chat:dragDownToClose')}
                onPointerDown={startDrag}
                onPointerUp={finishDrag}
                onPointerCancel={cancelDrag}
              />
              <header className={styles.header} data-part="details-header">
                <MessageIdentity
                  author={author}
                  isUser={isUser}
                  avatar={assistantIdentity?.avatar ?? null}
                  assistantName={assistantIdentity?.name ?? null}
                />
                <div className={styles.badges} data-part="details-badges">
                  {message.variantCount > 1 ? (
                    <span
                      title={t('chat:swipeCounter', {
                        current: (message.activeVariantPosition ?? 0) + 1,
                        total: message.variantCount,
                      })}
                    >
                      <ChatCircleDots aria-hidden="true" />
                      {message.variantCount}
                    </span>
                  ) : null}
                  {tokenCount !== null ? (
                    <span title={t('chat:contextTokenCount', { count: tokenCount })}>
                      <Lightning aria-hidden="true" />
                      {tokenCount}t
                    </span>
                  ) : null}
                </div>
              </header>

              <dl className={styles.meta} data-part="details-meta">
                {sent ? (
                  <MetaRow
                    icon={<CalendarBlank aria-hidden="true" />}
                    label={t('chat:sentAt')}
                    value={sent}
                  />
                ) : null}
                {model ? (
                  <MetaRow
                    icon={<Robot aria-hidden="true" />}
                    label={t('chat:model')}
                    value={model}
                  />
                ) : null}
                {generationTime ? (
                  <MetaRow
                    icon={<Timer aria-hidden="true" />}
                    label={t('chat:generationTime')}
                    value={generationTime}
                  />
                ) : null}
              </dl>

              <div className={styles.quickActions} data-part="details-actions">
                {quickActions.map((id) => {
                  const IconComponent = getBuiltinActionIcon(message, id);
                  return (
                    <button
                      key={id}
                      type="button"
                      className={styles.circleAction}
                      data-action={id}
                      onClick={() => runBuiltinAction(id)}
                      disabled={isBusy}
                      aria-pressed={id === 'context' ? excludedFromContext : undefined}
                      aria-label={labels[id]}
                      title={labels[id]}
                    >
                      <IconComponent
                        aria-hidden="true"
                        weight={
                          id === 'checkpoint' && message.checkpointChatId ? 'fill' : undefined
                        }
                      />
                    </button>
                  );
                })}
                <PluginMessageActions
                  message={message}
                  branchId={branchId}
                  placement="all"
                  variant="circle"
                />
              </div>

              <div
                className={styles.content}
                data-part="details-content"
                tabIndex={0}
              >
                <PluginRenderedMessage
                  message={message}
                  displayContent={displayContent}
                  streaming={false}
                />
              </div>

              <footer className={styles.footer} data-part="details-footer">
                {actions.includes('copy') ? (
                  <FooterAction
                    action="copy"
                    label={t('chat:copyShort')}
                    ariaLabel={labels.copy}
                    icon={<Copy aria-hidden="true" />}
                    disabled={isBusy}
                    onClick={onCopy}
                  />
                ) : null}
                {actions.includes('context') && !quickActions.includes('context') ? (
                  <FooterAction
                    action="context"
                    label={excludedFromContext ? t('chat:includeShort') : t('chat:excludeShort')}
                    ariaLabel={labels.context}
                    icon={
                      excludedFromContext ? (
                        <Eye aria-hidden="true" />
                      ) : (
                        <EyeSlash aria-hidden="true" />
                      )
                    }
                    disabled={isBusy}
                    pressed={excludedFromContext}
                    onClick={onToggleContext}
                  />
                ) : null}
                <button
                  type="button"
                  className={styles.plusAction}
                  data-part="details-footer-action"
                  data-action="actions"
                  onClick={() => setMode('actions')}
                  disabled={isBusy}
                  aria-label={t('chat:openActionMenu')}
                >
                  <Plus aria-hidden="true" />
                </button>
                {actions.includes('history') && !quickActions.includes('history') ? (
                  <FooterAction
                    action="history"
                    label={t('chat:historyShort')}
                    ariaLabel={labels.history}
                    icon={<ClockCounterClockwise aria-hidden="true" />}
                    disabled={isBusy}
                    onClick={onHistory}
                  />
                ) : null}
                {actions.includes('edit') ? (
                  <FooterAction
                    action="edit"
                    label={t('chat:editShort')}
                    ariaLabel={labels.edit}
                    icon={<PencilSimple aria-hidden="true" />}
                    disabled={isBusy}
                    onClick={handleEditSwitch}
                  />
                ) : null}
              </footer>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MessageIdentity({
  author,
  isUser,
  avatar,
  assistantName,
}: {
  author: string;
  isUser: boolean;
  avatar: string | null;
  assistantName: string | null;
}) {
  return (
    <span className={styles.identity}>
      <span
        className={styles.avatar}
        data-part="details-avatar"
        data-state={avatar ? 'image' : 'fallback'}
        aria-hidden="true"
      >
        {avatar ? (
          <img className={styles.avatarImage} src={avatar} alt="" />
        ) : !isUser && assistantName ? (
          <span className={styles.avatarInitial}>
            {assistantName.slice(0, 1).toLocaleUpperCase()}
          </span>
        ) : (
          <User size={18} weight="fill" />
        )}
      </span>
      <span className={styles.author} data-part="details-author">
        {author}
      </span>
    </span>
  );
}

function MetaRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className={styles.metaRow} data-part="details-meta-row">
      <dt>
        {icon}
        <span>{label}</span>
      </dt>
      <dd>{value}</dd>
    </div>
  );
}

function FooterAction({
  action,
  label,
  ariaLabel,
  icon,
  disabled,
  pressed,
  onClick,
}: {
  action: BuiltinMessageActionId;
  label: string;
  ariaLabel: string;
  icon: ReactNode;
  disabled: boolean;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.footerAction}
      data-part="details-footer-action"
      data-action={action}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={action === 'context' ? pressed : undefined}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
