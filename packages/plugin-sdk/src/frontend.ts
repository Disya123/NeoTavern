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
