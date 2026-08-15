/**
 * Chat view: message viewport (old messages loaded in batches) + composer with
 * streaming generation. Token deltas are buffered and flushed to React at most
 * ~30 times/second via requestAnimationFrame throttling (AGENTS.md §13).
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowCounterClockwise, ChatCircleDots } from '@phosphor-icons/react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import { Button, ErrorBoundary, Skeleton } from '@neotavern/ui';
import type { ChatSnapshotResult, Message } from '@neotavern/contracts';
import { findLegacySlashCommand, hasLegacyPromptInterceptors } from '@neotavern/legacy-compat';
import {
  useCharacter,
  useChat,
  useMessages,
  useMessageVariants,
  useSettings,
} from '../api/hooks.js';
import { streamGeneration } from '../api/generate.js';
import { backend } from '../api/backend.js';
import {
  createChatSnapshot,
  swipeMessageToPosition,
  updateChatMessage,
  wallpaperBackgroundUrl,
} from '../api/wireBridge.js';
import { clampSwipeIndex, readGreetingSwipes } from '@neotavern/shared';
import { expandDisplayMacros, useMacroContext, type MacroContext } from '../lib/macros.js';
import { useErrorText } from '../lib/useErrorText.js';
import { useConversationContextPreview } from '../lib/useConversationContextPreview.js';
import { ChatComposer } from '../components/ChatComposer.js';
import { ChatHeader } from '../components/ChatHeader.js';
import { ChatWorkspace } from '../components/ChatWorkspace.js';
import workspaceStyles from '../components/ChatWorkspace.module.css';
import { ContextUsagePanel } from '../components/ContextUsagePanel.js';
import { MessageBubble } from '../components/MessageBubble.js';
import { frontendPluginRuntime, usePluginRegistrations } from '../plugins/runtime.js';
import { useUiStore } from '../state/ui.js';
import styles from './ChatPage.module.css';

const FLUSH_INTERVAL_MS = 33; // ~30 UI updates per second max

export function ChatPage() {
  const { chatId } = useParams<{ chatId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const settings = useSettings();
  const slashCommands = usePluginRegistrations('slash');
  const promptInterceptors = usePluginRegistrations('interceptors');
  const openSidebarPanel = useUiStore((state) => state.openSidebarPanel);
  const draftScope = `chat:${chatId ?? 'unknown'}`;
  const input = useUiStore((state) => state.drafts[draftScope] ?? '');
  const setSessionDraft = useUiStore((state) => state.setDraft);

  const chat = useChat(chatId);
  const character = useCharacter(chat.data?.characterId ?? undefined);
  const messages = useMessages(chatId, chat.data?.activeBranchId ?? undefined);
  const macroContext = useMacroContext({
    charName: character.data?.name,
    personaId: chat.data?.personaId,
  });

  const [isGenerating, setIsGenerating] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [editErrorId, setEditErrorId] = useState<string | null>(null);
  const [editErrorText, setEditErrorText] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  // Optimistic copy of the user message being generated: rendered instantly
  // on send, dropped when a refetch confirms the server-persisted original.
  const [pendingUserMessage, setPendingUserMessage] = useState<{
    content: string;
    confirmedUserCount: number;
  } | null>(null);

  const bufferRef = useRef('');
  const rafRef = useRef<number | null>(null);
  const lastFlushRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const initialMessageHandledRef = useRef(false);

  // Messages arrive newest-first; reverse for display (oldest at top).
  // Memoized: the ChatPage body re-renders ~30 times/second while streaming,
  // and the list must not be rebuilt on every flush (OTHER-60).
  const ordered = useMemo<Message[]>(
    () => (messages.data?.pages.flatMap((page) => page.items) ?? []).slice().reverse(),
    [messages.data],
  );
  // Live mirror for memoized handlers that need the current revision (the
  // message list refetches after every write; the handlers stay referentially
  // stable so memoized rows do not re-render).
  const orderedRef = useRef<Message[]>([]);
  orderedRef.current = ordered;
  // At most one send is in flight (`isGenerating` gates concurrent sends), so
  // the confirmed message is identifiable by position + content.
  useEffect(() => {
    if (!pendingUserMessage) return;
    const users = ordered.filter((message) => message.role === 'user');
    const lastUser = users.at(-1);
    if (
      users.length > pendingUserMessage.confirmedUserCount &&
      lastUser?.content === pendingUserMessage.content
    ) {
      setPendingUserMessage(null);
    }
  }, [ordered, pendingUserMessage]);
  const {
    contextUsage,
    preview: contextPreview,
    isLoading: contextPanelLoading,
    isError: contextPreviewError,
    triggerPending: contextTriggerPending,
  } = useConversationContextPreview({
    source:
      chatId && chat.data && messages.data
        ? {
            chatId,
            messages: ordered,
            historyVersion: messages.dataUpdatedAt,
          }
        : undefined,
    draft: input,
  });

  // Virtualized viewport: only visible bubbles (plus overscan) are mounted.
  const viewportRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: ordered.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => 132,
    overscan: 8,
    getItemKey: (index) => ordered[index]?.id ?? `index-${index}`,
  });

  // Sticky auto-scroll: follow new content only while the user is at (or near)
  // the bottom — reading history must not be yanked away mid-stream.
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onScroll = (): void => {
      stickToBottomRef.current =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 120;
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', onScroll);
  }, []);
  const prevChatIdRef = useRef<string | null>(null);
  const prevTotalSizeRef = useRef(0);
  // Pin-to-bottom whenever the conversation, its data, or the stream changes.
  // Targets the ABSOLUTE bottom of the scroll container: the composer is a
  // sticky child of the viewport, so scrollIntoView(endRef, {block:'end'})
  // would park the newest content behind the floating composer and re-yank
  // any manual scroll on every flush. Identity (not length) of `ordered` is
  // a dep so cache-hit chat switches with equal message counts still re-pin.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const chatChanged = chatId !== prevChatIdRef.current;
    prevChatIdRef.current = chatId ?? null;
    if (chatChanged) {
      // A different conversation always starts pinned to the newest message.
      stickToBottomRef.current = true;
      prevTotalSizeRef.current = 0;
    }
    if (stickToBottomRef.current && ordered.length > 0) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [chatId, ordered, streamingText, isGenerating]);
  useEffect(() => {
    // rev4 §A5: plugins resolve "current chat" through the runtime singleton.
    frontendPluginRuntime.setCurrentChatId(chatId ?? null);
    return () => frontendPluginRuntime.setCurrentChatId(null);
  }, [chatId]);
  useEffect(() => {
    // Host checkpoint/branch notifications carry an action button that
    // navigates into the fresh child chat.
    const onOpenChildChat = (event: Event): void => {
      const detail = (event as CustomEvent<{ chatId?: unknown }>).detail;
      const target = typeof detail?.chatId === 'string' ? detail.chatId : null;
      if (target) navigate(`/chats/${target}`);
    };
    window.addEventListener('neotavern-open-child-chat', onOpenChildChat);
    return () => window.removeEventListener('neotavern-open-child-chat', onOpenChildChat);
  }, [navigate]);

  // Loading older pages prepends rows at the top: keep the reading position
  // stable instead of jumping to the new start. While pinned to the bottom,
  // follow total growth (measured row heights) so the newest message stays in
  // view. Direct scrollTop assignment is instant regardless of CSS
  // `scroll-behavior: smooth`, so it cannot be cancelled mid-animation.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const total = virtualizer.getTotalSize();
    const delta = total - prevTotalSizeRef.current;
    prevTotalSizeRef.current = total;
    if (!viewport || delta <= 0) return;
    if (stickToBottomRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
    } else {
      viewport.scrollTop += delta;
    }
  });

  const searchableTexts = useMemo(
    () => ordered.map((message) => expandDisplayMacros(message.content, macroContext)),
    [ordered, macroContext],
  );

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      abortRef.current?.abort();
    };
  }, []);

  // Legacy `getContext().generate()` triggers a regeneration cycle (ТЗ §8.1).
  // The listener is registered once; the current send() is reached through a
  // ref so streaming re-renders do not re-subscribe ~30 times/second (OTHER-60).
  const sendRef = useRef<(messageOverride?: string, regenerate?: boolean) => Promise<void>>(
    async () => undefined,
  );
  useEffect(() => {
    const onLegacyGenerate = (): void => {
      void sendRef.current(undefined, true);
    };
    globalThis.addEventListener('neotavern-legacy-generate', onLegacyGenerate);
    return () => globalThis.removeEventListener('neotavern-legacy-generate', onLegacyGenerate);
  }, []);

  const scheduleFlush = (): void => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame((timestamp) => {
      rafRef.current = null;
      if (timestamp - lastFlushRef.current >= FLUSH_INTERVAL_MS) {
        lastFlushRef.current = timestamp;
        setStreamingText(bufferRef.current);
      } else {
        scheduleFlush();
      }
    });
  };

  /**
   * Drop any pending frame flush. Must run whenever streaming ends (done,
   * error, stop): a rAF armed by the last delta would otherwise fire after
   * the buffer was cleared and re-mount a ghost of the finished reply.
   */
  const cancelFlush = (): void => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const send = async (messageOverride?: string, regenerate = false): Promise<void> => {
    const text = (messageOverride ?? input).trim();
    if (!chatId || (text.length === 0 && !regenerate) || isGenerating) return;
    if (!regenerate && text.startsWith('/')) {
      const parsed = /^\/([^\s]+)(?:\s+(.*))?$/u.exec(text);
      const commandName = parsed?.[1] ?? '';
      const command = slashCommands.find(
        (item) => item.definition.id.toLowerCase() === commandName.toLowerCase(),
      );
      if (command) {
        setSessionDraft(draftScope, '');
        setError(null);
        try {
          await frontendPluginRuntime.invoke(command, parsed?.[2] ?? '');
        } catch (error) {
          setError(errorText(error));
        }
        return;
      }
      // Legacy extensions register slash commands through the compat bridge
      // (ТЗ §8.1); they run trusted in the main window.
      const legacyCommand = findLegacySlashCommand(commandName);
      if (legacyCommand) {
        setSessionDraft(draftScope, '');
        setError(null);
        try {
          await legacyCommand.handler(parsed?.[2] ?? '');
        } catch (error) {
          setError(errorText(error));
        }
        return;
      }
      setError(t('plugins:slashNotFound', { command: commandName || text }));
      return;
    }
    if (!regenerate) setSessionDraft(draftScope, '');
    setError(null);
    setIsGenerating(true);
    if (!regenerate) {
      setPendingUserMessage({
        content: text,
        confirmedUserCount: orderedRef.current.filter((m) => m.role === 'user').length,
      });
    }
    // Regeneration rewrites the last assistant message in place; the server
    // archives the old text as a variant only when the new one completes.
    const regenerateTarget = regenerate ? (orderedRef.current.at(-1) ?? null) : null;
    setRegeneratingId(regenerateTarget ? regenerateTarget.id : null);
    stickToBottomRef.current = true;
    bufferRef.current = '';
    lastFlushRef.current = 0;
    setStreamingText('');

    // The server persists the user message before streaming; refresh to show it.
    void queryClient.invalidateQueries({ queryKey: ['messages', chatId] });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamGeneration(
        chatId,
        {
          userMessage: regenerate ? undefined : text,
          regenerate,
          ...(regenerateTarget ? { regenerateMessageId: regenerateTarget.id } : {}),
          providerConfigId: settings.data?.activeProviderConfigId ?? undefined,
          frontendInterceptors: promptInterceptors.length > 0 || hasLegacyPromptInterceptors(),
        },
        {
          onStart: () => {
            frontendPluginRuntime.emitEvent('generation.started', { chatId });
            // The server persists the user message before streaming; the
            // refetch confirms it so the optimistic bubble can be dropped.
            void queryClient.invalidateQueries({ queryKey: ['messages', chatId] });
          },
          onDelta: (delta) => {
            bufferRef.current += delta;
            scheduleFlush();
            frontendPluginRuntime.emitEvent('generation.delta', { chatId, text: delta });
          },
          onDone: (fullText) => {
            cancelFlush();
            bufferRef.current = '';
            setStreamingText('');
            setIsGenerating(false);
            setRegeneratingId(null);
            setPendingUserMessage(null);
            frontendPluginRuntime.emitEvent('generation.finished', {
              chatId,
              text: fullText,
            });
            void queryClient.invalidateQueries({ queryKey: ['messages', chatId] });
            void queryClient.invalidateQueries({ queryKey: ['chats'] });
            void queryClient.invalidateQueries({ queryKey: ['prompt-context-audit', chatId] });
          },
          onError: (code, message) => {
            cancelFlush();
            bufferRef.current = '';
            setStreamingText('');
            setIsGenerating(false);
            setRegeneratingId(null);
            setPendingUserMessage(null);
            setError(`${code}: ${message}`);
            frontendPluginRuntime.emitEvent('generation.error', { chatId, code });
            // The user message is persisted server-side before streaming; a
            // send-time refetch can miss it, so re-sync after a failure too.
            void queryClient.invalidateQueries({ queryKey: ['messages', chatId] });
            void queryClient.invalidateQueries({ queryKey: ['prompt-context-audit', chatId] });
          },
        },
        controller.signal,
      );
    } catch (err) {
      cancelFlush();
      bufferRef.current = '';
      setStreamingText('');
      setIsGenerating(false);
      setRegeneratingId(null);
      setPendingUserMessage(null);
      setError(errorText(err));
      void queryClient.invalidateQueries({ queryKey: ['messages', chatId] });
      void queryClient.invalidateQueries({ queryKey: ['prompt-context-audit', chatId] });
    }
  };

  sendRef.current = send;

  const stop = (): void => {
    abortRef.current?.abort();
    cancelFlush();
    bufferRef.current = '';
    setIsGenerating(false);
    setStreamingText('');
    setRegeneratingId(null);
    setPendingUserMessage(null);
    // The user message is persisted server-side before streaming; a send-time
    // refetch can miss it, so re-sync after an abort too.
    void queryClient.invalidateQueries({ queryKey: ['messages', chatId] });
  };

  const lastMessage = ordered.at(-1);

  const canRegenerate =
    lastMessage?.role === 'assistant' && !isGenerating && regeneratingId === null;

  // Stable row handler: regeneration starts through sendRef so the memoized
  // rows never see a changing callback during streaming flushes.
  const regenerateLast = useCallback(() => {
    void sendRef.current(undefined, true);
  }, []);

  const clearDraft = (): void => {
    setSessionDraft(draftScope, '');
    inputRef.current?.focus();
  };

  // Message handlers are stabilized so memoized rows do not re-render on the
  // streaming flush cycle (their props must stay referentially equal).
  const saveMessageEdit = useCallback(
    async (messageId: string, content: string): Promise<void> => {
      if (!chatId) return;
      setError(null);
      setEditErrorId(null);
      setEditErrorText(null);
      try {
        // Product Wire `chats.messages.update` (Этап 2.10): canonical on the
        // kernel, bridged to the legacy PATCH route on the sidecar. The wire
        // contract is content-only — the legacy `expectedRevision` CAS is a
        // legacy-only feature (kernel updates are last-write-wins; see
        // docs/architecture/operations-inventory.md).
        await backend.chats.updateMessage({ chatId, messageId, content });
        await queryClient.invalidateQueries({ queryKey: ['messages', chatId] });
        await queryClient.invalidateQueries({ queryKey: ['chats'] });
      } catch (err) {
        setError(errorText(err));
        throw err;
      }
    },
    [chatId, queryClient, errorText],
  );

  const deleteMessage = useCallback(
    async (messageId: string): Promise<void> => {
      if (!chatId) return;
      setError(null);
      try {
        // Product Wire `chats.messages.delete` (Этап 2.10).
        await backend.chats.delMessage({ chatId, messageId });
        await queryClient.invalidateQueries({ queryKey: ['messages', chatId] });
        await queryClient.invalidateQueries({ queryKey: ['chats'] });
      } catch (err) {
        setError(errorText(err));
        throw err;
      }
    },
    [chatId, queryClient, errorText],
  );

  const toggleMessageContext = useCallback(
    async (message: Message): Promise<void> => {
      if (!chatId) return;
      setError(null);
      const excluded = message.meta['manualExcluded'] === true;
      try {
        await updateChatMessage(chatId, message.id, {
          meta: { ...message.meta, manualExcluded: !excluded },
        });
        await queryClient.invalidateQueries({ queryKey: ['messages', chatId] });
      } catch (err) {
        setError(errorText(err));
        throw err;
      }
    },
    [chatId, queryClient, errorText],
  );

  const swipeGreeting = useCallback(
    async (message: Message, nextIndex: number): Promise<void> => {
      if (!chatId) return;
      const greetingSwipes = readGreetingSwipes(message.meta);
      if (!greetingSwipes) return;
      const swipeId = clampSwipeIndex(nextIndex, greetingSwipes.swipes.length);
      const content = greetingSwipes.swipes[swipeId];
      if (content === undefined || swipeId === greetingSwipes.swipeId) return;
      setError(null);
      try {
        await updateChatMessage(chatId, message.id, {
          content,
          meta: {
            ...message.meta,
            greeting: true,
            swipes: greetingSwipes.swipes,
            swipeId,
          },
        });
        await queryClient.invalidateQueries({ queryKey: ['messages', chatId] });
      } catch (err) {
        setError(errorText(err));
      }
    },
    [chatId, queryClient, errorText],
  );

  const copyMessage = useCallback(
    async (message: Message): Promise<void> => {
      if (!navigator.clipboard?.writeText) return;
      try {
        await navigator.clipboard.writeText(message.content);
      } catch (err) {
        setError(errorText(err));
      }
    },
    [errorText],
  );

  /** Activate a stored variant (swipe position; wire `variants.activate`). */
  const variantSwipe = useCallback(
    async (message: Message, position: number): Promise<void> => {
      if (!chatId) return;
      // Legacy permutation guard: the message carries the variant bounds and
      // the active position; out-of-range or active-position swipes are
      // no-ops. Kernel mode messages carry 0/null (translateMessage) — the
      // position is resolved against the variants list there and anything
      // out of range resolves to null inside swipeMessageToPosition.
      if (
        position < 0 ||
        (message.activeVariantPosition !== null &&
          (position >= message.variantCount || position === message.activeVariantPosition))
      ) {
        return;
      }
      setError(null);
      try {
        const updated = await swipeMessageToPosition(chatId, message.id, position);
        if (updated !== null) {
          await queryClient.invalidateQueries({ queryKey: ['messages', chatId] });
          await queryClient.invalidateQueries({
            queryKey: ['message-variants', chatId, message.id],
          });
        }
      } catch (err) {
        setError(errorText(err));
      }
    },
    [chatId, queryClient, errorText],
  );

  /**
   * Snapshot the chat up to `message` as a checkpoint or branch child chat.
   * Notifies via the host notification layer; the notification's action
   * button navigates into the fresh child chat.
   */
  const createSnapshot = useCallback(
    async (
      message: Message,
      kind: 'checkpoint' | 'branch',
      replace: boolean,
    ): Promise<ChatSnapshotResult> => {
      if (!chatId) throw new Error('CHAT_NOT_LOADED');
      setError(null);
      const response = await createChatSnapshot(chatId, {
        messageId: message.id,
        kind,
        replace,
      });
      await queryClient.invalidateQueries({ queryKey: ['messages', chatId] });
      await queryClient.invalidateQueries({ queryKey: ['chat', chatId] });
      await queryClient.invalidateQueries({ queryKey: ['chats'] });
      window.dispatchEvent(
        new CustomEvent('neotavern-plugin-notification', {
          detail: {
            pluginId: 'host',
            registrationId: `host:snapshot:${Date.now()}`,
            notification: {
              title: t(kind === 'checkpoint' ? 'chat:checkpointCreated' : 'chat:branchCreated'),
              description: message.content.slice(0, 120),
              variant: 'success',
              timeoutMs: 8000,
              action: { label: t('chat:snapshotOpen'), event: 'neotavern-open-child-chat' },
              chatId: response.chat.id,
            },
          },
        }),
      );
      return response;
    },
    [chatId, queryClient, t],
  );

  const handleCreateCheckpoint = useCallback(
    async (message: Message, kind: 'checkpoint' | 'branch', replace: boolean): Promise<void> => {
      try {
        const response = await createSnapshot(message, kind, replace);
        // Shift+click on an existing flag: replace the link and open the new child.
        if (replace) navigate(`/chats/${response.chat.id}`);
      } catch (err) {
        setError(errorText(err));
      }
    },
    [createSnapshot, errorText, navigate],
  );

  const openCheckpoint = useCallback(
    (message: Message): void => {
      if (message.checkpointChatId) navigate(`/chats/${message.checkpointChatId}`);
    },
    [navigate],
  );

  const replaceCheckpoint = useCallback(
    (message: Message): void => {
      void handleCreateCheckpoint(message, 'checkpoint', true);
    },
    [handleCreateCheckpoint],
  );

  const deleteCheckpoint = useCallback(
    async (message: Message): Promise<void> => {
      if (!chatId) return;
      setError(null);
      try {
        await updateChatMessage(chatId, message.id, {
          meta: { ...message.meta, checkpointChatId: null },
        });
        await queryClient.invalidateQueries({ queryKey: ['messages', chatId] });
      } catch (err) {
        setError(errorText(err));
        throw err;
      }
    },
    [chatId, queryClient, errorText],
  );

  const assistantIdentity = useMemo(
    () =>
      character.data ? { name: character.data.name, avatar: character.data.avatar } : undefined,
    [character.data],
  );

  const globalBackgroundId = useUiStore((state) => state.globalBackgroundId);

  const wallpaperUrl = useMemo(() => {
    const backgroundId = chat.data?.backgroundId ?? globalBackgroundId;
    return wallpaperBackgroundUrl(backgroundId);
  }, [chat.data?.backgroundId, globalBackgroundId]);

  useEffect(() => {
    const state = location.state as { initialMessage?: unknown } | null;
    const initialMessage =
      typeof state?.initialMessage === 'string' ? state.initialMessage.trim() : '';

    if (
      initialMessage.length === 0 ||
      initialMessageHandledRef.current ||
      !chat.data ||
      isGenerating
    ) {
      return;
    }

    initialMessageHandledRef.current = true;
    navigate(location.pathname, { replace: true, state: null });
    void send(initialMessage);
  }, [chat.data, isGenerating, location.pathname, location.state, navigate]);

  return (
    <ErrorBoundary name="chat">
      <ChatWorkspace
        viewName="chat-view"
        viewportLabel={t('accessibility:messageList')}
        footerError={error ?? undefined}
        wallpaperUrl={wallpaperUrl}
        viewportRef={viewportRef}
        header={
          <ChatHeader
            name={character.data?.name ?? null}
            avatar={character.data?.avatar}
            searchableTexts={searchableTexts}
            onQueryChange={setChatSearchQuery}
            backToParentChatId={chat.data?.parentChatId ?? null}
          />
        }
        composer={
          <ChatComposer
            textareaId="chat-message"
            value={input}
            placeholder={t('home:composerPlaceholder', { name: character.data?.name })}
            inputRef={inputRef}
            onChange={(value) => setSessionDraft(draftScope, value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            onOpenSettings={() => openSidebarPanel('providers')}
            onReset={clearDraft}
            onScrollToLatest={() =>
              viewportRef.current?.scrollTo({
                top: viewportRef.current.scrollHeight,
                behavior: 'smooth',
              })
            }
            extraToolbarActions={
              <button
                type="button"
                onClick={() => void send(undefined, true)}
                disabled={!canRegenerate}
                aria-label={t('chat:regenerate')}
                title={t('chat:regenerate')}
              >
                <ArrowCounterClockwise size={17} aria-hidden="true" />
              </button>
            }
            contextPanelId="chat-context-details"
            contextOpen={contextOpen}
            onToggleContext={() => setContextOpen((open) => !open)}
            contextTriggerTitle={
              contextTriggerPending
                ? t('common:loading')
                : `${t('chat:contextPromptTokens')}: ${contextUsage.promptTokens.toLocaleString()} / ${t('chat:contextLimit')}: ${contextUsage.contextLimit.toLocaleString()}`
            }
            contextTriggerLabel={contextTriggerPending ? '…' : `${contextUsage.usagePercent}%`}
            contextPanel={
              <ContextUsagePanel
                id="chat-context-details"
                summary={contextUsage}
                source="preview"
                isLoading={contextPanelLoading}
                isError={contextPreviewError}
                tokenizerProfile={contextPreview?.tokenizer.profile}
                tokenizerApproximate={contextPreview?.tokenizer.approximate}
              />
            }
            onSubmit={() => void send()}
            submitDisabled={input.trim().length === 0}
            isGenerating={isGenerating}
            onStop={stop}
          />
        }
      >
        {messages.hasNextPage ? (
          <div className={styles.loadOlder}>
            <Button
              size="sm"
              onClick={() => void messages.fetchNextPage()}
              disabled={messages.isFetchingNextPage}
            >
              {t('chat:loadOlder')}
            </Button>
          </div>
        ) : null}

        {chat.isLoading || messages.isLoading ? (
          <div className={styles.loading} aria-label={t('common:loading')}>
            <Skeleton className={styles.loadingItem} />
            <Skeleton className={styles.loadingItem} />
            <Skeleton className={styles.loadingItem} />
          </div>
        ) : chat.isError || messages.isError ? (
          <div className={workspaceStyles.chatState} data-component="chat-state" role="alert">
            <span className={workspaceStyles.chatStateIcon} aria-hidden="true">
              <ChatCircleDots size={32} weight="duotone" />
            </span>
            <h2>{t('chat:errorTitle')}</h2>
            <p>{errorText(chat.error ?? messages.error)}</p>
            <Button
              onClick={() => {
                void chat.refetch();
                void messages.refetch();
              }}
            >
              {t('common:retry')}
            </Button>
          </div>
        ) : ordered.length > 0 ? (
          <div
            className={styles.messageCanvas}
            data-component="chat-message-list"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const message = ordered[virtualRow.index];
              if (!message) return null;
              const isRegenerating = isGenerating && message.id === regeneratingId;
              const isLastMessage = message.id === lastMessage?.id;
              return (
                <div
                  key={message.id}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className={styles.messageRow}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <ChatMessageRow
                    message={isRegenerating ? { ...message, content: streamingText } : message}
                    macroContext={macroContext}
                    assistantIdentity={assistantIdentity}
                    searchQuery={chatSearchQuery}
                    isGenerating={isGenerating}
                    streaming={isRegenerating}
                    streamingContent={isRegenerating ? streamingText : undefined}
                    canRegenerate={isLastMessage && canRegenerate}
                    isLastMessage={isLastMessage}
                    onSaveEdit={saveMessageEdit}
                    onDelete={deleteMessage}
                    onToggleContext={toggleMessageContext}
                    onSwipeGreeting={swipeGreeting}
                    onCopy={copyMessage}
                    onRegenerate={regenerateLast}
                    onVariantSwipe={variantSwipe}
                    onCreateCheckpoint={handleCreateCheckpoint}
                    onOpenCheckpoint={openCheckpoint}
                    onReplaceCheckpoint={replaceCheckpoint}
                    onDeleteCheckpoint={deleteCheckpoint}
                    branchId={chat.data?.activeBranchId ?? null}
                    editError={editErrorId === message.id ? editErrorText : null}
                  />
                </div>
              );
            })}
          </div>
        ) : !isGenerating ? (
          <div className={workspaceStyles.chatState} data-component="chat-state">
            <span className={workspaceStyles.chatStateIcon} aria-hidden="true">
              <ChatCircleDots size={32} weight="duotone" />
            </span>
            <h2>{t('chat:emptyChat')}</h2>
            <p>{t('chat:emptyChatHint')}</p>
          </div>
        ) : null}

        {isGenerating && pendingUserMessage ? (
          <MessageBubble
            message={{
              id: '__pending-user__',
              chatId: chatId ?? '',
              branchId: '',
              parentId: null,
              role: 'user',
              content: pendingUserMessage.content,
              name: null,
              meta: {},
              createdAt: 0,
              revision: 1,
              updatedAt: null,
              variantCount: 0,
              activeVariantPosition: null,
              contentRevisionCount: 0,
              checkpointChatId: null,
            }}
            pending
            macroContext={macroContext}
            assistantIdentity={assistantIdentity}
            searchQuery={chatSearchQuery}
            canRegenerate={false}
            onSaveEdit={saveMessageEdit}
            onDelete={deleteMessage}
            onToggleContext={toggleMessageContext}
            onCopy={copyMessage}
            onRegenerate={regenerateLast}
            onCreateCheckpoint={handleCreateCheckpoint}
            onOpenCheckpoint={openCheckpoint}
            onReplaceCheckpoint={replaceCheckpoint}
            onDeleteCheckpoint={deleteCheckpoint}
            branchId={chat.data?.activeBranchId ?? null}
          />
        ) : null}

        {!regeneratingId && (streamingText.length > 0 || isGenerating) ? (
          <MessageBubble
            message={{
              id: '__streaming__',
              chatId: chatId ?? '',
              branchId: '',
              parentId: null,
              role: 'assistant',
              content: streamingText,
              name: null,
              meta: { streaming: true },
              createdAt: 0,
              revision: 1,
              updatedAt: null,
              variantCount: 0,
              activeVariantPosition: null,
              contentRevisionCount: 0,
              checkpointChatId: null,
            }}
            macroContext={macroContext}
            assistantIdentity={assistantIdentity}
            streaming
          />
        ) : null}
      </ChatWorkspace>
    </ErrorBoundary>
  );
}

/**
 * Memoized list row (OTHER-60): during streaming the page body re-renders
 * ~30 times/second, but a row only re-renders when its own message or shared
 * inputs change — markdown is not re-parsed for every bubble on every flush.
 * Swipe controls are derived from the message meta here so their closures
 * never leak into the memo boundary's props.
 */
const ChatMessageRow = memo(function ChatMessageRow({
  message,
  macroContext,
  assistantIdentity,
  searchQuery,
  isGenerating,
  streaming = false,
  streamingContent,
  canRegenerate = false,
  isLastMessage = false,
  onSaveEdit,
  onDelete,
  onToggleContext,
  onSwipeGreeting,
  onCopy,
  onRegenerate,
  onVariantSwipe,
  onCreateCheckpoint,
  onOpenCheckpoint,
  onReplaceCheckpoint,
  onDeleteCheckpoint,
  branchId,
  editError,
}: {
  message: Message;
  macroContext: MacroContext | undefined;
  assistantIdentity: { name: string; avatar: string | null } | undefined;
  searchQuery: string;
  isGenerating: boolean;
  streaming?: boolean;
  streamingContent?: string;
  canRegenerate?: boolean;
  isLastMessage?: boolean;
  onSaveEdit: (messageId: string, content: string) => Promise<void>;
  onDelete: (messageId: string) => Promise<void>;
  onToggleContext: (message: Message) => Promise<void>;
  onSwipeGreeting: (message: Message, nextIndex: number) => Promise<void>;
  onCopy: (message: Message) => Promise<void>;
  onRegenerate: () => void;
  onVariantSwipe: (message: Message, position: number) => Promise<void>;
  onCreateCheckpoint: (
    message: Message,
    kind: 'checkpoint' | 'branch',
    replace: boolean,
  ) => Promise<void>;
  onOpenCheckpoint: (message: Message) => void;
  onReplaceCheckpoint: (message: Message) => void;
  onDeleteCheckpoint: (message: Message) => Promise<void>;
  branchId: string | null;
  editError: string | null;
}) {
  const greetingSwipes = readGreetingSwipes(message.meta);
  const activeVariantPosition = message.activeVariantPosition;
  // Stored-variant swipe controls (migration-0020 positions). The active
  // content lives in `message.content`; switching swaps stored variants in.
  //
  // Kernel mode does not carry variant counts on the message (translateMessage
  // reports 0/null): the swipe set is derived from the variants query —
  // stored alternatives sorted by position plus the active content as the
  // implicit last item (the active text is not a variant row; the canonical
  // model records the replaced text as a revision instead). The eager query
  // is limited to the newest message so a long history does not fan out one
  // variants request per assistant row; older rows load lazily via the picker.
  const variantQuery = useMessageVariants(
    message.chatId,
    message.id,
    message.role === 'assistant' && message.activeVariantPosition === null && isLastMessage,
  );
  const storedVariants = variantQuery.data ?? [];
  const totalSwipes =
    activeVariantPosition !== null ? message.variantCount : storedVariants.length + 1;
  const contentIndex = storedVariants.findIndex((variant) => variant.content === message.content);
  const currentSwipe =
    activeVariantPosition !== null
      ? activeVariantPosition + 1
      : contentIndex >= 0
        ? contentIndex + 1
        : totalSwipes;
  const variantSwipe =
    totalSwipes > 1 && (activeVariantPosition !== null || variantQuery.isSuccess)
      ? {
          current: currentSwipe,
          total: totalSwipes,
          disabled: isGenerating,
          onPrevious: (): void => void onVariantSwipe(message, currentSwipe - 2),
          onNext: (): void => void onVariantSwipe(message, currentSwipe),
        }
      : undefined;
  const swipe =
    variantSwipe ??
    (greetingSwipes && greetingSwipes.swipes.length > 1
      ? {
          current: greetingSwipes.swipeId + 1,
          total: greetingSwipes.swipes.length,
          disabled: isGenerating,
          onPrevious: (): void => void onSwipeGreeting(message, greetingSwipes.swipeId - 1),
          onNext: (): void => void onSwipeGreeting(message, greetingSwipes.swipeId + 1),
        }
      : undefined);
  return (
    <MessageBubble
      message={message}
      macroContext={macroContext}
      assistantIdentity={assistantIdentity}
      searchQuery={searchQuery}
      streaming={streaming}
      streamingContent={streamingContent}
      swipe={swipe}
      branchId={branchId}
      editError={editError}
      canRegenerate={canRegenerate}
      onSaveEdit={onSaveEdit}
      onDelete={onDelete}
      onToggleContext={onToggleContext}
      onCopy={onCopy}
      onRegenerate={onRegenerate}
      onCreateCheckpoint={onCreateCheckpoint}
      onOpenCheckpoint={onOpenCheckpoint}
      onReplaceCheckpoint={onReplaceCheckpoint}
      onDeleteCheckpoint={onDeleteCheckpoint}
    />
  );
});
