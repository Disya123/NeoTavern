/**
 * TanStack Query hooks for server state (AGENTS.md §13). Explicit staleTime
 * keeps the catalog/chats cached; mutations invalidate precisely. API keys are
 * never stored here.
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AppSettings,
  AppSettingsUpdate,
  AuthLogin,
  AuthSession,
  BackgroundItem,
  BackgroundList,
  Backup,
  CacheCleanupResult,
  CharacterCreate,
  CharacterGallery,
  CharacterGalleryImage,
  CharacterImportResult,
  CharacterListQuery,
  CharacterUpdate,
  ChatCreate,
  ChatReorder,
  ChatUpdate,
  CursorPage,
  InstructFormatListResponse,
  Lorebook,
  LorebookCreate,
  LorebookEntry,
  LorebookEntryCreate,
  LorebookEntryUpdate,
  LorebookUpdate,
  Message,
  MessageContentRevision,
  MessageVariant,
  Preset,
  PresetCreate,
  PresetUpdate,
  Persona,
  PersonaCreate,
  PersonaUpdate,
  PromptContextAuditResponse,
  PromptContextPreviewRequest,
  PromptContextPreviewResponse,
  SillyTavernImportAnalysis,
  SillyTavernImportExecute,
  SillyTavernImportResult,
  ThemeActivationResult,
  ThemeDeleteResult,
  ThemeInstallResult,
  ThemeListResponse,
  PluginActivateRequest,
  PluginAuthConnectRequest,
  PluginAuthConnectResult,
  PluginAuthConnectionsResponse,
  PluginAuthRevokeRequest,
  PluginAuthRevokeResult,
  PluginDeleteResult,
  PluginGitInstallRequest,
  PluginInstallResult,
  PluginLifecycleResult,
  PluginListResponse,
  PluginSafeModeResult,
  DiagnosticsSnapshot,
  VersionResponse,
} from '@neotavern/contracts';
import { api, setCsrfToken } from './client.js';
import {
  continueCharacterChat as continueChat,
  createCharacter,
  createChat,
  deleteCharacter,
  deleteChat,
  readCharacters,
  readCharacter,
  readChats,
  readRecentChats,
  readChat,
  readMessages,
  updateCharacter,
  updateChat,
  type ContinueCharacterChatInput,
  type ContinueCharacterChatResult,
} from './wireBridge.js';
export * from './providerHooks.js';
export type { ContinueCharacterChatInput, ContinueCharacterChatResult } from './wireBridge.js';

const MINUTE = 60_000;

/* Authentication ---------------------------------------------------------- */

export function useAuthSession() {
  return useQuery({
    queryKey: ['auth-session'],
    queryFn: async () => {
      const session = await api.get<AuthSession>('/auth/session');
      setCsrfToken(session.csrfToken ?? null);
      return session;
    },
    staleTime: MINUTE,
    retry: false,
  });
}

export function useAppVersion() {
  return useQuery({
    queryKey: ['app-version'],
    queryFn: () => api.get<VersionResponse>('/version'),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AuthLogin) => api.post<AuthSession>('/auth/session', input),
    onSuccess: (session) => {
      setCsrfToken(session.csrfToken ?? null);
      qc.setQueryData(['auth-session'], session);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del<AuthSession>('/auth/session'),
    onSuccess: (session) => {
      setCsrfToken(null);
      qc.setQueryData(['auth-session'], session);
      qc.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth-session' });
    },
  });
}

function encodeQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs.length > 0 ? `?${qs}` : '';
}

/* Characters --------------------------------------------------------------- */

export function useCharacters(query: CharacterListQuery = {}) {
  // Random sort returns a single shuffled page per request with no cursor, so
  // the page must not be served from cache on remount/refocus — each load is a
  // fresh shuffle (`staleTime: 0` forces a network fetch every time).
  const isRandom = query.sort === 'random';
  return useInfiniteQuery({
    queryKey: ['characters', query],
    queryFn: ({ pageParam }) => readCharacters(query, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: isRandom ? 0 : 2 * MINUTE,
    gcTime: isRandom ? 0 : undefined,
  });
}

export function useCharacter(id: string | undefined) {
  return useQuery({
    queryKey: ['character', id],
    queryFn: () => readCharacter(id as string),
    enabled: id !== undefined,
  });
}

export function useCreateCharacter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CharacterCreate) => createCharacter(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['characters'] }),
  });
}

export function useUpdateCharacter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: CharacterUpdate }) =>
      updateCharacter(id, patch),
    onSuccess: (character) => {
      qc.setQueryData(['character', character.id], character);
      void qc.invalidateQueries({ queryKey: ['characters'] });
    },
  });
}

export function useImportCharacter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => api.upload<CharacterImportResult>('/characters/import', file),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['characters'] }),
  });
}

export function useDeleteCharacter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteCharacter(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['characters'] }),
  });
}

export function useCharacterGallery(characterId: string | undefined, sort: 'oldest' | 'newest') {
  return useQuery({
    queryKey: ['character-gallery', characterId, sort],
    queryFn: () => api.get<CharacterGallery>(`/characters/${characterId}/gallery?sort=${sort}`),
    enabled: characterId !== undefined,
  });
}

export function useUploadCharacterImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ characterId, file }: { characterId: string; file: File }) =>
      api.upload<CharacterGalleryImage>(`/characters/${characterId}/gallery`, file),
    onSuccess: (_image, { characterId }) =>
      void qc.invalidateQueries({ queryKey: ['character-gallery', characterId] }),
  });
}

export function useDeleteCharacterImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ characterId, imageId }: { characterId: string; imageId: string }) =>
      api.del(`/characters/${characterId}/gallery/${imageId}`),
    onSuccess: (_result, { characterId }) =>
      void qc.invalidateQueries({ queryKey: ['character-gallery', characterId] }),
  });
}

/* Chats -------------------------------------------------------------------- */

export function useChats(characterId?: string, q?: string) {
  const query = q?.trim() || undefined;
  return useInfiniteQuery({
    queryKey: ['chats', characterId, query],
    queryFn: ({ pageParam }) => readChats(characterId, query, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });
}

export function useRecentChats(limit = 8, characterId?: string) {
  return useQuery({
    queryKey: ['chats', 'recent', characterId, limit],
    queryFn: () => readRecentChats(limit, characterId),
    staleTime: 30_000,
  });
}

const pendingCharacterContinuations = new Map<string, Promise<ContinueCharacterChatResult>>();

async function continueCharacterChat(
  input: ContinueCharacterChatInput,
): Promise<ContinueCharacterChatResult> {
  const pending = pendingCharacterContinuations.get(input.characterId);
  if (pending) return pending;

  // The transport branch (kernel continue vs legacy reuseUnstarted guard)
  // lives in the API layer (ТЗ §13.1); this wrapper only deduplicates
  // concurrent selections so they cannot create duplicate empty chats.
  const request = continueChat(input);

  pendingCharacterContinuations.set(input.characterId, request);
  try {
    return await request;
  } finally {
    if (pendingCharacterContinuations.get(input.characterId) === request) {
      pendingCharacterContinuations.delete(input.characterId);
    }
  }
}

/**
 * Continue the most recently updated chat for a character, creating one only
 * when the character has no live chats. Concurrent duplicate selections share
 * one request so they cannot create duplicate empty chats.
 */
export function useContinueCharacterChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: continueCharacterChat,
    onSuccess: (result) => {
      if (result.created) void qc.invalidateQueries({ queryKey: ['chats'] });
    },
  });
}

export function useChat(id: string | undefined) {
  return useQuery({
    queryKey: ['chat', id],
    queryFn: () => readChat(id as string),
    enabled: id !== undefined,
  });
}

export function usePromptContextAudit(chatId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['prompt-context-audit', chatId],
    queryFn: () => api.get<PromptContextAuditResponse>(`/chats/${chatId}/context-audit`),
    enabled: chatId !== undefined && enabled,
    staleTime: 0,
  });
}

export function usePromptContextPreview(
  input: PromptContextPreviewRequest | undefined,
  enabled = true,
  cacheKey?: unknown,
) {
  return useQuery({
    queryKey: ['prompt-context-preview', input, cacheKey],
    queryFn: ({ signal }) => {
      if (!input) throw new Error('PROMPT_CONTEXT_PREVIEW_INPUT_REQUIRED');
      return api.post<PromptContextPreviewResponse>('/context-preview', input, signal);
    },
    enabled: input !== undefined && enabled,
    placeholderData: (previousData) => previousData,
    staleTime: 0,
  });
}

export function useCreateChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ChatCreate) => createChat(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['chats'] }),
  });
}

export function useUpdateChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: { id: string; update: ChatUpdate }) => updateChat(id, update),
    onSuccess: (chat) => {
      void qc.invalidateQueries({ queryKey: ['chat', chat.id] });
      void qc.invalidateQueries({ queryKey: ['chats'] });
      void qc.invalidateQueries({ queryKey: ['prompt-context-audit', chat.id] });
    },
  });
}

/** Persist a drag-and-drop ordering of a character's chats. */
export function useReorderChats() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ChatReorder) => api.put<{ reordered: number }>('/chats/order', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['chats'] }),
  });
}

/** Soft-delete a chat to the trash. */
export function useDeleteChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteChat(id),
    onSuccess: (_result, id) => {
      qc.removeQueries({ queryKey: ['chat', id] });
      void qc.invalidateQueries({ queryKey: ['chats'] });
    },
  });
}

export function useMessages(chatId: string | undefined, branchId?: string) {
  return useInfiniteQuery({
    queryKey: ['messages', chatId, branchId],
    queryFn: ({ pageParam }) =>
      readMessages(chatId as string, branchId, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: chatId !== undefined,
    staleTime: 0,
  });
}

/**
 * Stored swipe variants of one message (positions 0..variantCount-1; the
 * active content lives in `messages.content`, not here). Fetched lazily: the
 * query stays disabled until the caller opens the picker.
 */
export function useMessageVariants(
  chatId: string | undefined,
  messageId: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['message-variants', chatId, messageId],
    queryFn: () =>
      api.get<{ items: MessageVariant[] }>(`/chats/${chatId}/messages/${messageId}/variants`),
    enabled: chatId !== undefined && messageId !== undefined && enabled,
    staleTime: 30_000,
  });
}
/** Manual content revisions, loaded newest-first only while the history card is open. */
export function useMessageRevisions(
  chatId: string | undefined,
  messageId: string | undefined,
  enabled: boolean,
) {
  return useInfiniteQuery({
    queryKey: ['message-revisions', chatId, messageId],
    queryFn: ({ pageParam }) =>
      api.get<CursorPage<MessageContentRevision>>(
        `/chats/${chatId}/messages/${messageId}/revisions${encodeQuery({
          cursor: pageParam as string | undefined,
          limit: 20,
        })}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: chatId !== undefined && messageId !== undefined && enabled,
    staleTime: 0,
  });
}

export interface RestoreMessageRevisionInput {
  chatId: string;
  messageId: string;
  revisionId: string;
  expectedRevision: number;
}

/** Restore a manual edit while preserving the current text as a new revision. */
export function useRestoreMessageRevision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RestoreMessageRevisionInput) =>
      api.post<Message>(
        `/chats/${input.chatId}/messages/${input.messageId}/revisions/${encodeURIComponent(input.revisionId)}/restore`,
        { expectedRevision: input.expectedRevision },
      ),
    onSuccess: (_message, input) => {
      void qc.invalidateQueries({ queryKey: ['messages', input.chatId] });
      void qc.invalidateQueries({
        queryKey: ['message-revisions', input.chatId, input.messageId],
      });
    },
  });
}

/* Backgrounds -------------------------------------------------------------- */

export function useBackgrounds() {
  return useQuery({
    queryKey: ['backgrounds'],
    queryFn: () => api.get<BackgroundList>('/backgrounds'),
    staleTime: 30_000,
  });
}

export function useUploadBackground() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => api.upload<BackgroundItem>('/backgrounds', file),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['backgrounds'] }),
  });
}

export function useDeleteBackground() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/backgrounds/${encodeURIComponent(id)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['backgrounds'] });
      // Applying an already-deleted wallpaper would 404; refresh open chats.
      void qc.invalidateQueries({ queryKey: ['chat'] });
    },
  });
}

/* Presets ------------------------------------------------------------------ */
export function usePresets(kind: string) {
  return useQuery({
    queryKey: ['presets', kind],
    queryFn: () => api.get<{ items: Preset[] }>(`/presets?kind=${encodeURIComponent(kind)}`),
  });
}

export function useCreatePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PresetCreate) => api.post<Preset>('/presets', input),
    onSuccess: (preset) => void qc.invalidateQueries({ queryKey: ['presets', preset.kind] }),
  });
}

export function useUpdatePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: { id: string; update: PresetUpdate }) =>
      api.patch<Preset>(`/presets/${id}`, update),
    onSuccess: (preset) => void qc.invalidateQueries({ queryKey: ['presets', preset.kind] }),
  });
}

export function useDeletePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; kind: string }) => api.del<{ ok: true }>(`/presets/${id}`),
    onSuccess: (_result, variables) =>
      void qc.invalidateQueries({ queryKey: ['presets', variables.kind] }),
  });
}

/* Personas ----------------------------------------------------------------- */

export function usePersonas() {
  return useQuery({
    queryKey: ['personas'],
    queryFn: () => api.get<{ items: Persona[] }>('/personas'),
  });
}

export function useCreatePersona() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PersonaCreate) => api.post<Persona>('/personas', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['personas'] }),
  });
}

export function useUpdatePersona() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: { id: string; update: PersonaUpdate }) =>
      api.patch<Persona>(`/personas/${id}`, update),
    onSuccess: (updated) => {
      qc.setQueryData<{ items: Persona[] }>(['personas'], (current) => {
        if (!current) return current;
        return {
          items: current.items.map((persona) => (persona.id === updated.id ? updated : persona)),
        };
      });
    },
  });
}

export function useDeletePersona() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/personas/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['personas'] }),
  });
}

/* Lorebooks ---------------------------------------------------------------- */

export interface LorebookListQuery {
  characterId?: string;
  limit?: number;
}

export function useLorebooks(query: LorebookListQuery = {}) {
  return useInfiniteQuery({
    queryKey: ['lorebooks', query],
    queryFn: ({ pageParam }) =>
      api.get<CursorPage<Lorebook>>(
        `/lorebooks${encodeQuery({
          characterId: query.characterId,
          limit: query.limit,
          cursor: pageParam as string | undefined,
        })}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 2 * MINUTE,
  });
}

export function useLorebook(id: string | undefined) {
  return useQuery({
    queryKey: ['lorebook', id],
    queryFn: () => api.get<Lorebook>(`/lorebooks/${id}`),
    enabled: id !== undefined,
  });
}

export function useLorebookEntries(bookId: string | undefined) {
  return useQuery({
    queryKey: ['lorebooks', bookId, 'entries'],
    queryFn: () => api.get<{ items: LorebookEntry[] }>(`/lorebooks/${bookId}/entries`),
    enabled: bookId !== undefined,
  });
}

export function useCreateLorebook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LorebookCreate) => api.post<Lorebook>('/lorebooks', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lorebooks'] });
      void qc.invalidateQueries({ queryKey: ['characters'] });
    },
  });
}

export function useUpdateLorebook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: { id: string; update: LorebookUpdate }) =>
      api.patch<Lorebook>(`/lorebooks/${id}`, update),
    onSuccess: (book) => {
      qc.setQueryData(['lorebook', book.id], book);
      void qc.invalidateQueries({ queryKey: ['lorebooks'] });
      void qc.invalidateQueries({ queryKey: ['characters'] });
    },
  });
}

export function useDeleteLorebook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/lorebooks/${id}`),
    onSuccess: (_result, id) => {
      qc.removeQueries({ queryKey: ['lorebook', id] });
      void qc.invalidateQueries({ queryKey: ['lorebooks'] });
      void qc.invalidateQueries({ queryKey: ['characters'] });
    },
  });
}

export function useCreateLorebookEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ bookId, input }: { bookId: string; input: LorebookEntryCreate }) =>
      api.post<LorebookEntry>(`/lorebooks/${bookId}/entries`, input),
    onSuccess: (_entry, { bookId }) =>
      void qc.invalidateQueries({ queryKey: ['lorebooks', bookId, 'entries'] }),
  });
}

export function useUpdateLorebookEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      bookId,
      entryId,
      update,
    }: {
      bookId: string;
      entryId: string;
      update: LorebookEntryUpdate;
    }) => api.patch<LorebookEntry>(`/lorebooks/${bookId}/entries/${entryId}`, update),
    onSuccess: (_entry, { bookId }) =>
      void qc.invalidateQueries({ queryKey: ['lorebooks', bookId, 'entries'] }),
  });
}

export function useDeleteLorebookEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ bookId, entryId }: { bookId: string; entryId: string }) =>
      api.del<{ ok: true }>(`/lorebooks/${bookId}/entries/${entryId}`),
    onSuccess: (_result, { bookId }) =>
      void qc.invalidateQueries({ queryKey: ['lorebooks', bookId, 'entries'] }),
  });
}

/* Settings ----------------------------------------------------------------- */

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<AppSettings>('/settings'),
    staleTime: 5 * MINUTE,
  });
}

export function useInstructFormats() {
  return useQuery({
    queryKey: ['instruct-formats'],
    queryFn: () => api.get<InstructFormatListResponse>('/settings/instruct-formats'),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (update: AppSettingsUpdate) => api.patch<AppSettings>('/settings', update),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings'] }),
  });
}

/* Themes ------------------------------------------------------------------- */

export function useThemes(enabled = true) {
  return useQuery({
    queryKey: ['themes'],
    queryFn: () => api.get<ThemeListResponse>('/themes'),
    staleTime: 5 * MINUTE,
    enabled,
  });
}

export function useInstallTheme() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => api.upload<ThemeInstallResult>('/themes/install', file),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['themes'] });
    },
  });
}

export function useActivateTheme() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<ThemeActivationResult>(`/themes/${encodeURIComponent(id)}/activate`),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['themes'] }),
        qc.invalidateQueries({ queryKey: ['settings'] }),
      ]);
    },
  });
}

export function useResetTheme() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del<ThemeActivationResult>('/themes/active'),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['themes'] }),
        qc.invalidateQueries({ queryKey: ['settings'] }),
      ]);
    },
  });
}

export function useDeleteTheme() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<ThemeDeleteResult>(`/themes/${encodeURIComponent(id)}`),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['themes'] }),
        qc.invalidateQueries({ queryKey: ['settings'] }),
      ]);
    },
  });
}

/* Plugins ------------------------------------------------------------------ */

export function usePlugins() {
  return useQuery({
    queryKey: ['plugins'],
    queryFn: () => api.get<PluginListResponse>('/plugins'),
    staleTime: MINUTE,
  });
}

export function useInstallPlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => api.upload<PluginInstallResult>('/plugins/install', file),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

export function useInstallPluginFromGit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PluginGitInstallRequest) =>
      api.post<PluginInstallResult>('/plugins/install-git', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

export function useActivatePlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: PluginActivateRequest }) =>
      api.post<PluginLifecycleResult>(`/plugins/${encodeURIComponent(id)}/activate`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

export function useDisablePlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<PluginLifecycleResult>(`/plugins/${encodeURIComponent(id)}/disable`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

export function useDeletePlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<PluginDeleteResult>(`/plugins/${encodeURIComponent(id)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

export function useEnterPluginSafeMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<PluginSafeModeResult>('/plugins/runtime/safe-mode'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

export function useExitPluginSafeMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del<PluginSafeModeResult>('/plugins/runtime/safe-mode'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

export function usePluginAuthConnections(pluginId: string | null) {
  return useQuery({
    queryKey: ['plugins', pluginId, 'auth-connections'],
    queryFn: () =>
      api.get<PluginAuthConnectionsResponse>(
        `/plugins/${encodeURIComponent(pluginId!)}/auth/connections`,
      ),
    enabled: pluginId !== null,
    staleTime: 5 * 1000,
    refetchInterval: (query) =>
      query.state.data?.items.some((c) => c.status === 'pending') ? 3000 : false,
  });
}

export function usePluginAuthConnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pluginId, input }: { pluginId: string; input: PluginAuthConnectRequest }) =>
      api.post<PluginAuthConnectResult>(
        `/plugins/${encodeURIComponent(pluginId)}/auth/connect`,
        input,
      ),
    onSuccess: (result, vars) =>
      void qc.invalidateQueries({ queryKey: ['plugins', vars.pluginId, 'auth-connections'] }),
  });
}

export function usePluginAuthRevoke() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pluginId, input }: { pluginId: string; input: PluginAuthRevokeRequest }) =>
      api.post<PluginAuthRevokeResult>(
        `/plugins/${encodeURIComponent(pluginId)}/auth/revoke`,
        input,
      ),
    onSuccess: (_, vars) =>
      void qc.invalidateQueries({ queryKey: ['plugins', vars.pluginId, 'auth-connections'] }),
  });
}

/* Complete data migration -------------------------------------------------- */

export function useAnalyzeSillyTavern() {
  return useMutation({
    mutationFn: ({ file, signal }: { file: File; signal: AbortSignal }) =>
      api.upload<SillyTavernImportAnalysis>('/imports/sillytavern/analyze', file, signal),
  });
}

export function useExecuteSillyTavernImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      analysisId,
      input,
      signal,
    }: {
      analysisId: string;
      input: SillyTavernImportExecute;
      signal: AbortSignal;
    }) =>
      api.post<SillyTavernImportResult>(
        `/imports/sillytavern/${analysisId}/execute`,
        input,
        signal,
      ),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['characters'] }),
        qc.invalidateQueries({ queryKey: ['chats'] }),
        qc.invalidateQueries({ queryKey: ['messages'] }),
        qc.invalidateQueries({ queryKey: ['personas'] }),
        qc.invalidateQueries({ queryKey: ['search'] }),
      ]);
    },
  });
}

export function useDiscardSillyTavernAnalysis() {
  return useMutation({
    mutationFn: (analysisId: string) => api.del<void>(`/imports/sillytavern/${analysisId}`),
  });
}

/* Backups (ARCH-06: server state belongs in TanStack Query) ---------------- */

export function useBackups() {
  return useQuery({
    queryKey: ['backups'],
    queryFn: async () => (await api.get<{ items: Backup[] }>('/backups')).items,
  });
}

export function useCreateBackup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<Backup>('/backups'),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['backups'] }),
  });
}

export function useRestoreBackup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ restored: boolean; restartRequired: boolean }>(`/backups/${id}/restore`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['backups'] }),
  });
}

/* Diagnostics (ARCH-06) ----------------------------------------------------- */

export function useDiagnostics() {
  return useQuery({
    queryKey: ['diagnostics'],
    queryFn: () => api.get<DiagnosticsSnapshot>('/diagnostics'),
  });
}

export function useRebuildSearch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/search/rebuild'),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['diagnostics'] }),
  });
}

export function useClearDiagnosticCache() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.del<CacheCleanupResult>('/diagnostics/cache'),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['diagnostics'] }),
  });
}
