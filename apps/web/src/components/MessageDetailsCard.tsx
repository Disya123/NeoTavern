/**
 * ST1-style message details card (C3): the mobile surface for message actions.
 *
 * At ≤600px the message header keeps only pencil + ellipsis; both open this
 * card. The pencil opens it directly in edit mode; the ellipsis opens it in
 * details mode (Sent/Model/Generation meta, the full horizontal action panel,
 * rendered content and a pinned Copy / Exclude-Include / Edit footer).
 *
 * The shell is the `@neotavern/ui` Radix Dialog — at ≤600px the shared stylesheet
 * turns it into a bottom sheet with safe-area padding, focus trap, Escape and
 * backdrop dismissal, and focus restore. This file only styles the internal
 * card layout.
 *
 * Data hooks (themed via docs/ux, stable contract): root
 * `data-component="message-details-card"` with `data-state={mode}` and parts
 * drag-handle / details-header / details-avatar / details-author / details-meta
 * / details-meta-row / details-actions / details-content / details-footer /
 * details-footer-action / details-editor / details-editor-error. Built-in
 * action buttons keep the shared `data-action={id}` ids (C2).
 */
import { Copy, Eye, EyeSlash, PencilSimple, User } from '@phosphor-icons/react';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent } from '@neotavern/ui';
import { parseMessageGenerationMeta, type Message } from '@neotavern/contracts';
import type { MacroContext } from '@neotavern/shared';
import { expandDisplayMacros } from '../lib/macros.js';
import { getBuiltinActionIcon, type BuiltinMessageActionId } from './messageActions.js';
import { PluginRenderedMessage } from './PluginMessageRenderers.js';
import styles from './MessageDetailsCard.module.css';

export interface MessageDetailsCardProps {
  open: boolean;
  /** pencil → 'edit' (Cancel closes the card); ellipsis → 'details' (Cancel returns to details). */
  initialMode: 'details' | 'edit';
  message: Message;
  assistantIdentity?: { name: string; avatar: string | null } | null;
  macroContext?: MacroContext | null;
  canRegenerate: boolean;
  /** Disables controls while a save/action is in flight. */
  busy: boolean;
  /** Edit failure (e.g. CAS conflict) surfaced next to the textarea. */
  editError?: string | null;
  /** Already filtered to the actions available for this message. */
  actions: readonly BuiltinMessageActionId[];
  /** Message-aware labels (context/checkpoint resolved against message state). */
  labels: Record<BuiltinMessageActionId, string>;
  /** `<PluginMessageActions placement="all" .../>` rendered after the built-ins. */
  pluginActions?: ReactNode;
  onClose: () => void;
  /** details → edit switch notification. */
  onEdit: () => void;
  onCopy: () => void;
  onToggleContext: () => void;
  /** regenerate/branch/checkpoint/delete/delete-checkpoint. */
  onBuiltinAction: (id: BuiltinMessageActionId) => void;
  onSaveEdit: (content: string) => Promise<void>;
}

export function MessageDetailsCard({
  open,
  initialMode,
  message,
  assistantIdentity = null,
  macroContext = null,
  busy,
  editError = null,
  actions,
  labels,
  pluginActions,
  onClose,
  onEdit,
  onCopy,
  onToggleContext,
  onBuiltinAction,
  onSaveEdit,
}: MessageDetailsCardProps) {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<'details' | 'edit'>(initialMode);
  const [draft, setDraft] = useState(message.content);
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const prevOpenRef = useRef(open);

  const isUser = message.role === 'user';
  const excludedFromContext = message.meta['manualExcluded'] === true;
  const messageAuthor = message.name?.trim() || undefined;
  const author = isUser
    ? (messageAuthor ?? t('chat:you'))
    : (messageAuthor ?? assistantIdentity?.name ?? t('chat:assistant'));

  // Reset to initialMode whenever `open` transitions false → true (the card
  // stays mounted; the parent flips `open` between messages).
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setMode(initialMode);
      setDraft(message.content);
    }
    prevOpenRef.current = open;
  }, [open, initialMode, message.content]);

  // Autosize the edit textarea (same pattern as the MessageBubble editor).
  useLayoutEffect(() => {
    const textarea = editorRef.current;
    if (mode !== 'edit' || !textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${textarea.scrollHeight}px`;
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
    // The parser consumes the value stored UNDER meta.generation (C1); the
    // legacy top-level meta.model is only a fallback for old messages.
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
    return `${seconds}${t('chat:secondsShort')}`;
  }, [generation, i18n.language, t]);

  const displayContent = useMemo(
    () => (macroContext ? expandDisplayMacros(message.content, macroContext) : message.content),
    [macroContext, message.content],
  );

  const closeCard = (): void => {
    setDraft(message.content);
    onClose();
  };

  // Escape / backdrop / programmatic close (Radix calls with `false`):
  // discard the draft and close the card — same as Cancel from the pencil.
  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) closeCard();
  };

  const cancelEdit = (): void => {
    setDraft(message.content);
    if (initialMode === 'edit') {
      onClose();
    } else {
      setMode('details');
    }
  };

  const handleEditSwitch = (): void => {
    setDraft(message.content);
    setMode('edit');
    onEdit();
  };

  const saveEdit = async (): Promise<void> => {
    const nextContent = draft.trim();
    if (nextContent.length === 0 || saving) return;
    setSaving(true);
    try {
      await onSaveEdit(nextContent);
      onClose();
    } catch {
      // Failure: stay in edit mode; the parent surfaces `editError`.
    } finally {
      setSaving(false);
    }
  };

  const onEditorKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void saveEdit();
    }
  };

  const isBusy = busy || saving;
  const editorId = `message-details-${message.id}`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={styles.dialog} title={t('chat:messageDetails')}>
        <div className={styles.card} data-component="message-details-card" data-state={mode}>
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
          ) : (
            <div className={styles.details}>
              <div className={styles.dragHandle} data-part="drag-handle" aria-hidden="true" />
              <header className={styles.header} data-part="details-header">
                <span
                  className={styles.avatar}
                  data-part="details-avatar"
                  data-state={assistantIdentity?.avatar ? 'image' : 'fallback'}
                  aria-hidden="true"
                >
                  {assistantIdentity?.avatar ? (
                    <img className={styles.avatarImage} src={assistantIdentity.avatar} alt="" />
                  ) : !isUser && assistantIdentity ? (
                    <span className={styles.avatarInitial}>
                      {assistantIdentity.name.slice(0, 1).toLocaleUpperCase()}
                    </span>
                  ) : (
                    <User size={18} weight="fill" />
                  )}
                </span>
                <span className={styles.author} data-part="details-author">
                  {author}
                </span>
              </header>
              <dl className={styles.meta} data-part="details-meta">
                {sent ? (
                  <div className={styles.metaRow} data-part="details-meta-row">
                    <dt>{t('chat:sentAt')}</dt>
                    <dd>{sent}</dd>
                  </div>
                ) : null}
                {model ? (
                  <div className={styles.metaRow} data-part="details-meta-row">
                    <dt>{t('chat:model')}</dt>
                    <dd>{model}</dd>
                  </div>
                ) : null}
                {generationTime ? (
                  <div className={styles.metaRow} data-part="details-meta-row">
                    <dt>{t('chat:generationTime')}</dt>
                    <dd>{generationTime}</dd>
                  </div>
                ) : null}
              </dl>
              <div className={styles.actions} data-part="details-actions">
                {actions.map((id) => {
                  const IconComponent = getBuiltinActionIcon(message, id);
                  const label = labels[id];
                  const handlePanelAction = (): void => {
                    if (id === 'edit') handleEditSwitch();
                    else if (id === 'copy') onCopy();
                    else if (id === 'context') onToggleContext();
                    else onBuiltinAction(id);
                  };
                  return (
                    <button
                      key={id}
                      type="button"
                      className={styles.panelAction}
                      data-action={id}
                      onClick={handlePanelAction}
                      disabled={busy}
                      aria-label={label}
                      title={label}
                    >
                      <IconComponent
                        aria-hidden="true"
                        weight={
                          id === 'checkpoint' && message.checkpointChatId ? 'fill' : undefined
                        }
                      />
                      <span>{label}</span>
                    </button>
                  );
                })}
                {pluginActions}
              </div>
              <div className={styles.content} data-part="details-content">
                <PluginRenderedMessage
                  message={message}
                  displayContent={displayContent}
                  streaming={false}
                />
              </div>
              <footer className={styles.footer} data-part="details-footer">
                {actions.includes('copy') ? (
                  <button
                    type="button"
                    className={styles.footerAction}
                    data-part="details-footer-action"
                    data-action="copy"
                    onClick={() => onCopy()}
                    disabled={busy}
                  >
                    <Copy aria-hidden="true" />
                    <span>{labels['copy']}</span>
                  </button>
                ) : null}
                {actions.includes('context') ? (
                  <button
                    type="button"
                    className={styles.footerAction}
                    data-part="details-footer-action"
                    data-action="context"
                    onClick={() => onToggleContext()}
                    disabled={busy}
                    aria-pressed={excludedFromContext}
                  >
                    {excludedFromContext ? (
                      <Eye aria-hidden="true" />
                    ) : (
                      <EyeSlash aria-hidden="true" />
                    )}
                    <span>{labels['context']}</span>
                  </button>
                ) : null}
                {actions.includes('edit') ? (
                  <button
                    type="button"
                    className={styles.footerAction}
                    data-part="details-footer-action"
                    data-action="edit"
                    onClick={handleEditSwitch}
                    disabled={busy}
                  >
                    <PencilSimple aria-hidden="true" />
                    <span>{labels['edit']}</span>
                  </button>
                ) : null}
              </footer>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
