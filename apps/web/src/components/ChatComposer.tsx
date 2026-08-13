/**
 * Shared conversation composer. Purely presentational for draft/context chrome:
 * the page owns draft value and context-panel state. Submit chrome (Send /
 * Stop) and the utility row (settings shortcut, scroll-to-latest, reset) live
 * here so `/home` and `/chats/:id` cannot drift вЂ” pages only pass behavior and
 * busy state. The visible placeholder is a prop while the accessible label is
 * fixed to `chat:placeholder` ("Type a messageвЂ¦") вЂ” the e2e suite locates the
 * field by that label on both routes.
 */
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
  type TransitionEvent as ReactTransitionEvent,
} from 'react';
import {
  ArrowDown,
  Database,
  GearSix,
  List,
  MagicWand,
  PaperPlaneRight,
  StopCircle,
  X,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Button, IconButton } from '@neotavern/ui';
import { SlotHost } from '../plugins/slots.js';
import styles from './ChatWorkspace.module.css';

export type ChatComposerProps = {
  textareaId: string;
  value: string;
  placeholder: string;
  inputRef: Ref<HTMLTextAreaElement>;
  rows?: number;
  onChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;

  onOpenSettings: () => void;
  onReset: () => void;
  /** Extra toolbar controls after Settings/Reset (e.g. Regenerate in a live chat). */
  extraToolbarActions?: ReactNode;
  /**
   * Scroll the message viewport to the newest content. When omitted, the
   * scroll-to-latest utility is hidden (Home has nothing to scroll to).
   */
  onScrollToLatest?: () => void;

  contextPanelId: string;
  contextOpen: boolean;
  contextTriggerTitle: string;
  contextTriggerLabel: string;
  onToggleContext: () => void;
  contextPanel?: ReactNode;

  /** Primary submit (send message or open a new chat from Home). */
  onSubmit: () => void;
  submitDisabled?: boolean;
  /**
   * Replaces the default Send label while a non-streaming submit is pending
   * (e.g. Home creating a chat). Ignored while {@link isGenerating} is true.
   */
  submitPendingLabel?: string;
  /** Live chat streaming: shows Stop instead of Send. Requires {@link onStop}. */
  isGenerating?: boolean;
  onStop?: () => void;
};

export function ChatComposer({
  textareaId,
  value,
  placeholder,
  inputRef,
  rows,
  onChange,
  onKeyDown,
  onOpenSettings,
  onReset,
  extraToolbarActions,
  onScrollToLatest,
  contextPanelId,
  contextOpen,
  contextTriggerTitle,
  contextTriggerLabel,
  onToggleContext,
  contextPanel,
  onSubmit,
  submitDisabled = false,
  submitPendingLabel,
  isGenerating = false,
  onStop,
}: ChatComposerProps) {
  const { t } = useTranslation();
  const showStop = isGenerating && onStop !== undefined;
  type ContextPanelPhase = 'hidden' | 'entering' | 'shown' | 'leaving';
  const [contextPhase, setContextPhase] = useState<ContextPanelPhase>(
    contextOpen ? 'shown' : 'hidden',
  );
  const [contextPanelHeight, setContextPanelHeight] = useState(0);
  const contextPanelRef = useRef<HTMLDivElement>(null);
  const contextPhaseRef = useRef(contextPhase);
  const contextOpenRef = useRef(contextOpen);
  contextPhaseRef.current = contextPhase;
  contextOpenRef.current = contextOpen;

  useLayoutEffect(() => {
    if (contextOpen) {
      setContextPhase('entering');
      return;
    }

    setContextPhase((phase) => {
      if (phase === 'hidden' || phase === 'entering') return 'hidden';
      return 'leaving';
    });
  }, [contextOpen]);

  useLayoutEffect(() => {
    if (contextPhase !== 'entering' || !contextPanelRef.current) return;

    const panel = contextPanelRef.current;
    panel.style.maxHeight = 'none';
    const measuredHeight = panel.scrollHeight;
    panel.style.removeProperty('max-height');
    setContextPanelHeight(measuredHeight > 0 ? measuredHeight : 320);

    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (contextOpenRef.current) setContextPhase('shown');
      });
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [contextPhase]);

  const contextPanelState =
    contextPhase === 'shown' ? 'visible' : contextPhase === 'leaving' ? 'leaving' : 'hidden';

  const finishContextPanelTransition = (event: ReactTransitionEvent<HTMLDivElement>): void => {
    if (
      event.target !== event.currentTarget ||
      event.propertyName !== 'max-height' ||
      contextPhaseRef.current !== 'leaving'
    ) {
      return;
    }

    setContextPhase('hidden');
    setContextPanelHeight(0);
  };

  const contextPanelStyle =
    contextPanelHeight > 0
      ? ({
          '--context-panel-measured-height': `${contextPanelHeight}px`,
        } as CSSProperties)
      : undefined;

  return (
    <div className={styles.composer} data-slot="chat.composer">
      <div className={styles.composerToolbar} data-part="toolbar">
        <div className={styles.toolbarActions}>
          <button
            type="button"
            className={styles.menuButton}
            onClick={onOpenSettings}
            aria-label={t('navigation:settings')}
            title={t('navigation:settings')}
          >
            <GearSix aria-hidden="true" />
            <span>{t('navigation:settings')}</span>
          </button>
          <IconButton
            className={styles.iconButton}
            onClick={onReset}
            aria-label={t('common:reset')}
            title={t('common:reset')}
          >
            <X size={17} aria-hidden="true" />
          </IconButton>
          {extraToolbarActions ? (
            <div className={styles.extraActions}>{extraToolbarActions}</div>
          ) : null}
        </div>
        <button
          type="button"
          className={styles.contextTrigger}
          onClick={onToggleContext}
          aria-expanded={contextOpen}
          aria-controls={contextPanelId}
          title={contextTriggerTitle}
        >
          <Database size={15} aria-hidden="true" />
          <span>{contextTriggerLabel}</span>
        </button>
      </div>

      {contextPhase !== 'hidden' ? (
        <div
          ref={contextPanelRef}
          className={styles.contextPanelSlot}
          data-part="context-panel"
          data-state={contextPanelState}
          style={contextPanelStyle}
          onTransitionEnd={finishContextPanelTransition}
        >
          {contextPanel}
        </div>
      ) : null}

      <div className={styles.composerField} data-part="field">
        <label className={styles.srOnly} htmlFor={textareaId}>
          {t('chat:placeholder')}
        </label>
        <textarea
          id={textareaId}
          ref={inputRef}
          data-component="textarea"
          rows={rows}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className={styles.composerActions}>
          <div className={styles.composerUtilities}>
            <button
              type="button"
              onClick={onOpenSettings}
              aria-label={t('navigation:settings')}
              title={t('navigation:settings')}
            >
              <List size={19} aria-hidden="true" />
            </button>
            {onScrollToLatest ? (
              <button
                type="button"
                onClick={onScrollToLatest}
                aria-label={t('chat:scrollToLatest')}
                title={t('chat:scrollToLatest')}
              >
                <ArrowDown size={19} aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={onReset}
              aria-label={t('common:reset')}
              title={t('common:reset')}
            >
              <MagicWand size={19} aria-hidden="true" />
            </button>
          </div>
          <SlotHost slot="generation.controls" />
          <div className={styles.sendSlot}>
            {showStop ? (
              <Button
                variant="danger"
                onClick={onStop}
                aria-label={t('chat:stop')}
                title={t('chat:stop')}
              >
                <StopCircle aria-hidden="true" />
                <span>{t('chat:stop')}</span>
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={onSubmit}
                disabled={submitDisabled}
                aria-label={submitPendingLabel ?? t('chat:send')}
                title={submitPendingLabel ?? t('chat:send')}
              >
                <span>{submitPendingLabel ?? t('chat:send')}</span>
                <PaperPlaneRight weight="fill" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
