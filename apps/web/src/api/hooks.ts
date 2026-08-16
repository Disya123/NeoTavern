/**
 * TanStack Query hooks for server state (AGENTS.md §13). Explicit staleTime
 * keeps the catalog/chats cached; mutations invalidate precisely. API keys are
 * never stored here.
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
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
  InstructFormatListResponse,
  LorebookCreate,
  LorebookEntryCreate,
  LorebookEntryUpdate,
  LorebookUpdate,
  MemoryCreate,
  MemoryUpdate,
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
  PluginActivateRequest,
  PluginAuthConnectRequest,
  PluginAuthRevokeRequest,
  PluginGitInstallRequest,
  DiagnosticsSnapshot,
} from '@neotavern/contracts';
import { api, setCsrfToken } from './client.js';
import {
  continueCharacterChat as continueChat,
  createCharacter,
  createChat,
  createLorebook,
  createLorebookEntry,
  createMemory,
  createPersona,
  createPreset,
  deleteCharacter,
  deleteChat,
  deleteLorebook,
  deleteLorebookEntry,
  deleteMemory,
  deletePersona,
  deletePreset,
  readCharacters,
  readCharacter,
  readChats,
  readRecentChats,
  readChat,
  readLorebook,
  readLorebookEntries,
  readLorebooks,
  readMemories,
  readMessageRevisions,
  readMessageVariants,
  readMessages,
  readPersonas,
  readPresets,
  restoreMessageRevision,
  updateCharacter,
  updateChat,
  updateLorebook,
  updateLorebookEntry,
  updateMemory,
  updatePersona,
  updatePreset,
  uploadCharacterAvatar,
  readThemes,
  activateTheme,
  resetActiveTheme,
  deleteTheme,
  installTheme,
  readPlugins,
  activatePlugin,
  disablePlugin,
  deletePlugin,
  installPlugin,
  installPluginFromGit,
  enterPluginSafeMode,
  exitPluginSafeMode,
  readPluginAuthConnections,
  connectPluginAuth,
  revokePluginAuth,
  readAppVersion,
  readSettings,
  updateSettings,
  importCharacter,
  type ContinueCharacterChatInput,
  type ContinueCharacterChatResult,
} from './wireBridge.js';
import { UnsupportedError } from '@neotavern/neobackend';
import { backend, isKernelMode } from './backend.js';
export * from './providerHooks.js';
export type { ContinueCharacterChatInput, ContinueCharacterChatResult } from './wireBridge.js';

const MINUTE = 60_000;

/* Authentication ---------------------------------------------------------- */

export function useAuthSession() {
  return useQuery({
    queryKey: ['auth-session'],
    queryFn: async () => {
      // Kernel plane: the kernel transport (Tauri IPC / local) has no
      // remote-token session layer — auth applies only to non-loopback
      // legacy exposure (ТЗ §11.3). Honest local session: required=false,
      // authenticated=true — never a silent legacy request (ARC-02).
      if (isKernelMode()) {
        const session: AuthSession = { required: false, authenticated: true };
        return session;
      }
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
    queryFn: () => readAppVersion(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AuthLogin) => {
      // Kernel plane: no remote-token auth layer (see useAuthSession) —
      // honest CAPABILITY_UNAVAILABLE (ТЗ §13.1), never a silent legacy
      // request (ARC-02).
      if (isKernelMode()) {
        return Promise.reject(new UnsupportedError('auth.login'));
      }
      return api.post<AuthSession>('/auth/session', input);
    },
    onSuccess: (session) => {
      setCsrfToken(session.csrfToken ?? null);
      qc.setQueryData(['auth-session'], session);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => {
      // Kernel plane: same honest CAPABILITY_UNAVAILABLE as login.
      if (isKernelMode()) {
        return Promise.reject(new UnsupportedError('auth.logout'));
      }
      return api.del<AuthSession>('/auth/session');
    },
    onSuccess: (session) => {
      setCsrfToken(null);
      qc.setQueryData(['auth-session'], session);
      qc.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth-session' });
    },
  });
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
    mutationFn: (file: File) => importCharacter(file) as Promise<CharacterImportResult>,
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
    queryFn: () => {
      // Kernel plane: the gallery is a legacy image contour
      // (`data/images/characters/<id>/`, sidecar-owned); the kernel models
      // character images only as content-addressed `assets.put` records —
      // honest empty list (ТЗ §13.1), never a silent legacy request (ARC-02).
      if (isKernelMode()) {
        return Promise.resolve<CharacterGallery>({ items: [] });
      }
      return api.get<CharacterGallery>(`/characters/${characterId}/gallery?sort=${sort}`);
    },
    enabled: characterId !== undefined,
  });
}

export function useUploadCharacterImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ characterId, file }: { characterId: string; file: File }) => {
      // Kernel plane: no legacy gallery capability → honest
      // CAPABILITY_UNAVAILABLE (avatars go through useUploadCharacterAvatar).
      if (isKernelMode()) {
        return Promise.reject(new UnsupportedError('characters.gallery.upload'));
      }
      return api.upload<CharacterGalleryImage>(`/characters/${characterId}/gallery`, file);
    },
    onSuccess: (_image, { characterId }) =>
      void qc.invalidateQueries({ queryKey: ['character-gallery', characterId] }),
  });
}

export function useUploadCharacterAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ characterId, file }: { characterId: string; file: File }) =>
      uploadCharacterAvatar(characterId, file),
    onSuccess: (_result, { characterId }) =>
      void qc.invalidateQueries({ queryKey: ['character', characterId] }),
  });
}

export function useDeleteCharacterImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ characterId, imageId }: { characterId: string; imageId: string }) => {
      // Kernel plane: same honest CAPABILITY_UNAVAILABLE as upload.
      if (isKernelMode()) {
        return Promise.reject(new UnsupportedError('characters.gallery.delete'));
      }
      return api.del(`/characters/${characterId}/gallery/${imageId}`);
    },
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
    queryFn: () => {
      // Kernel plane: context audit is the legacy prompt-pipeline preview
      // (`/chats/:id/context-audit`, sidecar pipeline); the kernel exposes
      // `generation.prompt.plan` with a different contract — honest
      // CAPABILITY_UNAVAILABLE (ТЗ §13.1), never a silent legacy request
      // (ARC-02).
      if (isKernelMode()) {
        return Promise.reject(new UnsupportedError('prompt.context-audit'));
      }
      return api.get<PromptContextAuditResponse>(`/chats/${chatId}/context-audit`);
    },
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
    mutationFn: (input: ChatReorder) => {
      // Kernel plane: chat ordering is the legacy `chats.update order`
      // surface; the wire contract has no reorder op — honest
      // CAPABILITY_UNAVAILABLE (ТЗ §13.1), never a silent legacy request
      // (ARC-02).
      if (isKernelMode()) {
        return Promise.reject(new UnsupportedError('chats.reorder'));
      }
      return api.put<{ reordered: number }>('/chats/order', input);
    },
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
 * Stored swipe variants of one message (positions ascending; the active
 * content lives in `messages.content`). Routes through the facade in kernel
 * mode (Этап 4 slice 2) and the legacy variants route otherwise. Fetched
 * lazily: the query stays disabled until the caller opens the picker.
 */
export function useMessageVariants(
  chatId: string | undefined,
  messageId: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['message-variants', chatId, messageId],
    queryFn: () => readMessageVariants(chatId as string, messageId as string),
    enabled: chatId !== undefined && messageId !== undefined && enabled,
    staleTime: 30_000,
  });
}
/** Manual content revisions; kernel mode returns the full list in one page. */
export function useMessageRevisions(
  chatId: string | undefined,
  messageId: string | undefined,
  enabled: boolean,
) {
  return useInfiniteQuery({
    queryKey: ['message-revisions', chatId, messageId],
    queryFn: ({ pageParam }) =>
      readMessageRevisions(chatId as string, messageId as string, pageParam as string | undefined),
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
  /** Archived text to restore as the active content (kernel mode needs it). */
  content: string;
  /** Legacy-only CAS guard; ignored by the kernel mode mapping. */
  expectedRevision: number;
}

/** Restore a manual edit while preserving the current text as a new revision. */
export function useRestoreMessageRevision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RestoreMessageRevisionInput) =>
      restoreMessageRevision(
        input.chatId,
        input.messageId,
        input.revisionId,
        input.content,
        input.expectedRevision,
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
    queryFn: () => {
      // Kernel plane: the wallpaper catalog is a legacy filesystem contour
      // (`data/files/backgrounds/`, sidecar-owned); the kernel owns no
      // backgrounds capability — honest empty list (ТЗ §13.1), never a
      // silent legacy request (ARC-02).
      if (isKernelMode()) {
        return Promise.resolve<BackgroundList>({ items: [] });
      }
      return api.get<BackgroundList>('/backgrounds');
    },
    staleTime: 30_000,
  });
}

export function useUploadBackground() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      // Kernel plane: no backgrounds capability → honest
      // CAPABILITY_UNAVAILABLE (ТЗ §13.1), never a silent legacy upload.
      if (isKernelMode()) {
        return Promise.reject(new UnsupportedError('backgrounds.upload'));
      }
      return api.upload<BackgroundItem>('/backgrounds', file);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['backgrounds'] }),
  });
}

export function useDeleteBackground() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => {
      // Kernel plane: same honest CAPABILITY_UNAVAILABLE as upload.
      if (isKernelMode()) {
        return Promise.reject(new UnsupportedError('backgrounds.delete'));
      }
      return api.del<{ ok: boolean }>(`/backgrounds/${encodeURIComponent(id)}`);
    },
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
    queryFn: () => readPresets(kind),
  });
}

export function useCreatePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PresetCreate) => createPreset(input),
    onSuccess: (preset) => void qc.invalidateQueries({ queryKey: ['presets', preset.kind] }),
  });
}

export function useUpdatePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: { id: string; update: PresetUpdate }) => updatePreset(id, update),
    onSuccess: (preset) => void qc.invalidateQueries({ queryKey: ['presets', preset.kind] }),
  });
}

export function useDeletePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; kind: string }) => deletePreset(id),
    onSuccess: (_result, variables) =>
      void qc.invalidateQueries({ queryKey: ['presets', variables.kind] }),
  });
}

/* Memories (Этап 4 slice 3, ТЗ §4.4 Memory/RAG) ----------------------------- */

export function useMemories(filter?: {
  scope?: 'global' | 'character';
  characterId?: string;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ['memories', filter],
    queryFn: () => readMemories(filter),
  });
}

export function useCreateMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MemoryCreate) => createMemory(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['memories'] }),
  });
}

export function useUpdateMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: { id: string; update: MemoryUpdate }) => updateMemory(id, update),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['memories'] }),
  });
}

export function useDeleteMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteMemory(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['memories'] }),
  });
}

/* Personas ----------------------------------------------------------------- */

export function usePersonas() {
  return useQuery({
    queryKey: ['personas'],
    queryFn: async () => ({ items: await readPersonas() }),
  });
}

export function useCreatePersona() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PersonaCreate) => createPersona(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['personas'] }),
  });
}

export function useUpdatePersona() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: { id: string; update: PersonaUpdate }) =>
      updatePersona(id, update),
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
    mutationFn: (id: string) => deletePersona(id),
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
    queryFn: () => readLorebooks(query),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 2 * MINUTE,
  });
}

export function useLorebook(id: string | undefined) {
  return useQuery({
    queryKey: ['lorebook', id],
    queryFn: () => readLorebook(id as string),
    enabled: id !== undefined,
  });
}

export function useLorebookEntries(bookId: string | undefined) {
  return useQuery({
    queryKey: ['lorebooks', bookId, 'entries'],
    queryFn: async () => ({ items: await readLorebookEntries(bookId as string) }),
    enabled: bookId !== undefined,
  });
}

export function useCreateLorebook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LorebookCreate) => createLorebook(input),
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
      updateLorebook(id, update),
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
    mutationFn: (id: string) => deleteLorebook(id),
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
      createLorebookEntry(bookId, input),
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
    }) => updateLorebookEntry(bookId, entryId, update),
    onSuccess: (_entry, { bookId }) =>
      void qc.invalidateQueries({ queryKey: ['lorebooks', bookId, 'entries'] }),
  });
}

export function useDeleteLorebookEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ bookId, entryId }: { bookId: string; entryId: string }) =>
      deleteLorebookEntry(bookId, entryId),
    onSuccess: (_result, { bookId }) =>
      void qc.invalidateQueries({ queryKey: ['lorebooks', bookId, 'entries'] }),
  });
}

/* Settings ----------------------------------------------------------------- */

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => readSettings(),
    staleTime: 5 * MINUTE,
  });
}

export function useInstructFormats() {
  return useQuery({
    queryKey: ['instruct-formats'],
    queryFn: () => {
      // Kernel plane: the legacy instruct-format catalog is a sidecar
      // contour; the kernel pipeline owns its own rendering — honest empty
      // list (ТЗ §13.1), never a silent legacy request (ARC-02).
      if (isKernelMode()) {
        return Promise.resolve<InstructFormatListResponse>({ formats: [] });
      }
      return api.get<InstructFormatListResponse>('/settings/instruct-formats');
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (update: AppSettingsUpdate) => updateSettings(update),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings'] }),
  });
}

/* Themes ------------------------------------------------------------------- */

export function useThemes(enabled = true) {
  return useQuery({
    queryKey: ['themes'],
    queryFn: () => readThemes(),
    staleTime: 5 * MINUTE,
    enabled,
  });
}

export function useInstallTheme() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => installTheme(file),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['themes'] });
    },
  });
}

export function useActivateTheme() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => activateTheme(id),
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
    mutationFn: () => resetActiveTheme(),
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
    mutationFn: (id: string) => deleteTheme(id),
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
    queryFn: () => readPlugins(),
    staleTime: MINUTE,
  });
}

export function useInstallPlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => installPlugin(file),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

export function useInstallPluginFromGit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PluginGitInstallRequest) => installPluginFromGit(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

export function useActivatePlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: PluginActivateRequest }) =>
      activatePlugin(id, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

export function useDisablePlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => disablePlugin(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

export function useDeletePlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deletePlugin(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

export function useEnterPluginSafeMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => enterPluginSafeMode(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

export function useExitPluginSafeMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => exitPluginSafeMode(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

export function usePluginAuthConnections(pluginId: string | null) {
  return useQuery({
    queryKey: ['plugins', pluginId, 'auth-connections'],
    queryFn: () => readPluginAuthConnections(pluginId!),
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
      connectPluginAuth(pluginId, input),
    onSuccess: (result, vars) =>
      void qc.invalidateQueries({ queryKey: ['plugins', vars.pluginId, 'auth-connections'] }),
  });
}

export function usePluginAuthRevoke() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pluginId, input }: { pluginId: string; input: PluginAuthRevokeRequest }) =>
      revokePluginAuth(pluginId, input),
    onSuccess: (_, vars) =>
      void qc.invalidateQueries({ queryKey: ['plugins', vars.pluginId, 'auth-connections'] }),
  });
}

/* Complete data migration -------------------------------------------------- */

export function useAnalyzeSillyTavern() {
  return useMutation({
    mutationFn: ({ file, signal }: { file: File; signal: AbortSignal }) => {
      // Kernel plane: SillyTavern archive import is a legacy sidecar contour
      // (staged analyze/execute over `app.db` era data) — honest
      // CAPABILITY_UNAVAILABLE (ТЗ §13.1), never a silent legacy request
      // (ARC-02).
      if (isKernelMode()) {
        return Promise.reject(new UnsupportedError('imports.sillytavern.analyze'));
      }
      return api.upload<SillyTavernImportAnalysis>('/imports/sillytavern/analyze', file, signal);
    },
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
    }) => {
      // Kernel plane: same honest CAPABILITY_UNAVAILABLE as analyze.
      if (isKernelMode()) {
        return Promise.reject(new UnsupportedError('imports.sillytavern.execute'));
      }
      return api.post<SillyTavernImportResult>(
        `/imports/sillytavern/${analysisId}/execute`,
        input,
        signal,
      );
    },
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
    mutationFn: (analysisId: string) => {
      // Kernel plane: same honest CAPABILITY_UNAVAILABLE as analyze.
      if (isKernelMode()) {
        return Promise.reject(new UnsupportedError('imports.sillytavern.discard'));
      }
      return api.del<void>(`/imports/sillytavern/${analysisId}`);
    },
  });
}

/* Backups (ARCH-06: server state belongs in TanStack Query) ---------------- */

export function useBackups() {
  return useQuery({
    queryKey: ['backups'],
    queryFn: async () => {
      // Kernel plane: wire `backups.list`. The kernel models no auto/manual
      // split — every kernel backup is user-initiated (`backups.create`), so
      // `kind` maps to the honest 'manual' (never fabricated as 'auto').
      if (isKernelMode()) {
        const result = await backend.backups.list();
        return result.items.map((dto) => ({
          id: dto.id,
          kind: 'manual' as const,
          createdAt: Date.parse(dto.createdAt),
          sizeBytes: dto.sizeBytes,
        }));
      }
      return (await api.get<{ items: Backup[] }>('/backups')).items;
    },
  });
}

export function useCreateBackup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<Backup> => {
      // Kernel plane: wire `backups.create` (user-initiated, so 'manual').
      if (isKernelMode()) {
        const dto = await backend.backups.create();
        return {
          id: dto.id,
          kind: 'manual',
          createdAt: Date.parse(dto.createdAt),
          sizeBytes: dto.sizeBytes,
        };
      }
      return api.post<Backup>('/backups');
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['backups'] }),
  });
}

export function useRestoreBackup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => {
      // Kernel plane: restore is the maintenance-lock operation (ТЗ §10.4,
      // security.restore-maintenance-lock) — the wire contract has no
      // restore op yet, so this is an honest CAPABILITY_UNAVAILABLE (ТЗ
      // §13.1), never a silent legacy request (ARC-02).
      if (isKernelMode()) {
        return Promise.reject(new UnsupportedError('backups.restore'));
      }
      return api.post<{ restored: boolean; restartRequired: boolean }>(
        `/backups/${encodeURIComponent(id)}/restore`,
      );
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['backups'] }),
  });
}

/* Diagnostics (ARCH-06) ----------------------------------------------------- */

export function useDiagnostics() {
  return useQuery({
    queryKey: ['diagnostics'],
    // Kernel plane: the legacy DiagnosticsSnapshot does not exist there — the
    // panel maps the kernel bundle (useKernelDiagnostics) instead. Returning
    // null without a network call keeps kernel mode free of silent legacy
    // requests (ARC-02).
    queryFn: () => (isKernelMode() ? null : api.get<DiagnosticsSnapshot>('/diagnostics')),
  });
}

/**
 * Kernel diagnostics bundle (wire `diagnostics.export`, SEC-07 allowlist).
 * The bundle is intentionally NOT the legacy DiagnosticsSnapshot: it carries
 * versions/counts only, so the panel maps the two planes honestly instead of
 * fabricating legacy fields from kernel data.
 */
export function useKernelDiagnostics() {
  return useQuery({
    queryKey: ['kernel-diagnostics'],
    queryFn: () => backend.diagnostics.export(),
    retry: false,
    staleTime: 60_000,
  });
}

export function useRebuildSearch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      // Kernel plane: the kernel owns the search index; the legacy rebuild
      // route does not exist there — honest CAPABILITY_UNAVAILABLE (ТЗ
      // §13.1), never a silent legacy request (ARC-02). The DiagnosticsPanel
      // also disables the action in kernel mode.
      if (isKernelMode()) {
        return Promise.reject(new UnsupportedError('search.rebuild'));
      }
      return api.post('/search/rebuild');
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['diagnostics'] }),
  });
}

export function useClearDiagnosticCache() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      // Kernel plane: no legacy diagnostic cache to clear — honest
      // CAPABILITY_UNAVAILABLE (ТЗ §13.1), never a silent legacy request
      // (ARC-02). The DiagnosticsPanel also disables the action in kernel
      // mode.
      if (isKernelMode()) {
        return Promise.reject(new UnsupportedError('diagnostics.cache'));
      }
      return api.del<CacheCleanupResult>('/diagnostics/cache');
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['diagnostics'] }),
  });
}
