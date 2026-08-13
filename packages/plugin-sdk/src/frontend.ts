/**
 * Frontend Plugin SDK (ТЗ §7.2).
 *
 * Plugins depend on this stable, versioned surface — never on React, Zustand,
 * TanStack Query or internal components directly (AGENTS.md §17). The host
 * (apps/web) supplies the concrete implementation of {@link FrontendPluginApi};
 * every registration returns a cleanup function.
 *
 * UI mount points are typed as `unknown` so this package stays
 * framework-agnostic (no React/DOM dependency); the host casts to the real
 * container type.
 */
import type { MessageRole } from '@neotavern/contracts';
import type { PluginEventBus } from './events.js';

/** A registration handle: call to undo the registration. */
export type Unregister = () => void;

export interface Registrar<TDef> {
  register(definition: TDef): Unregister;
}

/**
 * Immutable message snapshot passed to message actions.
 *
 * `content` is `null` unless the plugin also holds the `chat.read`
 * permission — the host gates message content per plugin, so actions can
 * render metadata (role, revision, meta) without ever seeing the text.
 */
export interface MessageActionSnapshot {
  messageId: string;
  chatId: string;
  /** Id of the chat branch the message belongs to (`null` when unknown). */
  branchId: string | null;
  /** Message role: 'user' | 'assistant' | 'system' | 'tool'. */
  role: string;
  /** Message text, or `null` when the plugin lacks `chat.read`. */
  content: string | null;
  /** Optional author/character name shown on the message. */
  name: string | null;
  /** Message metadata (context exclusions, flags, plugin extras). */
  meta: Record<string, unknown>;
  /** Message revision; bumped on every edit/swipe/regenerate. */
  revision: number;
}

export interface MessageActionDef {
  id: string;
  title: string | (() => string);
  /**
   * Semantic icon name. The host maps known names to its icon set;
   * unknown names fall back to the generic puzzle-piece icon.
   */
  icon?: string;
  /** Lower renders first. Default 100. */
  order?: number;
  /** 'primary' → the message action bar; 'overflow' → the «More» menu. Default 'primary'. */
  placement?: 'primary' | 'overflow';
  run(context: {
    /** Message snapshot; `content` is null without `chat.read`. */
    message: Readonly<MessageActionSnapshot>;
    /** Kept top-level for backward compatibility. */
    messageId: string;
    /** Kept top-level for backward compatibility. */
    chatId: string;
    /**
     * Aborts when the host tears the action down (unmount, navigation,
     * plugin disable), when the action is re-invoked, or on timeout.
     */
    signal: AbortSignal;
  }): void | Promise<void>;
}

export interface ToolbarActionDef {
  id: string;
  title: string | (() => string);
  icon?: string;
  run(): void | Promise<void>;
}

export interface PageDef {
  id: string;
  /** Route path under the plugin namespace. */
  path: string;
  title: string | (() => string);
  /** Mount the page UI into the host-provided container; return a teardown. */
  mount(container: unknown): void | (() => void);
}

export interface SettingsPanelDef {
  id: string;
  title: string | (() => string);
  mount(container: unknown): void | (() => void);
}

export interface SidebarPanelDef {
  id: string;
  title: string | (() => string);
  slot: 'left' | 'right';
  mount(container: unknown): void | (() => void);
}

export interface ContextMenuItemDef {
  id: string;
  title: string | (() => string);
  context: 'message' | 'character';
  run(context: { targetId: string }): void | Promise<void>;
}

export interface MessageRendererDef {
  id: string;
  title: string | (() => string);
  render(context: {
    messageId: string;
    chatId: string;
    role: string;
    content: string;
  }):
    | { text: string; placement?: 'replace' | 'after' }
    | Promise<{ text: string; placement?: 'replace' | 'after' }>;
}

export interface CharacterTabDef {
  id: string;
  title: string | (() => string);
  mount(container: unknown, context: { characterId: string }): void | (() => void);
}

export interface DialogDef {
  id: string;
  title: string | (() => string);
  description?: string;
  mount(container: unknown): void | (() => void);
}

export interface SlashCommandDef {
  name: string;
  description: string;
  run(args: string): void | Promise<void>;
}

export interface CommandPaletteDef {
  id: string;
  title: string | (() => string);
  run(): void | Promise<void>;
}

export interface HotkeyDef {
  id: string;
  /** e.g. "mod+shift+k". */
  combo: string;
  run(): void | Promise<void>;
}

export interface NotificationDef {
  title: string;
  description?: string;
  variant?: 'info' | 'success' | 'warning' | 'error';
  timeoutMs?: number;
}

/** Prompt interceptor registered by a plugin (ТЗ §4.4). */
export interface PromptInterceptorDef {
  id: string;
  /** Lower priority runs earlier. Default 100. */
  priority?: number;
  /** Max time before the interceptor is skipped. */
  timeoutMs?: number;
  intercept(
    context: PromptInterceptorContext,
  ): PromptInterceptorContext | Promise<PromptInterceptorContext>;
}

export interface PromptInterceptorContext {
  chatId: string;
  messages: Array<{
    /** Stable host block id. Preserve it when editing an existing message. */
    id?: string;
    role: MessageRole;
    content: string;
    name?: string | null;
  }>;
  /** Arbitrary metadata plugins may read/attach (prompt.inspect/modify). */
  meta: Record<string, unknown>;
}

// ── Declarative semantic UI slots (ТЗ §53) ───────────────────────────────────

/**
 * Stable semantic slot ids rendered declaratively by the host. These ids are
 * a frozen cross-agent contract — plugins must not invent new ones.
 */
export const SLOT_IDS = [
  'chat.header.actions',
  'chat.message.actions',
  'character.editor.actions',
  'settings.section',
  'generation.controls',
] as const;

export type SlotId = (typeof SLOT_IDS)[number];

/** True when `value` is one of the stable semantic slot ids. */
export function isSlotId(value: unknown): value is SlotId {
  return typeof value === 'string' && (SLOT_IDS as readonly string[]).includes(value);
}

/**
 * What a slot contribution does when the host renders it. Commands dispatch
 * through the plugin's command registration (`commandId` matches the command
 * `id`); events are emitted on the shared event bus.
 */
export type SlotAction = { type: 'command'; commandId: string } | { type: 'event'; event: string };

/**
 * A declarative contribution to a semantic UI slot (ТЗ §53). The host renders
 * a button; plugins provide semantics only — never layout or markup.
 */
export interface SlotContribution {
  /** One of the stable slot ids. */
  slot: SlotId;
  /** Button label: non-empty, ≤80 characters, no control characters. */
  title: string;
  /** Lower renders first. Default 100. */
  priority?: number;
  /**
   * When set, the button renders only while the plugin holds this v2
   * permission (e.g. `chat.read`) — same gate the host applies to
   * registrations.
   */
  permission?: string;
  /** What the button does when clicked. */
  action: SlotAction;
  /**
   * Optional runtime gate; the button is hidden when it returns `false`.
   */
  when?: () => boolean;
}

/**
 * Declarative slot surface on {@link FrontendPluginApi.ui}. Unlike the
 * imperative registrars there is no `register`/`run` shape: contributions are
 * pure data plus an action descriptor, so the host can re-validate everything
 * at the untrusted boundary and render without ever running plugin code in
 * the main window.
 */
export interface SlotUiApi {
  /**
   * Register a slot contribution. Validates the definition (unknown slot id,
   * title rules) and throws a {@link SlotContributionError} on violation.
   * Returns a cleanup function.
   */
  contribute(def: SlotContribution): Unregister;
  /** Read-only snapshot of the host's current contributions for a slot. */
  list(slotId: SlotId): readonly SlotContribution[];
}

/** Stable machine-readable codes for slot-contribution validation failures. */
export type SlotContributionErrorCode = 'SLOT_UNKNOWN' | 'SLOT_TITLE_INVALID' | 'SLOT_INVALID';

/**
 * Typed validation error for slot contributions (AGENTS.md §5): stable
 * `code` plus structured `params`, never a ready-made human string.
 */
export class SlotContributionError extends Error {
  readonly code: SlotContributionErrorCode;
  readonly params: Record<string, unknown>;

  constructor(code: SlotContributionErrorCode, params: Record<string, unknown>) {
    super(`slot contribution rejected: ${code}`);
    this.name = 'SlotContributionError';
    this.code = code;
    this.params = params;
  }
}

const MAX_SLOT_TITLE_LENGTH = 80;
const MAX_SLOT_PERMISSION_LENGTH = 128;
const MAX_SLOT_ACTION_ID_LENGTH = 160;
const MAX_SLOT_EVENT_LENGTH = 200;
// eslint-disable-next-line no-control-regex -- title validation needs the C0/C1 range; the constructor form below avoids the literal-regex lint
const SLOT_CONTROL_CHARACTER_RE = new RegExp('[\u0000-\u001f\u007f]', 'u');

/**
 * Validate a slot contribution at the untrusted boundary. `contribute()` and
 * the host registry both apply these rules; returns a normalized copy or
 * throws {@link SlotContributionError} with a stable code:
 *
 * - `SLOT_UNKNOWN` — `slot` is not one of {@link SLOT_IDS}
 * - `SLOT_TITLE_INVALID` — `title` is missing/empty, longer than 80 chars, or
 *   contains control characters
 * - `SLOT_INVALID` — any other structural violation (priority, permission,
 *   action, `when`)
 */
export function validateSlotContribution(def: unknown): SlotContribution {
  if (typeof def !== 'object' || def === null || Array.isArray(def)) {
    throw new SlotContributionError('SLOT_INVALID', { reason: 'shape' });
  }
  const record = def as Record<string, unknown>;

  const slot = record['slot'];
  if (!isSlotId(slot)) {
    throw new SlotContributionError('SLOT_UNKNOWN', { slot });
  }

  const title = record['title'];
  if (typeof title !== 'string' || title.length === 0) {
    throw new SlotContributionError('SLOT_TITLE_INVALID', { reason: 'empty' });
  }
  if (title.length > MAX_SLOT_TITLE_LENGTH) {
    throw new SlotContributionError('SLOT_TITLE_INVALID', {
      reason: 'too-long',
      maxLength: MAX_SLOT_TITLE_LENGTH,
    });
  }
  if (SLOT_CONTROL_CHARACTER_RE.test(title)) {
    throw new SlotContributionError('SLOT_TITLE_INVALID', { reason: 'control-characters' });
  }

  const priority = record['priority'];
  if (
    priority !== undefined &&
    (typeof priority !== 'number' || !Number.isSafeInteger(priority) || priority < 0)
  ) {
    throw new SlotContributionError('SLOT_INVALID', { reason: 'priority' });
  }

  const permission = record['permission'];
  if (
    permission !== undefined &&
    (typeof permission !== 'string' ||
      permission.length === 0 ||
      permission.length > MAX_SLOT_PERMISSION_LENGTH)
  ) {
    throw new SlotContributionError('SLOT_INVALID', { reason: 'permission' });
  }

  const action = record['action'];
  if (typeof action !== 'object' || action === null) {
    throw new SlotContributionError('SLOT_INVALID', { reason: 'action' });
  }
  const actionRecord = action as Record<string, unknown>;
  if (actionRecord['type'] === 'command') {
    const commandId = actionRecord['commandId'];
    if (
      typeof commandId !== 'string' ||
      commandId.length === 0 ||
      commandId.length > MAX_SLOT_ACTION_ID_LENGTH
    ) {
      throw new SlotContributionError('SLOT_INVALID', { reason: 'action-commandId' });
    }
  } else if (actionRecord['type'] === 'event') {
    const event = actionRecord['event'];
    if (typeof event !== 'string' || event.length === 0 || event.length > MAX_SLOT_EVENT_LENGTH) {
      throw new SlotContributionError('SLOT_INVALID', { reason: 'action-event' });
    }
  } else {
    throw new SlotContributionError('SLOT_INVALID', { reason: 'action-type' });
  }

  const when = record['when'];
  if (when !== undefined && typeof when !== 'function') {
    throw new SlotContributionError('SLOT_INVALID', { reason: 'when' });
  }

  const validated: SlotContribution = {
    slot,
    title,
    action: actionRecord as SlotAction,
    ...(priority === undefined ? {} : { priority }),
    ...(permission === undefined ? {} : { permission }),
    ...(when === undefined ? {} : { when: when as () => boolean }),
  };
  return validated;
}

export interface PluginI18nApi {
  /** Add translation resources under an isolated plugin namespace. */
  addResources(language: string, resources: Record<string, unknown>): Unregister;
  t(key: string, options?: Record<string, unknown>): string;
}

/** The API object handed to a plugin's `activate()`. */
export interface FrontendPluginApi {
  readonly pluginId: string;
  readonly events: PluginEventBus;
  readonly i18n: PluginI18nApi;
  readonly ui: {
    messageActions: Registrar<MessageActionDef>;
    toolbarActions: Registrar<ToolbarActionDef>;
    pages: Registrar<PageDef>;
    settingsPanels: Registrar<SettingsPanelDef>;
    sidebarPanels: Registrar<SidebarPanelDef>;
    contextMenuItems: Registrar<ContextMenuItemDef>;
    messageRenderers: Registrar<MessageRendererDef>;
    characterTabs: Registrar<CharacterTabDef>;
    dialogs: Registrar<DialogDef>;
    commands: Registrar<CommandPaletteDef>;
    hotkeys: Registrar<HotkeyDef>;
    /** Declarative semantic UI slots (ТЗ §53). */
    slots: SlotUiApi;
  };
  readonly slash: Registrar<SlashCommandDef>;
  readonly interceptors: Registrar<PromptInterceptorDef>;
  /** Show a notification; returns a function to dismiss it early. */
  notify(notification: NotificationDef): Unregister;
}

/** A frontend plugin definition. */
export interface PluginDefinition {
  activate(api: FrontendPluginApi): void | Promise<void>;
  /** Optional explicit teardown (in addition to returned cleanups). */
  deactivate?(): void | Promise<void>;
}

/**
 * Identity helper for authoring plugins with full typing:
 * ```ts
 * export default definePlugin({ activate(api) { ... } });
 * ```
 */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}
