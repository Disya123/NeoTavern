import {
  ArrowDown,
  ArrowUp,
  ChatsCircle,
  DownloadSimple,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Trash,
} from '@phosphor-icons/react';
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { ChatSummary, CursorPage } from '@neotavern/contracts';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  TextField,
  useRowGestures,
} from '@neotavern/ui';
import {
  useChat,
  useCharacter,
  useChats,
  useCharacters,
  useCreateChat,
  useDeleteChat,
  useReorderChats,
  useUpdateChat,
} from '../api/hooks.js';
import { exportChat } from '../api/wireBridge.js';
import { useErrorText } from '../lib/useErrorText.js';
import { useUiStore } from '../state/ui.js';
import { ConfirmActionDialog } from './ConfirmActionDialog.js';
import { FloatingTabPanel } from './FloatingTabPanel.js';
import styles from './ChatManagementPanel.module.css';

interface ChatManagementPanelProps {
  onClose: () => void;
}

function readChatId(pathname: string): string | null {
  const match = /^\/chats\/([^/]+)$/u.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function formatDate(value: number, language: string): string {
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(value);
  } catch {
    return new Date(value).toLocaleDateString();
  }
}

export function ChatManagementPanel({ onClose }: ChatManagementPanelProps) {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const location = useLocation();
  const navigate = useNavigate();
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const pinnedCharacterId = useUiStore((state) => state.pinnedCharacterId);
  const setPinnedCharacterId = useUiStore((state) => state.setPinnedCharacterId);
  const queryClient = useQueryClient();

  const chatId = readChatId(location.pathname);
  const chat = useChat(chatId ?? undefined);
  const currentChatCharacterId = chat.data?.characterId ?? null;

  // Keep the list scoped to the conversation context without exposing a
  // second character picker in the chat management panel.
  const [filterCharacterId, setFilterCharacterId] = useState<string | null>(null);
  useEffect(() => {
    setFilterCharacterId(currentChatCharacterId ?? pinnedCharacterId);
  }, [currentChatCharacterId, pinnedCharacterId]);

  const [searchInput, setSearchInput] = useState('');
  const deferredSearch = useDeferredValue(searchInput.trim());
  const searchQuery = deferredSearch.length > 0 ? deferredSearch : undefined;

  // Recently used characters power the row labels when there is no active
  // context. The query remains bounded and never loads the whole catalog.
  const usedCharacters = useCharacters({ sort: 'used', limit: 50 });
  const usedOptions = usedCharacters.data?.pages.flatMap((page) => page.items) ?? [];

  const currentCharacter = useCharacter(chatId ? (currentChatCharacterId ?? undefined) : undefined);
  const pinnedCharacter = useCharacter(pinnedCharacterId ?? undefined);
  const characterOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: Array<{ id: string; name: string }> = [];
    const push = (id: string | null | undefined, name: string | undefined): void => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      options.push({ id, name: name?.trim() || t('chat:unnamedCharacter') });
    };
    push(currentChatCharacterId, currentCharacter.data?.name);
    push(pinnedCharacterId, pinnedCharacter.data?.name);
    for (const character of usedOptions) push(character.id, character.name);
    return options;
  }, [
    currentChatCharacterId,
    currentCharacter.data?.name,
    pinnedCharacterId,
    pinnedCharacter.data?.name,
    usedOptions,
    t,
  ]);

  const chats = useChats(filterCharacterId ?? undefined, searchQuery);
  const items = chats.data?.pages.flatMap((page) => page.items) ?? [];

  const createChat = useCreateChat();
  const updateChat = useUpdateChat();
  const deleteChat = useDeleteChat();
  const reorderChats = useReorderChats();

  const [renameTarget, setRenameTarget] = useState<ChatSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ChatSummary | null>(null);
  const [contextMenuChatId, setContextMenuChatId] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const chatItemsRef = useRef(items);
  const draggedChatIdRef = useRef<string | null>(null);
  const dragStartOrderRef = useRef<string[]>([]);

  useEffect(() => {
    chatItemsRef.current = items;
  }, [items]);

  // Reordering only makes sense for a single character's canonical list, not
  // for the all-chats view or search results.
  const canReorder = filterCharacterId !== null && searchQuery === undefined;

  const handleCreate = async (): Promise<void> => {
    setPanelError(null);
    const targetCharacterId = currentChatCharacterId ?? pinnedCharacterId ?? null;
    try {
      const created = await createChat.mutateAsync({
        characterId: targetCharacterId,
        title: t('chat:newChatTitle'),
        reuseUnstarted: true,
      });
      if (targetCharacterId !== null) setPinnedCharacterId(targetCharacterId);
      setSidebarOpen(false);
      navigate(`/chats/${created.id}`);
    } catch (error) {
      setPanelError(errorText(error));
    }
  };

  const startRename = (chat: ChatSummary): void => {
    setRenameDraft(chat.title);
    setRenameTarget(chat);
    setPanelError(null);
  };

  const confirmRename = async (): Promise<void> => {
    if (!renameTarget) return;
    const title = renameDraft.trim();
    if (title.length === 0 || title === renameTarget.title) {
      setRenameTarget(null);
      return;
    }
    setPanelError(null);
    try {
      await updateChat.mutateAsync({ id: renameTarget.id, update: { title } });
      setRenameTarget(null);
    } catch (error) {
      setPanelError(errorText(error));
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    setPanelError(null);
    try {
      await deleteChat.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
    } catch (error) {
      setPanelError(errorText(error));
    }
  };

  // --- Shared row gestures (right-click / long-press menu, drag reorder) ---
  // The framework-agnostic recognition lives in @neotavern/gestures; this panel only
  // maps the events onto its optimistic reorder + persistence machinery.

  const previewChatAtIndex = (to: number): void => {
    const draggedChatId = draggedChatIdRef.current;
    if (!draggedChatId) return;
    const currentItems = chatItemsRef.current;
    const from = currentItems.findIndex((item) => item.id === draggedChatId);
    if (from < 0 || from === to || to < 0 || to >= currentItems.length) return;
    const moved = currentItems[from];
    if (!moved) return;
    const next = [...currentItems];
    next.splice(from, 1);
    next.splice(to, 0, moved);
    const actualPosition = next.findIndex((item) => item.id === draggedChatId);
    if (actualPosition === from) return;
    chatItemsRef.current = next;
    applyOptimisticOrder(next.map((item) => item.id));
    setDraggedIndex(actualPosition);
  };

  const { draggedIndex, setDraggedIndex, consumeClick, handlers } = useRowGestures({
    indexAttribute: 'data-chat-index',
    canDrag: () => canReorder,
    onDragStart: (chatId) => {
      setContextMenuChatId(null);
      draggedChatIdRef.current = chatId;
      dragStartOrderRef.current = chatItemsRef.current.map((item) => item.id);
    },
    onDragMove: (_chatId, toIndex) => previewChatAtIndex(toIndex),
    onDragEnd: (_chatId, committed) => {
      if (!committed) {
        draggedChatIdRef.current = null;
        dragStartOrderRef.current = [];
        return;
      }
      const orderedIds = chatItemsRef.current.map((item) => item.id);
      const changed = orderedIds.join('\u0000') !== dragStartOrderRef.current.join('\u0000');
      if (changed) persistOrder(orderedIds);
      draggedChatIdRef.current = null;
      dragStartOrderRef.current = [];
    },
    onOpenMenu: (chatId) => setContextMenuChatId(chatId),
  });

  const busy = createChat.isPending || deleteChat.isPending || reorderChats.isPending;

  const applyOptimisticOrder = (orderedIds: string[]): void => {
    const orderMap = new Map(orderedIds.map((id, index) => [id, index]));
    const key = ['chats', filterCharacterId, searchQuery];
    queryClient.setQueryData<InfiniteData<CursorPage<ChatSummary>>>(key, (current) => {
      if (!current) return current;
      return {
        ...current,
        pages: current.pages.map((page) => ({
          ...page,
          items: [...page.items].sort((left, right) => {
            const il = orderMap.get(left.id);
            const ir = orderMap.get(right.id);
            if (il === undefined && ir === undefined) return 0;
            if (il === undefined) return 1;
            if (ir === undefined) return -1;
            return il - ir;
          }),
        })),
      };
    });
  };

  const persistOrder = (orderedIds: string[]): void => {
    if (!filterCharacterId || orderedIds.length === 0) return;
    applyOptimisticOrder(orderedIds);
    reorderChats.mutate(
      { characterId: filterCharacterId, order: orderedIds },
      {
        onError: (error) => {
          setPanelError(errorText(error));
          void queryClient.invalidateQueries({ queryKey: ['chats'] });
        },
      },
    );
  };

  const move = (id: string, delta: -1 | 1): void => {
    if (!canReorder) return;
    const ids = items.map((item) => item.id);
    const index = ids.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ids.length) return;
    const next = [...ids];
    const moving = next[index];
    const displaced = next[target];
    if (moving === undefined || displaced === undefined) return;
    next[index] = displaced;
    next[target] = moving;
    persistOrder(next);
  };

  return (
    <FloatingTabPanel
      component="chat-management"
      headerPart="chat-management-header"
      title={t('chat:managementTitle')}
      onClose={onClose}
    >
      <div className={styles.toolbar} data-part="chat-toolbar">
        <label className={styles.searchControl}>
          <MagnifyingGlass size={17} aria-hidden="true" />
          <span className={styles.srOnly}>{t('chat:searchPlaceholder')}</span>
          <input
            type="search"
            placeholder={t('chat:searchPlaceholder')}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </label>
      </div>

      <div className={styles.scroll}>
        <div className={styles.body}>
          <div className={styles.newChatAction} data-part="chat-actions">
            <Button
              size="sm"
              variant="primary"
              startIcon={<Plus aria-hidden="true" />}
              onClick={() => void handleCreate()}
              disabled={createChat.isPending}
            >
              {t('chat:newChat')}
            </Button>
          </div>

          {chats.isLoading ? (
            <PanelSkeleton />
          ) : chats.isError ? (
            <EmptyState
              icon={<ChatsCircle size={32} aria-hidden="true" />}
              title={t('chat:errorTitle')}
              hint={errorText(chats.error)}
              action={t('common:retry')}
              onAction={() => void chats.refetch()}
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon={<ChatsCircle size={32} aria-hidden="true" />}
              title={searchQuery ? t('chat:noResultsTitle') : t('chat:noChatsTitle')}
              hint={searchQuery ? t('chat:noResultsDescription') : t('chat:noChatsDescription')}
            />
          ) : (
            <ul className={styles.chatList} data-part="chat-list">
              {items.map((chatItem, index) => {
                const active = chatItem.id === chatId;
                const characterName = characterOptions.find(
                  (option) => option.id === chatItem.characterId,
                )?.name;
                return (
                  <li key={chatItem.id} data-chat-index={index}>
                    <DropdownMenu
                      open={contextMenuChatId === chatItem.id}
                      onOpenChange={(open) => setContextMenuChatId(open ? chatItem.id : null)}
                    >
                      <DropdownMenuTrigger asChild disabled>
                        <div
                          className={styles.chatRow}
                          data-component="chat-item"
                          data-state={active ? 'active' : 'idle'}
                          data-dragging={draggedIndex === index ? 'true' : 'false'}
                          data-reorderable={canReorder ? 'true' : 'false'}
                          {...handlers(chatItem.id, index)}
                        >
                          <NavLink
                            to={`/chats/${chatItem.id}`}
                            className={styles.chatLink}
                            draggable={false}
                            onClick={(event) => {
                              if (consumeClick()) {
                                event.preventDefault();
                                return;
                              }
                              setSidebarOpen(false);
                            }}
                          >
                            <span className={styles.chatAvatar} aria-hidden="true">
                              <ChatsCircle weight="duotone" />
                            </span>
                            <span className={styles.chatCopy}>
                              <strong>{chatItem.title}</strong>
                              <span>
                                {t('chat:messages_other', { count: chatItem.messageCount })}
                                {' · '}
                                {formatDate(chatItem.updatedAt, i18n.language)}
                              </span>
                              {chatItem.origin ? (
                                <span
                                  className={styles.originBadge}
                                  data-part="chat-origin-badge"
                                  data-origin={chatItem.origin}
                                >
                                  {t(
                                    chatItem.origin === 'checkpoint'
                                      ? 'chat:checkpointBadge'
                                      : 'chat:branchBadge',
                                  )}
                                </span>
                              ) : null}
                              {filterCharacterId === null && characterName ? (
                                <span className={styles.characterLabel}>{characterName}</span>
                              ) : null}
                            </span>
                          </NavLink>
                        </div>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem asChild>
                          <NavLink
                            to={`/chats/${chatItem.id}`}
                            onClick={() => setSidebarOpen(false)}
                          >
                            <ChatsCircle aria-hidden="true" />
                            {t('chat:open')}
                          </NavLink>
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => startRename(chatItem)}>
                          <PencilSimple aria-hidden="true" />
                          {t('chat:rename')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() =>
                            exportChat(chatItem.id).catch((error) =>
                              setPanelError(errorText(error)),
                            )
                          }
                        >
                          <DownloadSimple aria-hidden="true" />
                          {t('chat:export')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          disabled={!canReorder || index === 0}
                          onSelect={() => move(chatItem.id, -1)}
                        >
                          <ArrowUp aria-hidden="true" />
                          {t('chat:moveUp')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={!canReorder || index === items.length - 1}
                          onSelect={() => move(chatItem.id, 1)}
                        >
                          <ArrowDown aria-hidden="true" />
                          {t('chat:moveDown')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => setDeleteTarget(chatItem)}>
                          <Trash aria-hidden="true" />
                          {t('chat:delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                );
              })}
            </ul>
          )}

          {chats.hasNextPage ? (
            <Button
              className={styles.loadMore}
              onClick={() => void chats.fetchNextPage()}
              disabled={chats.isFetchingNextPage}
            >
              {chats.isFetchingNextPage ? t('common:loading') : t('common:loadMore')}
            </Button>
          ) : null}
        </div>
      </div>

      {panelError ? (
        <p className={styles.error} role="alert">
          {panelError}
        </p>
      ) : null}

      <Dialog open={renameTarget !== null} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent title={t('chat:renameTitle')}>
          <TextField
            label={t('chat:titleLabel')}
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void confirmRename();
              }
            }}
          />
          <div className={styles.dialogActions}>
            <DialogClose asChild>
              <Button disabled={busy}>{t('common:cancel')}</Button>
            </DialogClose>
            <Button disabled={busy} onClick={() => void confirmRename()}>
              {t('common:save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmActionDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('chat:deleteTitle')}
        description={t('chat:deleteConfirm', { title: deleteTarget?.title ?? '' })}
        confirmLabel={t('chat:delete')}
        danger
        busy={busy}
        onConfirm={() => void confirmDelete()}
      />
    </FloatingTabPanel>
  );
}

function PanelSkeleton() {
  return (
    <div className={styles.panelSkeleton} aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

function EmptyState({
  icon,
  title,
  hint,
  action,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className={styles.emptyState}>
      {icon}
      <strong>{title}</strong>
      {hint ? <p>{hint}</p> : null}
      {action && onAction ? (
        <Button size="sm" onClick={onAction}>
          {action}
        </Button>
      ) : null}
    </div>
  );
}
