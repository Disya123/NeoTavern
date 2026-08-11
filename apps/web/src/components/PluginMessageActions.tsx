import {
  Copy,
  FloppyDisk,
  MagicWand,
  MagnifyingGlass,
  PuzzlePiece,
  PushPin,
  SpeakerHigh,
  TextT,
  ThumbsDown,
  ThumbsUp,
  Translate,
  Trash,
  type Icon,
} from '@phosphor-icons/react';
import { randomToken } from '@neotavern/shared';
import type { MessageActionSnapshot } from '@neotavern/plugin-sdk';
import { useEffect, useRef, useState } from 'react';
import type { Message } from '@neotavern/contracts';
import {
  frontendPluginRuntime,
  usePluginRegistrations,
  type PluginUiRegistration,
} from '../plugins/runtime.js';
import styles from './PluginMessageActions.module.css';

/**
 * Semantic icon names sent by plugins → host Phosphor icons.
 * Unknown names fall back to the generic PuzzlePiece. Exported for tests.
 */
export const MESSAGE_ACTION_ICONS: Readonly<Record<string, Icon>> = {
  translate: Translate,
  speak: SpeakerHigh,
  tts: SpeakerHigh,
  summarize: TextT,
  rewrite: MagicWand,
  analyze: MagnifyingGlass,
  copy: Copy,
  save: FloppyDisk,
  delete: Trash,
  like: ThumbsUp,
  dislike: ThumbsDown,
  pin: PushPin,
};

const DEFAULT_ACTION_ICON: Icon = PuzzlePiece;
/** Actions without an explicit order sort after everything else (SDK default). */
const DEFAULT_ACTION_ORDER = 100;

export interface PluginMessageActionsProps {
  message: Message;
  /** Id of the chat branch the message belongs to (`null` when unknown). */
  branchId: string | null;
  /**
   * Which action-bar placement to render: 'primary' bar, 'overflow' menu, or
   * 'all' — a single row merging primary + overflow + legacy context-menu
   * actions (sorted by order, then registrationId). The host desktop action
   * bar uses 'all' since it has no overflow menu anymore.
   */
  placement: 'primary' | 'overflow' | 'all';
  /** Host render shape; SDK registrations stay unchanged. */
  variant?: 'inline' | 'circle' | 'list';
  /** Notifies the host after a plugin action has been dispatched. */
  onInvoked?: () => void;
  /**
   * Called with the registrationId of the currently running action, or null
   * when nothing runs. Lets the host disable its own controls while a plugin
   * action is in flight.
   */
  onRunningChange?: (runningId: string | null) => void;
}

export function PluginMessageActions({
  message,
  branchId,
  placement,
  variant = 'inline',
  onInvoked,
  onRunningChange,
}: PluginMessageActionsProps) {
  const registrations = usePluginRegistrations('messageActions');
  // Legacy contextMenuItems with context 'message' rendered as bubble buttons
  // before the action bar existed; they keep working (their run context is
  // {targetId}, not a message snapshot) and follow the overflow placement —
  // or the merged 'all' row.
  const contextMenuItems = usePluginRegistrations('contextMenuItems').filter(
    (action) => action.definition.context === 'message',
  );
  const byOrderAndRegistrationId = (
    left: PluginUiRegistration,
    right: PluginUiRegistration,
  ): number =>
    (left.definition.order ?? DEFAULT_ACTION_ORDER) -
      (right.definition.order ?? DEFAULT_ACTION_ORDER) ||
    left.registrationId.localeCompare(right.registrationId);
  const registrationsForPlacement =
    placement === 'all'
      ? registrations
      : registrations.filter((action) => (action.definition.placement ?? 'primary') === placement);
  const actions = [...registrationsForPlacement].sort(byOrderAndRegistrationId);
  const overflowContextMenuItems =
    placement === 'all' || placement === 'overflow' ? contextMenuItems : [];
  // 'all' interleaves legacy context-menu items with the merged bar actions
  // under one sort; 'primary'/'overflow' keep their historical grouping.
  const allActions =
    placement === 'all'
      ? [...actions, ...overflowContextMenuItems].sort(byOrderAndRegistrationId)
      : [...actions, ...overflowContextMenuItems];
  const [running, setRunning] = useState<string | null>(null);
  // Live per-action controllers: aborted on unmount and when the same action
  // is re-invoked (a new invocation replaces the old one).
  const controllersRef = useRef(new Map<string, AbortController>());

  useEffect(
    () => () => {
      for (const controller of controllersRef.current.values()) controller.abort();
      controllersRef.current.clear();
    },
    [],
  );

  if (allActions.length === 0) return null;

  const runAction = (action: PluginUiRegistration): void => {
    const controller = new AbortController();
    const previous = controllersRef.current.get(action.registrationId);
    if (previous) previous.abort();
    controllersRef.current.set(action.registrationId, controller);
    setRunning(action.registrationId);
    onRunningChange?.(action.registrationId);
    onInvoked?.();
    // Legacy context menu items receive {targetId}; message actions receive
    // the immutable snapshot (content gated per-plugin by chat.read).
    const isContextMenuItem = action.kind === 'contextMenuItems';
    const snapshot: MessageActionSnapshot = {
      messageId: message.id,
      chatId: message.chatId,
      branchId,
      role: message.role,
      content: hasChatRead(action) ? message.content : null,
      name: message.name,
      meta: message.meta,
      revision: message.revision,
    };
    const context = isContextMenuItem
      ? { targetId: message.id }
      : {
          message: snapshot,
          messageId: message.id,
          chatId: message.chatId,
          // Kernel-path abort key; harmless on the v2 postMessage path (the
          // runtime generates its own invocationId there).
          invocationId: `${action.pluginId}:${randomToken(10)}`,
        };
    void frontendPluginRuntime
      .invoke(action, context, undefined, controller.signal)
      .catch((error: unknown) => {
        // A failing plugin action must never break the chat UI.
        console.error(
          `Plugin action ${action.pluginName}:${action.definition.title} failed`,
          error,
        );
      })
      .finally(() => {
        if (controllersRef.current.get(action.registrationId) === controller) {
          controllersRef.current.delete(action.registrationId);
        }
        setRunning((current) => (current === action.registrationId ? null : current));
        onRunningChange?.(null);
      });
  };

  const hasChatRead = (action: PluginUiRegistration): boolean =>
    frontendPluginRuntime.hasPermission(action.pluginId, 'chat.read');

  return (
    <div
      className={styles.actions}
      data-component="plugin-message-actions"
      data-variant={variant}
      data-part="plugin-message-actions"
    >
      {allActions.map((action) => {
        const title = action.definition.title;
        const IconComponent =
          MESSAGE_ACTION_ICONS[action.definition.icon ?? ''] ?? DEFAULT_ACTION_ICON;
        return (
          <button
            key={action.registrationId}
            type="button"
            disabled={running === action.registrationId}
            data-action-id={action.registrationId}
            title={`${action.pluginName}: ${title}`}
            aria-label={title}
            onClick={() => runAction(action)}
          >
            <IconComponent aria-hidden="true" />
            {variant === 'list' ? <span className={styles.label}>{title}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
