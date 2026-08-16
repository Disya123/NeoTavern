/**
 * Shared built-in message actions (C2): the single source of truth for the
 * action id order, availability rules, labels and icons used by both the
 * desktop inline action bar (MessageBubble) and the mobile
 * MessageDetailsCard.
 *
 * Action ids double as DOM `data-action` hooks (documented in docs/ux) so the
 * desktop and mobile surfaces expose identical ids for the same action.
 */
import {
  ArrowCounterClockwise,
  ArrowUUpLeft,
  ClockCounterClockwise,
  Copy,
  Eye,
  EyeSlash,
  Flag,
  FlagCheckered,
  GitBranch,
  ListChecks,
  PencilSimple,
  TextAlignLeft,
  Trash,
  type Icon,
} from '@phosphor-icons/react';
import type { TFunction } from 'i18next';
import type { Message } from '@neotavern/contracts';

/** Canonical render order of the built-in actions (desktop inline row). */
export const BUILTIN_MESSAGE_ACTION_ORDER = [
  'context',
  'edit',
  'copy',
  'regenerate',
  'history',
  'checkpoint',
  'branch',
  'delete-checkpoint',
  'delete',
  'rollback',
] as const;

export type BuiltinMessageActionId =
  (typeof BUILTIN_MESSAGE_ACTION_ORDER)[number] | 'prompt' | 'steps';

/**
 * `prompt` / `steps` are not part of the canonical action order — they never
 * appear in the inline/menu action rows. They exist only as typed footer
 * actions in the message details card, shown for messages that carry a
 * durable generation run (`message.generationRunId`) so the user can open
 * the prompt plan (ТЗ §9.2) or the run-step transcript (ТЗ §8.3).
 */

/** Which built-in actions the current message context exposes. */
export interface MessageActionCaps {
  context: boolean;
  edit: boolean;
  copy: boolean;
  regenerate: boolean;
  history: boolean;
  branch: boolean;
  /** Message already carries a checkpoint flag → open it. */
  checkpointOpen: boolean;
  /** Message has no checkpoint flag yet → create one. */
  checkpointCreate: boolean;
  deleteCheckpoint: boolean;
  delete: boolean;
  /** Roll the whole chat back to this message (kernel `chats.snapshots.rollback`). */
  rollback: boolean;
}

/**
 * Filter {@link BUILTIN_MESSAGE_ACTION_ORDER} down to the actions available
 * for this message. The `checkpoint` id appears at most once: it stands for
 * "open checkpoint" when {@link Message.checkpointChatId} is set, otherwise
 * for "create checkpoint".
 */
export function getAvailableBuiltinActions(
  message: Message,
  caps: MessageActionCaps,
  canRegenerate: boolean,
): BuiltinMessageActionId[] {
  return BUILTIN_MESSAGE_ACTION_ORDER.filter((id) => {
    switch (id) {
      case 'context':
        return caps.context;
      case 'edit':
        return caps.edit;
      case 'copy':
        return caps.copy;
      case 'regenerate':
        return caps.regenerate && canRegenerate;
      case 'history':
        return caps.history;
      case 'branch':
        return caps.branch;
      case 'checkpoint':
        return message.checkpointChatId ? caps.checkpointOpen : caps.checkpointCreate;
      case 'delete-checkpoint':
        return caps.deleteCheckpoint && message.checkpointChatId !== null;
      case 'delete':
        return caps.delete;
      case 'rollback':
        return caps.rollback;
    }
  });
}

/**
 * Base label per action id. Two labels depend on message state and are
 * resolved by the caller (they need the message, which this helper cannot
 * see): `context` — exclude vs include (`message.meta['manualExcluded']`),
 * and `checkpoint` — open vs create (`message.checkpointChatId`).
 */
export function getBuiltinActionLabels(t: TFunction): Record<BuiltinMessageActionId, string> {
  return {
    context: t('chat:excludeFromContext'),
    edit: t('chat:editMessage'),
    copy: t('chat:copyMessage'),
    regenerate: t('chat:regenerate'),
    history: t('chat:revisionHistory'),
    checkpoint: t('chat:checkpoint'),
    branch: t('chat:branch'),
    'delete-checkpoint': t('chat:deleteCheckpoint'),
    delete: t('chat:deleteMessage'),
    rollback: t('chat:rollbackToHere'),
    prompt: t('chat:viewPromptPlan'),
    steps: t('chat:runTranscriptOpen'),
  };
}

/**
 * Icon per action id. The checkpoint icon is `Flag` in both states; renderers
 * use `weight="fill"` when the message has an openable checkpoint.
 */
export const BUILTIN_ACTION_ICONS: Record<BuiltinMessageActionId, Icon> = {
  context: Eye,
  edit: PencilSimple,
  copy: Copy,
  regenerate: ArrowCounterClockwise,
  history: ClockCounterClockwise,
  checkpoint: Flag,
  branch: GitBranch,
  'delete-checkpoint': FlagCheckered,
  delete: Trash,
  rollback: ArrowUUpLeft,
  prompt: TextAlignLeft,
  steps: ListChecks,
};

/**
 * Message-aware icon resolver. `context` toggles between the include eye
 * (message excluded from context → the action re-includes it) and the
 * exclude eye-slash (message included → the action excludes it); every other
 * id falls back to {@link BUILTIN_ACTION_ICONS}.
 */
export function getBuiltinActionIcon(message: Message, id: BuiltinMessageActionId): Icon {
  if (id === 'context') {
    return message.meta['manualExcluded'] === true ? Eye : EyeSlash;
  }
  return BUILTIN_ACTION_ICONS[id];
}
