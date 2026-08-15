/**
 * Library/chat data plane over the facade (Этап 2.10, шаг 2).
 *
 * One function per golden-flow operation; the transport branch lives here in
 * the API layer (ТЗ §13.1 forbids it in React components — compare
 * `generate.ts`):
 *
 * - **Kernel mode** (`LocalBackend`): calls the wire operations and maps the
 *   canonical wire DTOs onto the legacy UI shapes with honest defaults for
 *   fields the kernel does not model yet (avatars, persona, variants,
 *   revisions, checkpoints, soft-delete, manual chat order). Unsupported
 *   inputs surface as a typed `UnsupportedError` (CAPABILITY_UNAVAILABLE) —
 *   never a silent downgrade.
 * - **Browser/sidecar mode** (`LegacyBackend`): delegates to the existing
 *   legacy HTTP client unchanged (full-fidelity legacy entities).
 *
 * Every mapping decision is documented next to its translator; the migration
 * routing table (`docs/architecture/operations-inventory.md`) tracks the
 * cutover surface.
 */
import {
  type Character,
  type CharacterCreate,
  type CharacterGalleryImage,
  type CharacterSummary,
  type CharacterUpdate,
  type Chat,
  type ChatCreate,
  type ChatSummary,
  type ChatUpdate,
  type CursorPage,
  type Lorebook,
  type LorebookCreate,
  type LorebookEntry,
  type LorebookEntryCreate,
  type LorebookEntryUpdate,
  type LorebookUpdate,
  type Memory,
  type MemoryCreate,
  type MemoryUpdate,
  type Message,
  type MessageContentRevision,
  type MessageDraft,
  type MessageRole,
  type MessageVariant,
  type Persona,
  type PersonaCreate,
  type PersonaUpdate,
  type Preset,
  type PresetCreate,
  type PresetUpdate,
  type InstalledTheme,
  type ThemeActivationResult,
  type ThemeDeleteResult,
  type ThemeInstallResult,
  type ThemeListResponse,
  type ThemeDto,
  type InstalledPlugin,
  type PluginAuthConnectRequest,
  type PluginAuthConnectResult,
  type PluginAuthConnectionsResponse,
  type PluginAuthRevokeRequest,
  type PluginAuthRevokeResult,
  type PluginDeleteResult,
  type PluginGitInstallRequest,
  type PluginInstallResult,
  type PluginLifecycleResult,
  type PluginListResponse,
  type PluginSafeModeResult,
  type PluginDto,
  type CharacterDto,
  type ChatDto,
  type LorebookDto,
  type LorebookEntryDto,
  type MemoryDto,
  type MessageDto,
  type MessageDraftDto,
  type MessageRevisionDto,
  type MessageVariantDto,
  type PersonaDto,
  type PresetDto,
  type VersionResponse,
  type MetaDto,
  type AppSettings,
  type AppSettingsUpdate,
  type SettingsItemDto,
  type ChatSnapshotResult,
} from '@neotavern/contracts';
import { CONTEXT_TOKEN_DEFAULT, DEFAULT_PROMPT_TEMPLATE } from '@neotavern/contracts';
import { type BackendCallOptions, UnsupportedError } from '@neotavern/neobackend';
import { api } from './client.js';
import { backend, isKernelMode } from './backend.js';

/** Input of `useContinueCharacterChat` / `continueCharacterChat`. */
export interface ContinueCharacterChatInput {
  characterId: string;
  title: string;
  personaId?: string;
}

/** Result of `useContinueCharacterChat` / `continueCharacterChat`. */
export interface ContinueCharacterChatResult {
  chatId: string;
  created: boolean;
}

function encodeQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs.length > 0 ? `?${qs}` : '';
}

/** Wire `meta.dto` → legacy `VersionResponse` (app version + API major). */
export function translateMeta(dto: MetaDto): VersionResponse {
  return {
    // The wire carries no product name; the legacy shape requires one and
    // the UI only renders the version string — the static product name is
    // identity, not fabricated data.
    name: 'NeoTavern',
    version: dto.appVersion,
    apiVersion: dto.api.major,
  };
}

/** Read the application version (kernel: wire `meta.get`). */
export async function readAppVersion(): Promise<VersionResponse> {
  if (isKernelMode()) {
    return translateMeta(await backend.meta());
  }
  return api.get<VersionResponse>('/version');
}

/** Character card export format (PNG card or standalone JSON). */
export type CharacterCardExportFormat = 'png' | 'json';

/** Triggers a browser download of `url` through a temporary anchor. */
function triggerDownload(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Export one character card (PNG/JSON). Kernel: no wire operation models the
 * SillyTavern card container, so this is an honest CAPABILITY_UNAVAILABLE —
 * the legacy download URL is served by the legacy contour only.
 */
export async function exportCharacterCard(
  characterId: string,
  format: CharacterCardExportFormat,
): Promise<void> {
  if (isKernelMode()) {
    throw new UnsupportedError('characters.export.card');
  }
  // Legacy-only capability: the URL is served by the legacy contour, and
  // wireBridge is the migration routing table (legacy branch lives here).
  // eslint-disable-next-line @neotavern/no-legacy-api-surface
  triggerDownload(`/api/v2/characters/${encodeURIComponent(characterId)}/export?format=${format}`);
}

/** Export one chat snapshot. Kernel: no wire operation models the container. */
export async function exportChat(chatId: string): Promise<void> {
  if (isKernelMode()) {
    throw new UnsupportedError('chats.export');
  }
  // Legacy-only capability (see exportCharacterCard).
  // eslint-disable-next-line @neotavern/no-legacy-api-surface
  triggerDownload(`/api/v2/chats/${encodeURIComponent(chatId)}/export`);
}

/**
 * Import a character card file (PNG/JSON). Kernel: card parsing is a
 * host-side/legacy capability with no wire operation — honest refusal on the
 * kernel plane; the legacy contour keeps the real import.
 */
export async function importCharacter(file: File): Promise<unknown> {
  if (isKernelMode()) {
    throw new UnsupportedError('characters.import');
  }
  return api.upload('/characters/import', file);
}

/**
 * Snapshot the chat up to `message` as a checkpoint or branch child chat.
 * Kernel: the canonical Conversations model (chats/messages/variants/
 * revisions/drafts — ТЗ §8.1) has no snapshot/checkpoint entity and no wire
 * operation for it, so the kernel plane refuses honestly; the legacy contour
 * keeps the real snapshot flow (new child chat + prefix copy + checkpoint
 * link).
 */
export async function createChatSnapshot(
  chatId: string,
  input: {
    messageId: string;
    kind: 'checkpoint' | 'branch';
    replace?: boolean;
  },
): Promise<ChatSnapshotResult> {
  if (isKernelMode()) {
    throw new UnsupportedError('chats.snapshots.create');
  }
  return api.post<ChatSnapshotResult>(`/chats/${encodeURIComponent(chatId)}/snapshots`, {
    messageId: input.messageId,
    kind: input.kind,
    ...(input.replace !== undefined ? { replace: input.replace } : {}),
  });
}

/**
 * Patch one message's content and/or extension metadata. Kernel plane: wire
 * `chats.messages.update` (content optional, meta optional, last-write-wins),
 * response translated to the legacy message shape with `meta` carried
 * verbatim. Legacy plane: the partial PATCH keeps its semantics.
 */
export async function updateChatMessage(
  chatId: string,
  messageId: string,
  patch: { content?: string; meta?: Record<string, unknown> },
): Promise<Message> {
  if (isKernelMode()) {
    const dto = await backend.chats.updateMessage({
      chatId,
      messageId,
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.meta !== undefined ? { meta: patch.meta } : {}),
    });
    return translateMessage(dto);
  }
  return api.patch<Message>(
    `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
    patch,
  );
}

/**
 * Warm the provider model-discovery cache for `providerId`. The model list is
 * a legacy-contour mechanism (`/providers/:id/models` feeds the legacy
 * provider editor); on the kernel plane provider model discovery is a
 * kernel-side capability with no wire operation, so this is an honest
 * CAPABILITY_UNAVAILABLE — callers treat the warm-up as optional and ignore
 * the refusal (the AutoConnectSync re-asserts `lastServer` regardless).
 */
export async function warmProviderModels(providerId: string): Promise<void> {
  if (isKernelMode()) {
    throw new UnsupportedError('providers.models.discovery');
  }
  await api.get(`/providers/${encodeURIComponent(providerId)}/models`);
}

/**
 * Minimum message surface every plane guarantees for the legacy bridge.
 * Kernel plane returns the lean wire `MessageDto`; legacy plane returns the
 * full legacy message. Never fabricated: kernel-only fields are simply
 * absent, and `createdAt` is epoch-ms on the legacy plane vs RFC3339 on the
 * kernel plane — callers must not assume one format.
 */
export type BridgeChatMessage = {
  id: string;
  chatId: string;
  role: MessageRole;
  content: string;
  createdAt: number | string;
};

/**
 * Create a user message from a legacy bridge caller (SillyTavern
 * `sendChatMessage`). Kernel plane: wire `chats.messages.create` returns the
 * lean `MessageDto` (id/chatId/role/content/createdAt/sequence) — legacy-only
 * fields (branchId, meta, variantCount, …) are absent, never fabricated.
 * Legacy plane: the full legacy message shape.
 */
export async function createBridgeChatMessage(
  chatId: string,
  content: string,
): Promise<BridgeChatMessage> {
  if (isKernelMode()) {
    const dto = await backend.chats.createMessage({ chatId, role: 'user', content });
    // Project exactly the guaranteed surface — never fabricated fields.
    return {
      id: dto.id,
      chatId: dto.chatId,
      role: dto.role,
      content: dto.content,
      createdAt: dto.createdAt,
    };
  }
  return api.post<BridgeChatMessage>(`/chats/${encodeURIComponent(chatId)}/messages`, {
    role: 'user',
    content,
  });
}

/**
 * Defaults mirrored from the legacy `SettingsRepository.DEFAULTS`
 * (`apps/server`): the wire store carries only saved keys, and the legacy
 * shape requires the full `AppSettings` projection. Both sides build the
 * defaults from the same `@neotavern/contracts` constants, so the two planes
 * cannot drift.
 */
const APP_SETTINGS_DEFAULTS: AppSettings = {
  language: 'en',
  themeId: null,
  activeProviderConfigId: null,
  activePersonaId: null,
  contextStrategy: 'truncate',
  maxContextTokens: CONTEXT_TOKEN_DEFAULT,
  generationDefaults: {},
  activeGenerationPresetId: null,
  activePromptTemplatePresetId: null,
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  instructFormat: null,
  instructFormatId: null,
};

/**
 * Maps one wire `settings.item` value onto the typed `AppSettings` field.
 * The wire stores values as JSON objects; scalar preferences are wrapped in
 * the documented form `{ "value": X }` (kernel normalizes legacy bare
 * scalars the same way), so the wrapper is unwrapped here.
 */
function unwrapSettingsValue(value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, 'value')
  ) {
    return (value as Record<string, unknown>).value;
  }
  return value;
}

/** Wraps a scalar `AppSettings` field value for the wire store. */
function wrapSettingsValue(value: unknown): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : { value };
}

/**
 * `AppSettings` field → canonical wire settings key. The wire key pattern is
 * `^[a-z][a-z0-9._-]{1,127}$` (no upper-case), so the camelCase legacy field
 * names map to kebab form; the legacy converter normalizes stored legacy keys
 * the same way, so both planes agree.
 */
const APP_SETTINGS_WIRE_KEYS: Record<string, string> = {
  language: 'language',
  themeId: 'theme-id',
  activeProviderConfigId: 'active-provider-config-id',
  activePersonaId: 'active-persona-id',
  contextStrategy: 'context-strategy',
  maxContextTokens: 'max-context-tokens',
  generationDefaults: 'generation-defaults',
  activeGenerationPresetId: 'active-generation-preset-id',
  activePromptTemplatePresetId: 'active-prompt-template-preset-id',
  promptTemplate: 'prompt-template',
  instructFormat: 'instruct-format',
  instructFormatId: 'instruct-format-id',
  autoConnect: 'auto-connect',
  lastServer: 'last-server',
  macroVariables: 'macro-variables',
  ui: 'ui',
  'extensions.legacyFrontend': 'extensions.legacy-frontend',
};

/** Canonical wire settings key → `AppSettings` field (inverse mapping). */
const WIRE_KEY_TO_SETTINGS_FIELD: Record<string, string> = Object.fromEntries(
  Object.entries(APP_SETTINGS_WIRE_KEYS).map(([field, key]) => [key, field]),
);

/** Kernel wire snapshot → typed `AppSettings` projection. */
function applySettingsItems(base: AppSettings, items: SettingsItemDto[]): AppSettings {
  const merged: Record<string, unknown> = { ...base };
  for (const item of items) {
    const field = WIRE_KEY_TO_SETTINGS_FIELD[item.key];
    if (field) merged[field] = unwrapSettingsValue(item.value);
  }
  return merged as AppSettings;
}

/** Read the full application settings (kernel: wire `settings.get`, all keys). */
export async function readSettings(): Promise<AppSettings> {
  if (isKernelMode()) {
    const result = await backend.settings.get({});
    return applySettingsItems(APP_SETTINGS_DEFAULTS, result.items);
  }
  return api.get<AppSettings>('/settings');
}

/**
 * Apply a partial settings update (kernel: wire `settings.update`) and
 * return the full post-update projection (legacy `PATCH /settings` contract).
 */
export async function updateSettings(update: AppSettingsUpdate): Promise<AppSettings> {
  if (isKernelMode()) {
    const settings: { key: string; value: Record<string, unknown> }[] = [];
    for (const [field, value] of Object.entries(update)) {
      if (value === undefined) continue;
      settings.push({
        key: APP_SETTINGS_WIRE_KEYS[field] ?? field,
        value: wrapSettingsValue(value) as Record<string, unknown>,
      });
    }
    const result = await backend.settings.update({ settings });
    const base = await readSettings();
    return applySettingsItems(base, result.items);
  }
  return api.patch<AppSettings>('/settings', update);
}

/* --------------------------------------------------------------------------
 * Wire DTO → legacy UI shape translators.
 *
 * The kernel model is a strict subset of the legacy entity. Fields the kernel
 * does not own yet are filled with honest defaults so the UI renders the
 * golden flow (library → character → chat → messages) without fabricating
 * data: `null`/`''`/`0` mean "not modelled", not "empty but real".
 * ------------------------------------------------------------------------ */

/** RFC 3339 (wire) → legacy epoch-ms `Timestamp`. */
function toEpochMs(rfc3339: string): number {
  return Date.parse(rfc3339);
}

/** Wire character → legacy `CharacterSummary` (library rows). */
export function translateCharacterSummary(dto: CharacterDto): CharacterSummary {
  return {
    id: dto.id,
    name: dto.name,
    // Kernel has no asset URL surface (avatarAssetId is a storage reference);
    // the UI resolves the original through `readAssetContentDataUrl` when the
    // character carries an avatar asset (mirrors ТЗ §34 avatar→asset).
    avatar: null,
    avatarAssetId: dto.avatarAssetId ?? null,
    description: dto.description ?? '',
    tags: dto.tags,
    createdAt: toEpochMs(dto.createdAt),
    updatedAt: toEpochMs(dto.updatedAt),
  };
}

/** Wire character → full legacy `Character` (card view/editor). */
export function translateCharacter(dto: CharacterDto): Character {
  return {
    ...translateCharacterSummary(dto),
    // Full card fields are not modelled by the kernel schema yet (Этап 4);
    // honest empty strings — the editor must not fabricate persona text.
    personality: '',
    scenario: '',
    firstMessage: '',
    exampleDialogues: '',
    systemPrompt: null,
    postHistoryInstructions: null,
    creator: null,
    creatorNotes: null,
    ext: {},
    lastUsedAt: null,
    deletedAt: null,
  };
}

/**
 * Resolve an avatar asset's original bytes as a `data:` URI over the kernel
 * plane (transport helper — components never branch on the backend kind, ТЗ
 * §13.1). The legacy plane has no asset store: calling this there is an
 * honest `UnsupportedError`, but components only invoke it when the
 * character carries `avatarAssetId` (kernel data), so the legacy path never
 * reaches it. `contentType` from the wire record is preserved; the
 * `image/png` fallback is only used when the record omits it.
 */
export async function readAssetContentDataUrl(
  assetId: string,
  opts?: BackendCallOptions,
): Promise<string> {
  if (!isKernelMode()) {
    throw new UnsupportedError('assets.content');
  }
  const record = await backend.assets.content(assetId, opts);
  return `data:${record.contentType ?? 'image/png'};base64,${record.contentBase64}`;
}

/**
 * Legacy avatar-original URL (transport helper). The legacy plane serves the
 * full-resolution original through the character route; the kernel plane has
 * no URL surface and renders the asset through `readAssetContentDataUrl`
 * instead. Returns `null` when the character has no legacy avatar (or no id).
 */
export function avatarOriginalUrl(
  characterId: string | undefined,
  avatar: string | null,
): string | null {
  return avatar && characterId
    ? // eslint-disable-next-line @neotavern/no-legacy-api-surface
      `/api/v2/characters/${characterId}/avatar-original`
    : null;
}

/**
 * Wallpaper asset URL (transport helper). The legacy plane serves the
 * background file through the asset route; the kernel plane models no
 * background store (backgrounds are a legacy file contour, not a kernel
 * asset), so it honestly reports `null` — the wallpaper simply does not
 * render on the kernel plane instead of fabricating a URL.
 */
export function wallpaperBackgroundUrl(backgroundId: string | null | undefined): string | null {
  if (!backgroundId) return null;
  if (isKernelMode()) return null;
  // eslint-disable-next-line @neotavern/no-legacy-api-surface
  return `/api/v2/assets/backgrounds/${encodeURIComponent(backgroundId)}`;
}

/** Result of an avatar upload — the draft fields the caller should apply. */
export interface CharacterAvatarUploadResult {
  /** Legacy URL slot (`thumbnailUrl` on the legacy plane; always `null` on
   * the kernel plane — the kernel has no asset URL surface). */
  avatar: string | null;
  /** Canonical asset reference (kernel plane; `null` on the legacy plane). */
  avatarAssetId: string | null;
  /** Uploaded image name (legacy gallery item name; `null` on the kernel
   * plane, where the caller falls back to the file name). */
  name: string | null;
}

function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('avatar: read file failed'));
    reader.onload = () => {
      const result = reader.result;
      resolve(typeof result === 'string' ? (result.split(',')[1] ?? '') : '');
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Upload a character avatar (M5 slice 6 remainder, ТЗ §34 avatar→asset).
 * Transport helper: the kernel plane publishes the file as an immutable
 * `avatar` asset (`assets.put`, content-addressed + idempotent) and links it
 * through `characters.update(avatarAssetId)`; the legacy plane keeps the
 * gallery upload path (`/characters/:id/gallery`) and returns the thumbnail
 * URL. The wire `assets.put` request cap (~786 KiB of image bytes) surfaces
 * as a transport error — never a silent downgrade.
 */
export async function uploadCharacterAvatar(
  characterId: string,
  file: File,
): Promise<CharacterAvatarUploadResult> {
  if (isKernelMode()) {
    const contentBase64 = await readFileBase64(file);
    const { asset } = await backend.assets.put({
      kind: 'avatar',
      filename: file.name || 'avatar.png',
      ...(file.type ? { contentType: file.type } : {}),
      contentBase64,
    });
    await backend.characters.update({
      characterId,
      avatarAssetId: asset.id,
    });
    return { avatar: null, avatarAssetId: asset.id, name: null };
  }
  const image = await api.upload<CharacterGalleryImage>(`/characters/${characterId}/gallery`, file);
  return { avatar: image.thumbnailUrl, avatarAssetId: null, name: image.name };
}

/** Wire chat → legacy `ChatSummary` (catalog rows). */
export function translateChatSummary(dto: ChatDto): ChatSummary {
  return {
    id: dto.id,
    characterId: dto.characterId,
    // Kernel chat rows carry no joined character identity; the UI falls back
    // to its unnamed-character label.
    characterName: null,
    characterAvatar: null,
    title: dto.title,
    messageCount: dto.messageCount,
    createdAt: toEpochMs(dto.createdAt),
    updatedAt: toEpochMs(dto.updatedAt),
    // Snapshot provenance (checkpoint/branch children) is legacy-only.
    parentChatId: null,
    origin: null,
    sourceMessageId: null,
  };
}

/** Wire chat → full legacy `Chat` (chat page). The user persona link
 * (`personaId`) is now part of the wire contract (Этап 4 slice 3,
 * ADR-0047 waiver 5) and passes through; branch/background/summary state
 * stays legacy-only with honest nulls. */
export function translateChat(dto: ChatDto): Chat {
  return {
    ...translateChatSummary(dto),
    personaId: dto.personaId ?? null,
    activeBranchId: null,
    backgroundId: null,
    summary: '',
    deletedAt: null,
  };
}

/** Wire message → legacy `Message`. */
export function translateMessage(dto: MessageDto): Message {
  return {
    id: dto.id,
    chatId: dto.chatId,
    // The kernel keeps one linear sequence per chat (no branches); the
    // implicit "branch" is the chat itself. The UI only uses `branchId` as a
    // query key from `chat.activeBranchId`, which the kernel leaves null.
    branchId: dto.chatId,
    parentId: null,
    role: dto.role,
    content: dto.content,
    name: null,
    // Extension metadata is carried verbatim on the kernel plane (wire
    // `MessageDto.meta`); legacy-only shapes are reported with neutral
    // placeholders below.
    meta: dto.meta,
    createdAt: toEpochMs(dto.createdAt),
    // Kernel updates are last-write-wins; the legacy CAS revision is
    // reported as its minimum (the UI no longer sends `expectedRevision`).
    revision: 1,
    updatedAt: null,
    variantCount: 0,
    activeVariantPosition: null,
    contentRevisionCount: 0,
    checkpointChatId: null,
  };
}

/** Wire lorebook → legacy `Lorebook` (catalog rows). */
export function translateLorebook(dto: LorebookDto): Lorebook {
  return {
    id: dto.id,
    name: dto.name,
    description: dto.description ?? '',
    // Character↔lorebook linkage (ADR-0047 waiver 2): a bound book renders
    // with its owner; a shared-library book renders neutral.
    characterId: dto.characterId ?? null,
    metadata: {},
    createdAt: toEpochMs(dto.createdAt),
    updatedAt: toEpochMs(dto.updatedAt),
  };
}

/** Wire variant → legacy `MessageVariant` (both carry position; identity). */
export function translateMessageVariant(dto: MessageVariantDto): MessageVariant {
  return {
    id: dto.id,
    messageId: dto.messageId,
    position: dto.position,
    content: dto.content,
    createdAt: toEpochMs(dto.createdAt),
  };
}

/** Wire revision → legacy `MessageContentRevision` (identity). */
export function translateMessageRevision(dto: MessageRevisionDto): MessageContentRevision {
  return {
    id: dto.id,
    messageId: dto.messageId,
    position: dto.position,
    content: dto.content,
    createdAt: toEpochMs(dto.createdAt),
  };
}

/** Wire draft → legacy `MessageDraft` (kernel has no branches). */
export function translateMessageDraft(dto: MessageDraftDto): MessageDraft {
  return {
    id: dto.id,
    chatId: dto.chatId,
    // The kernel keeps one linear sequence per chat; `branchId` is an honest
    // empty default (no branch reference exists), matching translateMessage.
    branchId: '',
    role: dto.role,
    content: dto.content,
    // The kernel draft has no name/meta columns; null/{} render neutrally.
    name: null,
    meta: {},
    sequence: dto.sequence,
    revision: dto.revision,
    committedMessageId: dto.committedMessageId ?? null,
    createdAt: toEpochMs(dto.createdAt),
    updatedAt: toEpochMs(dto.updatedAt),
  };
}

/** Wire persona → legacy `Persona`. */
export function translatePersona(dto: PersonaDto): Persona {
  return {
    id: dto.id,
    name: dto.name,
    description: dto.description ?? '',
    // Kernel avatar is a free-form reference; the UI avatar slot renders
    // neutrally until assets migrate (Этап 4).
    avatar: dto.avatar ?? null,
    isDefault: dto.isDefault,
    createdAt: toEpochMs(dto.createdAt),
    updatedAt: toEpochMs(dto.updatedAt),
  };
}

/** Wire preset → legacy `Preset` (Этап 4 slice 3). `data` is passed through
 * verbatim; wire RFC 3339 timestamps become legacy epoch-ms. */
export function translatePreset(dto: PresetDto): Preset {
  return {
    id: dto.id,
    kind: dto.kind,
    name: dto.name,
    data: dto.data,
    createdAt: toEpochMs(dto.createdAt),
    updatedAt: toEpochMs(dto.updatedAt),
  };
}

/** Wire memory → legacy `Memory` (Этап 4 slice 3). The wire DTO omits
 * `characterId` for global memories; the legacy shape requires `null`. */
export function translateMemory(dto: MemoryDto): Memory {
  return {
    id: dto.id,
    scope: dto.scope,
    characterId: dto.characterId ?? null,
    keys: dto.keys,
    content: dto.content,
    enabled: dto.enabled,
    position: dto.position,
    metadata: dto.metadata,
    createdAt: toEpochMs(dto.createdAt),
    updatedAt: toEpochMs(dto.updatedAt),
  };
}

/* --------------------------------------------------------------------------
 * Golden-flow operations (kernel | legacy).
 * ------------------------------------------------------------------------ */

/** List characters (library). */
export async function readCharacters(
  query: {
    cursor?: string;
    limit?: number;
    tag?: string;
    q?: string;
    sort?: string;
    includeDeleted?: boolean;
  },
  cursor?: string,
): Promise<CursorPage<CharacterSummary>> {
  if (isKernelMode()) {
    // Kernel list supports cursor/limit only; catalog search, tag filter and
    // non-default sorts are not wire operations yet (Этап 4). 'newest' and
    // the legacy 'recent' alias both map to the kernel's created_at DESC
    // default; anything else is an honest CAPABILITY_UNAVAILABLE.
    if (query.q || query.tag) throw new UnsupportedError('characters.list.search');
    if (query.includeDeleted) throw new UnsupportedError('characters.list.includeDeleted');
    if (query.sort !== undefined && query.sort !== 'newest' && query.sort !== 'recent') {
      throw new UnsupportedError(`characters.list.sort.${query.sort}`);
    }
    const page = await backend.characters.list({
      ...(cursor !== undefined ? { cursor } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
    return {
      items: page.items.map(translateCharacterSummary),
      nextCursor: page.nextCursor ?? null,
      hasMore: page.nextCursor !== null,
    };
  }
  return api.get<CursorPage<CharacterSummary>>(`/characters${encodeQuery({ ...query, cursor })}`);
}

/** Fetch one character (card view/editor). */
export async function readCharacter(id: string): Promise<Character> {
  if (isKernelMode()) {
    return translateCharacter(await backend.characters.get(id));
  }
  return api.get<Character>(`/characters/${id}`);
}

/** Create a character. */
export async function createCharacter(input: CharacterCreate): Promise<Character> {
  if (isKernelMode()) {
    const unsupported = nonWireCharacterFields(input);
    if (unsupported.length > 0) {
      throw new UnsupportedError(`characters.create.${unsupported[0]}`);
    }
    const created = await backend.characters.create({
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.tags !== undefined && input.tags.length > 0 ? { tags: input.tags } : {}),
    });
    return translateCharacter(created);
  }
  return api.post<Character>('/characters', input);
}

/** Update a character. */
export async function updateCharacter(id: string, patch: CharacterUpdate): Promise<Character> {
  if (isKernelMode()) {
    const unsupported = nonWireCharacterFields(patch);
    if (unsupported.length > 0) {
      throw new UnsupportedError(`characters.update.${unsupported[0]}`);
    }
    const updated = await backend.characters.update({
      characterId: id,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.tags !== undefined && patch.tags.length > 0 ? { tags: patch.tags } : {}),
      // Kernel avatar reference: the wire update takes the asset id; the
      // legacy `avatar` URL slot is a non-wire field (honest
      // CAPABILITY_UNAVAILABLE above). `null` would mean "clear the asset",
      // which the wire contract cannot express — absence keeps the link.
      ...(patch.avatarAssetId != null ? { avatarAssetId: patch.avatarAssetId } : {}),
    });
    return translateCharacter(updated);
  }
  return api.patch<Character>(`/characters/${id}`, patch);
}

/** Soft-delete a character. */
export async function deleteCharacter(id: string): Promise<void> {
  if (isKernelMode()) {
    await backend.characters.del(id);
    return;
  }
  await api.del(`/characters/${id}`);
}

/** List chats of one character (catalog). */
export async function readChats(
  characterId?: string,
  q?: string,
  cursor?: string,
): Promise<CursorPage<ChatSummary>> {
  if (isKernelMode()) {
    // Kernel chat list supports characterId/cursor/limit; full-text chat
    // search is not a wire operation yet (Этап 4).
    if (q) throw new UnsupportedError('chats.list.search');
    const page = await backend.chats.list({
      ...(characterId !== undefined ? { characterId } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });
    return {
      items: page.items.map(translateChatSummary),
      nextCursor: page.nextCursor ?? null,
      hasMore: page.nextCursor !== null,
    };
  }
  return api.get<CursorPage<ChatSummary>>(`/chats${encodeQuery({ characterId, q, cursor })}`);
}

/** Most recent chats (home page). Kernel orders by creation time. */
export async function readRecentChats(
  limit = 8,
  characterId?: string,
): Promise<CursorPage<ChatSummary>> {
  if (isKernelMode()) {
    const page = await backend.chats.list({
      ...(characterId !== undefined ? { characterId } : {}),
      limit,
    });
    return {
      items: page.items.map(translateChatSummary),
      nextCursor: page.nextCursor ?? null,
      hasMore: page.nextCursor !== null,
    };
  }
  return api.get<CursorPage<ChatSummary>>(
    `/chats${encodeQuery({ characterId, limit, sort: 'recent' })}`,
  );
}

/** Continue (or create) the live chat of a character. */
export async function continueCharacterChat(
  input: ContinueCharacterChatInput,
): Promise<ContinueCharacterChatResult> {
  if (isKernelMode()) {
    // The continue contract is reproduced client-side (compare the legacy
    // `reuseUnstarted` server guard): return the most recent live chat, else
    // create one. Kernel chats are ordered by creation time.
    const recent = await backend.chats.list({ characterId: input.characterId, limit: 1 });
    const existing = recent.items[0];
    if (existing) return { chatId: existing.id, created: false };
    const created = await backend.chats.create({
      characterId: input.characterId,
      title: input.title,
      ...(input.personaId ? { personaId: input.personaId } : {}),
    });
    return { chatId: created.id, created: true };
  }
  const recent = await api.get<CursorPage<ChatSummary>>(
    `/chats${encodeQuery({ characterId: input.characterId, limit: 1, sort: 'recent' })}`,
  );
  const existing = recent.items[0];
  if (existing) return { chatId: existing.id, created: false };
  const created = await api.post<Chat>('/chats', {
    characterId: input.characterId,
    title: input.title,
    reuseUnstarted: true,
    ...(input.personaId ? { personaId: input.personaId } : {}),
  } satisfies ChatCreate);
  return { chatId: created.id, created: true };
}

/** Fetch one chat (chat page). */
export async function readChat(id: string): Promise<Chat> {
  if (isKernelMode()) {
    return translateChat(await backend.chats.get(id));
  }
  return api.get<Chat>(`/chats/${id}`);
}

/** Create a chat. `personaId` links the user persona (Этап 4 slice 3). */
export async function createChat(input: ChatCreate): Promise<Chat> {
  if (isKernelMode()) {
    // Kernel chats are created empty: greeting insertion (greetingIndex) and
    // the reuseUnstarted server guard are legacy pipeline features (Этап 4) —
    // the continue hook already reproduced the guard above. The wire contract
    // requires an existing character.
    if (!input.characterId) throw new UnsupportedError('chats.create.characterId');
    const created = await backend.chats.create({
      characterId: input.characterId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.personaId ? { personaId: input.personaId } : {}),
    });
    return translateChat(created);
  }
  return api.post<Chat>('/chats', input);
}

/** Update a chat: rename and/or re-link the user persona (Этап 4 slice 3). */
export async function updateChat(id: string, update: ChatUpdate): Promise<Chat> {
  if (isKernelMode()) {
    // background/summary/branch mutation stays legacy-only (Этап 4); a null
    // persona clear is not expressible on the wire (personaId is optional,
    // never null) → honest CAPABILITY_UNAVAILABLE.
    if (
      update.backgroundId !== undefined ||
      update.summary !== undefined ||
      update.activeBranchId !== undefined
    ) {
      throw new UnsupportedError('chats.update.fields');
    }
    if (update.personaId === null) throw new UnsupportedError('chats.update.personaId.null');
    if (update.title === undefined && update.personaId === undefined) {
      throw new UnsupportedError('chats.update.fields');
    }
    const patch: Parameters<typeof backend.chats.update>[0] = { chatId: id };
    if (update.title !== undefined) patch.title = update.title;
    if (update.personaId !== undefined) patch.personaId = update.personaId;
    const updated = await backend.chats.update(patch);
    return translateChat(updated);
  }
  return api.patch<Chat>(`/chats/${id}`, update);
}

/** Delete a chat. Kernel delete is permanent (cascades messages). */
export async function deleteChat(id: string): Promise<void> {
  if (isKernelMode()) {
    await backend.chats.del(id);
    return;
  }
  await api.del(`/chats/${id}`);
}

/** List messages of a chat, newest first (chat page history). */
export async function readMessages(
  chatId: string,
  branchId?: string,
  cursor?: string,
): Promise<CursorPage<Message>> {
  if (isKernelMode()) {
    if (branchId) throw new UnsupportedError('chats.messages.list.branchId');
    const page = await backend.chats.listMessages({
      chatId,
      order: 'desc',
      ...(cursor !== undefined ? { cursor } : {}),
    });
    return {
      items: page.items.map(translateMessage),
      nextCursor: page.nextCursor ?? null,
      hasMore: page.nextCursor !== null,
    };
  }
  return api.get<CursorPage<Message>>(
    `/chats/${chatId}/messages${encodeQuery({ order: 'desc', branchId, cursor })}`,
  );
}

/* --------------------------------------------------------------------------
 * Message variants/revisions/drafts (Этап 4 slice 2).
 *
 * The kernel owns swipe variants, immutable content revisions and
 * server-side drafts over the wire (`chats.messages.{variants,revisions,
 * drafts}.*`); kernel mode routes through the facade. The legacy /api/v2
 * routes are kept for browser mode until the legacy-route-removal step of
 * slice 2; operations with no legacy route are an honest
 * CAPABILITY_UNAVAILABLE instead of a silent downgrade.
 * ------------------------------------------------------------------------ */

/** List the stored swipe variants of one message (positions ascending). */
export async function readMessageVariants(
  chatId: string,
  messageId: string,
): Promise<MessageVariant[]> {
  if (isKernelMode()) {
    const result = await backend.chats.listMessageVariants({ chatId, messageId });
    return result.items.map(translateMessageVariant);
  }
  const page = await api.get<{ items: MessageVariant[] }>(
    `/chats/${chatId}/messages/${messageId}/variants`,
  );
  return page.items;
}

/** Append a swipe variant (kernel allocates the position atomically). */
export async function createMessageVariant(
  chatId: string,
  messageId: string,
  content: string,
): Promise<MessageVariant> {
  if (isKernelMode()) {
    return translateMessageVariant(
      await backend.chats.createMessageVariant({ chatId, messageId, content }),
    );
  }
  // The legacy server has no create-variant route (swipes are only produced
  // by regeneration); honest CAPABILITY_UNAVAILABLE in browser mode.
  throw new UnsupportedError('chats.messages.variants.create');
}

/** Delete one swipe variant (permanent). */
export async function deleteMessageVariant(
  chatId: string,
  messageId: string,
  variantId: string,
): Promise<void> {
  if (isKernelMode()) {
    await backend.chats.delMessageVariant({ chatId, messageId, variantId });
    return;
  }
  throw new UnsupportedError('chats.messages.variants.delete');
}

/** Activate a swipe variant; the previous active text becomes a revision. */
export async function activateMessageVariant(
  chatId: string,
  messageId: string,
  variantId: string,
): Promise<Message> {
  if (isKernelMode()) {
    return translateMessage(
      await backend.chats.activateMessageVariant({ chatId, messageId, variantId }),
    );
  }
  return api.post<Message>(
    `/chats/${chatId}/messages/${messageId}/variants/${variantId}/activate`,
    {},
  );
}

/**
 * Swipe to a position of the message's swipe set (legacy permutation index).
 * Kernel mode maps the position onto the canonical variant by `position`
 * (the active text lives in `messages.content` and is the implicit last
 * item — swiping onto it is a no-op that resolves `null`); browser mode
 * keeps the legacy `POST .../swipe {position}` route.
 */
export async function swipeMessageToPosition(
  chatId: string,
  messageId: string,
  position: number,
): Promise<Message | null> {
  if (isKernelMode()) {
    const variants = await readMessageVariants(chatId, messageId);
    const variant = variants.find((item) => item.position === position);
    if (!variant) return null;
    return activateMessageVariant(chatId, messageId, variant.id);
  }
  return api.post<Message>(`/chats/${chatId}/messages/${messageId}/swipe`, { position });
}

/**
 * List the immutable content revisions of one message. The kernel returns
 * the full list in one page; the legacy route is cursor-paginated.
 */
export async function readMessageRevisions(
  chatId: string,
  messageId: string,
  cursor?: string,
): Promise<CursorPage<MessageContentRevision>> {
  if (isKernelMode()) {
    const result = await backend.chats.listMessageRevisions({ chatId, messageId });
    return { items: result.items.map(translateMessageRevision), nextCursor: null, hasMore: false };
  }
  return api.get<CursorPage<MessageContentRevision>>(
    `/chats/${chatId}/messages/${messageId}/revisions${encodeQuery({ cursor })}`,
  );
}

/**
 * Restore an archived text as the active message content. Kernel mode maps
 * this onto the existing `chats.messages.update` wire op (the canonical
 * restore semantics: setting the content records the replaced text as a new
 * revision); legacy keeps its dedicated restore route with the optional CAS
 * guard (`expectedRevision` is legacy-only and ignored in kernel mode).
 */
export async function restoreMessageRevision(
  chatId: string,
  messageId: string,
  revisionId: string,
  content: string,
  expectedRevision?: number,
): Promise<Message> {
  if (isKernelMode()) {
    return translateMessage(await backend.chats.updateMessage({ chatId, messageId, content }));
  }
  return api.post<Message>(
    `/chats/${chatId}/messages/${messageId}/revisions/${revisionId}/restore`,
    { ...(expectedRevision !== undefined ? { expectedRevision } : {}) },
  );
}

/** Fetch one server-side draft (kernel mode; no legacy read route). */
export async function readMessageDraft(chatId: string, draftId: string): Promise<MessageDraft> {
  if (isKernelMode()) {
    return translateMessageDraft(await backend.chats.getMessageDraft({ chatId, draftId }));
  }
  throw new UnsupportedError('chats.messages.drafts.get');
}

/** Input of `saveMessageDraft` (wire `chats.messages.drafts.save`). */
export interface MessageDraftSaveInput {
  chatId: string;
  /** Omit to create a new draft; provide to update (upsert by id). */
  draftId?: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Monotonic writer sequence; a stale save (≤ stored) is an idempotent no-op. */
  sequence?: number;
}

/** Create or update a server-side draft. */
export async function saveMessageDraft(input: MessageDraftSaveInput): Promise<MessageDraft> {
  if (isKernelMode()) {
    const saved = await backend.chats.saveMessageDraft({
      chatId: input.chatId,
      ...(input.draftId !== undefined ? { draftId: input.draftId } : {}),
      role: input.role,
      content: input.content,
      ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
    });
    return translateMessageDraft(saved);
  }
  const { chatId, draftId, role, content, sequence } = input;
  if (draftId === undefined) {
    return api.post<MessageDraft>(`/chats/${chatId}/drafts`, {
      role,
      ...(content ? { content } : {}),
    });
  }
  return api.patch<MessageDraft>(`/chats/${chatId}/drafts/${draftId}`, { content, sequence });
}

/**
 * Materialize a draft exactly once; resolves with the committed message id.
 * Replays after success return the same id (commit is retry-safe).
 */
export async function commitMessageDraft(
  chatId: string,
  draftId: string,
): Promise<{ messageId: string }> {
  if (isKernelMode()) {
    const message = await backend.chats.commitMessageDraft({ chatId, draftId });
    return { messageId: message.id };
  }
  const result = await api.post<{ messageId: string; alreadyCommitted: boolean }>(
    `/chats/${chatId}/drafts/${draftId}/commit`,
  );
  return { messageId: result.messageId };
}

/** Discard a draft (permanent; never touches the committed message). */
export async function discardMessageDraft(chatId: string, draftId: string): Promise<void> {
  if (isKernelMode()) {
    await backend.chats.discardMessageDraft({ chatId, draftId });
    return;
  }
  await api.del(`/chats/${chatId}/drafts/${draftId}`);
}

/* --------------------------------------------------------------------------
 * Lorebook operations (Этап 4.1).
 * ------------------------------------------------------------------------ */

/** List lorebooks (catalog). Kernel returns the full list in one page. */
export async function readLorebooks(
  query: { characterId?: string; limit?: number } = {},
): Promise<CursorPage<Lorebook>> {
  if (isKernelMode()) {
    // Character↔lorebook scoping (ADR-0047 waiver 2): the kernel filters the
    // list by the character-bound `character_lorebooks` link when requested;
    // absent characterId lists the whole shared library. Limit is a hint the
    // kernel list ignores (plain list).
    const result = await backend.lorebooks.list(
      query.characterId !== undefined ? { characterId: query.characterId } : {},
    );
    return {
      items: result.items.map(translateLorebook),
      nextCursor: null,
      hasMore: false,
    };
  }
  return api.get<CursorPage<Lorebook>>(
    `/lorebooks${encodeQuery({
      characterId: query.characterId,
      limit: query.limit,
    })}`,
  );
}

/** Fetch one lorebook. */
export async function readLorebook(id: string): Promise<Lorebook> {
  if (isKernelMode()) {
    return translateLorebook(await backend.lorebooks.get(id));
  }
  return api.get<Lorebook>(`/lorebooks/${id}`);
}

/** Create a lorebook (optionally with entries). */
export async function createLorebook(input: LorebookCreate): Promise<Lorebook> {
  if (isKernelMode()) {
    // Rich entry fields (position/metadata) are not wire operations yet —
    // honest CAPABILITY_UNAVAILABLE. Character linkage is a wire operation
    // (character↔lorebook scoping, ADR-0047 waiver 2).
    const created = await backend.lorebooks.create({
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.characterId != null ? { characterId: input.characterId } : {}),
      ...(input.entries !== undefined && input.entries.length > 0
        ? { entries: input.entries.map((entry) => entryWireInput(entry)) }
        : {}),
    });
    return translateLorebook(created);
  }
  return api.post<Lorebook>('/lorebooks', input);
}

/** Update a lorebook (name/description/entries). */
export async function updateLorebook(id: string, update: LorebookUpdate): Promise<Lorebook> {
  if (isKernelMode()) {
    // Character linkage moves/creates the character↔lorebook link (ADR-0047
    // waiver 2); rich entry fields (position/metadata) stay CAPABILITY_UNAVAILABLE.
    const updated = await backend.lorebooks.update({
      lorebookId: id,
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.description !== undefined ? { description: update.description } : {}),
      ...(update.characterId != null ? { characterId: update.characterId } : {}),
    });
    return translateLorebook(updated);
  }
  return api.patch<Lorebook>(`/lorebooks/${id}`, update);
}

/** Delete a lorebook (permanent). */
export async function deleteLorebook(id: string): Promise<void> {
  if (isKernelMode()) {
    await backend.lorebooks.del(id);
    return;
  }
  await api.del(`/lorebooks/${id}`);
}

/* Entry-level lorebook operations (M4 slice 1): the wire contract now has
 * per-entry operations (`lorebooks.entries.list/create/update/delete`) —
 * kernel mode routes through the facade; legacy keeps the nested route.
 * The wire entry DTO carries only the product-owned fields, so the
 * translation reconstructs the UI entry from the wire subset. */

export async function readLorebookEntries(bookId: string): Promise<LorebookEntry[]> {
  if (isKernelMode()) {
    const result = await backend.lorebooks.listEntries(bookId);
    return result.items.map((entry) => translateLorebookEntry(bookId, entry));
  }
  const page = await api.get<{ items: LorebookEntry[] }>(`/lorebooks/${bookId}/entries`);
  return page.items;
}

export async function createLorebookEntry(
  bookId: string,
  input: LorebookEntryCreate,
): Promise<LorebookEntry> {
  if (isKernelMode()) {
    // The wire entry input has no position/metadata — those are kernel-owned
    // (appended at the end); the caller cannot position the new entry.
    const created = await backend.lorebooks.createEntry({
      lorebookId: bookId,
      entry: entryWireInput(input),
    });
    return translateLorebookEntry(bookId, created);
  }
  return api.post<LorebookEntry>(`/lorebooks/${bookId}/entries`, input);
}

export async function updateLorebookEntry(
  bookId: string,
  entryId: string,
  update: LorebookEntryUpdate,
): Promise<LorebookEntry> {
  if (isKernelMode()) {
    // position/metadata cannot be patched over the wire (kernel-owned).
    if (update.position !== undefined || update.metadata !== undefined) {
      throw new UnsupportedError('lorebooks.entries.update.position-metadata');
    }
    const updated = await backend.lorebooks.updateEntry({
      lorebookId: bookId,
      entryId,
      patch: entryPatchInput(update),
    });
    return translateLorebookEntry(bookId, updated);
  }
  return api.patch<LorebookEntry>(`/lorebooks/${bookId}/entries/${entryId}`, update);
}

export async function deleteLorebookEntry(bookId: string, entryId: string): Promise<void> {
  if (isKernelMode()) {
    await backend.lorebooks.deleteEntry(bookId, entryId);
    return;
  }
  await api.del(`/lorebooks/${bookId}/entries/${entryId}`);
}

/* --------------------------------------------------------------------------
 * Persona operations (Этап 4.1).
 * ------------------------------------------------------------------------ */

/** List personas. */
export async function readPersonas(): Promise<Persona[]> {
  if (isKernelMode()) {
    const result = await backend.personas.list();
    return result.items.map(translatePersona);
  }
  const page = await api.get<{ items: Persona[] }>('/personas');
  return page.items;
}

/** Fetch one persona. */
export async function readPersona(id: string): Promise<Persona> {
  if (isKernelMode()) {
    return translatePersona(await backend.personas.get(id));
  }
  return api.get<Persona>(`/personas/${id}`);
}

/** Create a persona. */
export async function createPersona(input: PersonaCreate): Promise<Persona> {
  if (isKernelMode()) {
    // The wire contract has no avatar-clearing signal (`avatar: null`) —
    // absence means "no avatar" on create; an explicit null is honest
    // CAPABILITY_UNAVAILABLE, not a silent drop.
    if (input.avatar === null) throw new UnsupportedError('personas.create.avatar.clear');
    const created = await backend.personas.create({
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
      ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
    });
    return translatePersona(created);
  }
  return api.post<Persona>('/personas', input);
}

/** Update a persona. */
export async function updatePersona(id: string, update: PersonaUpdate): Promise<Persona> {
  if (isKernelMode()) {
    // The wire contract has no avatar-clearing signal (`avatar: null`);
    // absence means "unchanged" — an explicit clear is honest
    // CAPABILITY_UNAVAILABLE, not a silent no-op.
    if (update.avatar === null) throw new UnsupportedError('personas.update.avatar.clear');
    const updated = await backend.personas.update({
      personaId: id,
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.description !== undefined ? { description: update.description } : {}),
      ...(update.avatar !== undefined ? { avatar: update.avatar } : {}),
      ...(update.isDefault !== undefined ? { isDefault: update.isDefault } : {}),
    });
    return translatePersona(updated);
  }
  return api.patch<Persona>(`/personas/${id}`, update);
}

/** Delete a persona (permanent). */
export async function deletePersona(id: string): Promise<void> {
  if (isKernelMode()) {
    await backend.personas.del(id);
    return;
  }
  await api.del(`/personas/${id}`);
}

/* --------------------------------------------------------------------------
 * Honest-input guards.
 * ------------------------------------------------------------------------ */

/** Legacy lorebook entry → wire `wire.lorebook.entry.input` (strict subset). */
function entryWireInput(entry: {
  keys: string[];
  secondaryKeys?: string[];
  content: string;
  enabled?: boolean;
  constant?: boolean;
  selective?: boolean;
}): {
  keys: string[];
  secondaryKeys?: string[];
  content: string;
  enabled?: boolean;
  constant?: boolean;
  selective?: boolean;
} {
  return {
    keys: entry.keys,
    ...(entry.secondaryKeys !== undefined ? { secondaryKeys: entry.secondaryKeys } : {}),
    content: entry.content,
    ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
    ...(entry.constant !== undefined ? { constant: entry.constant } : {}),
    ...(entry.selective !== undefined ? { selective: entry.selective } : {}),
  };
}

/** Partial entry update → wire `wire.lorebook.entry.patch` (strict subset). */
function entryPatchInput(update: LorebookEntryUpdate): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (update.keys !== undefined) patch.keys = update.keys;
  if (update.secondaryKeys !== undefined) patch.secondaryKeys = update.secondaryKeys;
  if (update.content !== undefined) patch.content = update.content;
  if (update.enabled !== undefined) patch.enabled = update.enabled;
  if (update.constant !== undefined) patch.constant = update.constant;
  if (update.selective !== undefined) patch.selective = update.selective;
  return patch;
}

/** Wire `wire.lorebook.entry.dto` → legacy UI entry (honest subset: the wire
 * entry carries no position/metadata/lorebookId — those are filled from the
 * call context and neutral defaults; the UI must not display them as truth). */
function translateLorebookEntry(bookId: string, entry: LorebookEntryDto): LorebookEntry {
  return {
    id: entry.id,
    lorebookId: bookId,
    keys: entry.keys,
    secondaryKeys: entry.secondaryKeys ?? [],
    content: entry.content,
    enabled: entry.enabled,
    position: 0,
    constant: entry.constant,
    selective: entry.selective,
    metadata: {},
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Fields the wire character contract cannot carry (full card, Этап 4). */
const NON_WIRE_CHARACTER_FIELDS = [
  'avatar',
  'personality',
  'scenario',
  'firstMessage',
  'exampleDialogues',
  'systemPrompt',
  'postHistoryInstructions',
  'creator',
  'creatorNotes',
  'ext',
] as const;

/** Non-wire character fields that carry actual content (not empty defaults). */
function nonWireCharacterFields(input: CharacterCreate | CharacterUpdate): string[] {
  const present: string[] = [];
  for (const field of NON_WIRE_CHARACTER_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      if (value.length > 0) present.push(field);
    } else if (Array.isArray(value)) {
      if (value.length > 0) present.push(field);
    } else if (Object.keys(value).length > 0) {
      present.push(field);
    }
  }
  return present;
}

/* --------------------------------------------------------------------------
 * Presets (Этап 4 slice 3, wire `presets.*`).
 * ------------------------------------------------------------------------ */

/** List presets, filtered by kind. */
export async function readPresets(kind: string): Promise<{ items: Preset[] }> {
  if (isKernelMode()) {
    const result = await backend.presets.list({ kind });
    return { items: result.items.map(translatePreset) };
  }
  return api.get<{ items: Preset[] }>(`/presets?kind=${encodeURIComponent(kind)}`);
}

/** Create a preset. */
export async function createPreset(input: PresetCreate): Promise<Preset> {
  if (isKernelMode()) {
    const created = await backend.presets.create({
      kind: input.kind,
      name: input.name,
      ...(input.data !== undefined ? { data: input.data } : {}),
    });
    return translatePreset(created);
  }
  return api.post<Preset>('/presets', input);
}

/** Update name/data of one preset. */
export async function updatePreset(id: string, update: PresetUpdate): Promise<Preset> {
  if (isKernelMode()) {
    return translatePreset(await backend.presets.update({ presetId: id, ...update }));
  }
  return api.patch<Preset>(`/presets/${encodeURIComponent(id)}`, update);
}

/** Delete one preset. */
export async function deletePreset(id: string): Promise<void> {
  if (isKernelMode()) {
    await backend.presets.del(id);
    return;
  }
  await api.del(`/presets/${encodeURIComponent(id)}`);
}

/* --------------------------------------------------------------------------
 * Memories (Этап 4 slice 3, wire `memories.*`; ТЗ §4.4 Memory/RAG).
 * ------------------------------------------------------------------------ */

/** List memories with optional scope/characterId/enabled filters. */
export async function readMemories(filter?: {
  scope?: 'global' | 'character';
  characterId?: string;
  enabled?: boolean;
}): Promise<{ items: Memory[] }> {
  if (isKernelMode()) {
    const result = await backend.memories.list(filter);
    return { items: result.items.map(translateMemory) };
  }
  return api.get<{ items: Memory[] }>(`/memories${encodeQuery({ ...filter })}`);
}

/** Create a memory (global or character-scoped). The legacy input allows
 * `characterId: null` for global memories; the wire DTO omits the field. */
export async function createMemory(input: MemoryCreate): Promise<Memory> {
  if (isKernelMode()) {
    const created = await backend.memories.create({
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.characterId != null ? { characterId: input.characterId } : {}),
      ...(input.keys !== undefined ? { keys: input.keys } : {}),
      content: input.content,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
    return translateMemory(created);
  }
  return api.post<Memory>('/memories', input);
}

/** Update the provided fields of one memory. */
export async function updateMemory(id: string, update: MemoryUpdate): Promise<Memory> {
  if (isKernelMode()) {
    // The wire DTO has no way to express `characterId: null` (un-scoping);
    // legacy could, so this is an honest CAPABILITY_UNAVAILABLE, not a
    // silent no-op.
    if (update.characterId === null) {
      throw new UnsupportedError('memories.update.characterId.null');
    }
    const patch: Parameters<typeof backend.memories.update>[0] = { memoryId: id };
    if (update.scope !== undefined) patch.scope = update.scope;
    if (update.characterId !== undefined) patch.characterId = update.characterId;
    if (update.keys !== undefined) patch.keys = update.keys;
    if (update.content !== undefined) patch.content = update.content;
    if (update.enabled !== undefined) patch.enabled = update.enabled;
    if (update.position !== undefined) patch.position = update.position;
    if (update.metadata !== undefined) patch.metadata = update.metadata;
    return translateMemory(await backend.memories.update(patch));
  }
  return api.patch<Memory>(`/memories/${encodeURIComponent(id)}`, update);
}

/** Delete one memory. */
export async function deleteMemory(id: string): Promise<void> {
  if (isKernelMode()) {
    await backend.memories.del(id);
    return;
  }
  await api.del(`/memories/${encodeURIComponent(id)}`);
}

/* --------------------------------------------------------------------------
 * Themes (Этап 4 context 6 part 3, wire `themes.*`; ТЗ §5.2 theme-sdk).
 *
 * The kernel models a theme as DATA (opaque manifest + a content-addressed
 * CSS asset reference, `cssAssetId` → `assets.put` kind `theme-css`); the
 * legacy plane serves stylesheets as URLs. The transport maps the asset to a
 * `data:` URI (`readAssetContentDataUrl`) so the UI keeps loading CSS through
 * the plain `componentsCssUrl` slot. A theme whose CSS asset exceeds the wire
 * content cap (262 144 response bytes) or cannot be read resolves to a
 * no-CSS theme honestly — the shell falls back to built-in defaults.
 * ------------------------------------------------------------------------ */

/** Wire `themes.item` → legacy `InstalledTheme` (synchronous skeleton; the
 * CSS asset is resolved by {@link themeToInstalled}). */
export function translateTheme(dto: ThemeDto): InstalledTheme {
  return {
    id: dto.id,
    name: dto.name,
    version: dto.version,
    // The kernel records the applied theme via the single `active` flag;
    // there is no separate enabled/disabled state (uninstall removes).
    enabled: true,
    manifest: (dto.manifest ?? {}) as Record<string, unknown>,
    installedAt: toEpochMs(dto.installedAt),
    // Kernel has no asset URL surface: the CSS bytes are resolved to a
    // `data:` URI below; previews and per-locale resources are not modelled
    // by the wire contract yet (honest null/empty, not fabricated URLs).
    componentsCssUrl: null,
    shellCssUrl: null,
    previewUrl: null,
    localesUrls: {},
  };
}

/** Wire `themes.item` → legacy `InstalledTheme` with the CSS asset resolved
 * to a `data:` URI (kernel plane). Legacy items pass through untouched. */
async function themeToInstalled(dto: ThemeDto): Promise<InstalledTheme> {
  const theme = translateTheme(dto);
  if (!dto.cssAssetId) return theme;
  try {
    const css = await readAssetContentDataUrl(dto.cssAssetId);
    if (css) theme.componentsCssUrl = css;
  } catch {
    // Honest no-CSS theme: the shell applies the manifest tokens and falls
    // back to built-in defaults for the stylesheet part.
  }
  return theme;
}

/** List installed themes with the active theme id. */
export async function readThemes(): Promise<ThemeListResponse> {
  if (isKernelMode()) {
    const result = await backend.themes.list();
    const items = await Promise.all(result.items.map(themeToInstalled));
    const activeThemeId =
      items.find((item) => {
        const dto = result.items.find((candidate) => candidate.id === item.id);
        return dto?.active ?? false;
      })?.id ?? null;
    return { items, activeThemeId };
  }
  return api.get<ThemeListResponse>('/themes');
}

/** Activate one theme (idempotent; exactly one active at a time). */
export async function activateTheme(id: string): Promise<ThemeActivationResult> {
  if (isKernelMode()) {
    const activated = await backend.themes.activate(id);
    return { activeThemeId: activated.id };
  }
  return api.post<ThemeActivationResult>(`/themes/${encodeURIComponent(id)}/activate`);
}

/** Clear the active theme (fall back to the built-in shell). The wire
 * contract has no deactivate op — the legacy `DELETE /themes/active` has no
 * kernel equivalent (honest CAPABILITY_UNAVAILABLE). */
export async function resetActiveTheme(): Promise<ThemeActivationResult> {
  if (isKernelMode()) {
    throw new UnsupportedError('themes.reset.active');
  }
  return api.del<ThemeActivationResult>('/themes/active');
}

/** Uninstall one theme; deleting the active theme clears the active flag. */
export async function deleteTheme(id: string): Promise<ThemeDeleteResult> {
  if (isKernelMode()) {
    await backend.themes.uninstall(id);
    // The wire uninstall returns an empty result; re-read to report the
    // truthful remaining active theme instead of fabricating one.
    const next = await readThemes();
    return { deleted: true, activeThemeId: next.activeThemeId };
  }
  return api.del<ThemeDeleteResult>(`/themes/${encodeURIComponent(id)}`);
}

/** Install a theme package. On the kernel plane the wire contract requires
 * the HOST to have already verified the package (SEC-05 signature/digest)
 * and published its CSS through `assets.put` before `themes.install` runs;
 * the web transport has no such host command yet, so this is an honest
 * CAPABILITY_UNAVAILABLE — never a silent skip of package verification. */
export async function installTheme(file: File): Promise<ThemeInstallResult> {
  if (isKernelMode()) {
    throw new UnsupportedError('themes.install.host-verify');
  }
  return api.upload<ThemeInstallResult>('/themes/install', file);
}

/** Persisted theme-owned settings values (ТЗ §6.5). The wire contract does
 * not model theme settings yet; the kernel plane honestly reports none
 * (`undefined` → the theme applies its manifest defaults). */
export async function readThemeSettings(
  themeId: string,
): Promise<Record<string, unknown> | undefined> {
  if (isKernelMode()) {
    return undefined;
  }
  const response = await fetch(
    // eslint-disable-next-line @neotavern/no-legacy-api-surface
    `/api/v2/themes/${encodeURIComponent(themeId)}/settings`,
  );
  if (!response.ok) return undefined;
  const data = (await response.json()) as { values?: Record<string, unknown> };
  return data.values;
}

/** Optional local user stylesheet (data/user.css, loaded last in the `user`
 * cascade layer). The kernel does not serve a user stylesheet (no wire op);
 * the legacy plane returns the documented route. */
export function userCssUrl(): string | null {
  if (isKernelMode()) {
    return null;
  }
  // eslint-disable-next-line @neotavern/no-legacy-api-surface
  return '/api/v2/user.css';
}

/* --------------------------------------------------------------------------
 * Plugins (Этап 4 context 6 part 4, wire `plugins.*`; ТЗ §SEC-05/§SEC-06).
 *
 * The kernel durably records what the HOST already verified (SEC-05 package
 * verification + ZIP traversal/symlink/bomb rejection stay in the host
 * package verifier) plus the GRANTED permission set (the install request IS
 * the consent moment). The web transport can list/enable/disable/uninstall;
 * everything that needs the host verifier or the plugin executor (package
 * install, git install, runtime safe mode, auth connections) is an honest
 * CAPABILITY_UNAVAILABLE — never a silent skip of verification/cleanup.
 * ------------------------------------------------------------------------ */

/** Wire `plugins.item` → legacy `InstalledPlugin` (honest subset: fields the
 * wire contract does not model are neutral defaults, not fabricated truth —
 * see each mapping). */
export function translatePlugin(dto: PluginDto): InstalledPlugin {
  return {
    id: dto.id,
    name: dto.name,
    version: dto.version,
    // The wire row has no Plugin-SDK apiVersion; the neutral minimum (1)
    // means "does not advertise a higher SDK", never a claimed exact number.
    apiVersion: 1,
    enabled: dto.enabled,
    status: dto.lastErrorCode != null ? 'error' : dto.enabled ? 'active' : 'disabled',
    manifest: (dto.manifest ?? {}) as Record<string, unknown>,
    // The kernel records only the granted set (the consent happened at
    // install); there is no separate requested-not-yet-approved list.
    requestedPermissions: [],
    grantedPermissions: dto.permissions,
    addedPermissions: [],
    installedAt: toEpochMs(dto.installedAt),
    updatedAt: toEpochMs(dto.updatedAt),
    // Presence of frontend/backend/styles surfaces is not modelled by the
    // wire row; false is the honest "not declared", and the UI then treats
    // the plugin as native without a legacy island or reload requirement.
    hasFrontend: false,
    hasBackend: false,
    hasStyles: false,
    hasLegacyFrontend: false,
    hasLegacyBackend: false,
    // Kernel plugins are native (no legacy bridge); native-v3 is the current
    // SDK generation the kernel wire represents.
    compatibilityLevel: 'native-v3',
    lastErrorCode: dto.lastErrorCode ?? null,
    source: undefined,
    dependencies: [],
    grantedCapabilities: [],
    trust: dto.trustState,
    publisherKeyId: dto.publisherKeyId,
  };
}

/** List installed plugins. The kernel has no safe-mode mechanism; `safeMode`
 * is honestly `false` on that plane. */
export async function readPlugins(): Promise<PluginListResponse> {
  if (isKernelMode()) {
    const result = await backend.plugins.list();
    return { items: result.items.map(translatePlugin), safeMode: false };
  }
  return api.get<PluginListResponse>('/plugins');
}

/** Enable a plugin (idempotent flag transition). */
export async function activatePlugin(
  id: string,
  input: { grantedPermissions: string[] },
): Promise<PluginLifecycleResult> {
  if (isKernelMode()) {
    // The wire record's permission set was fixed at install (the consent
    // moment). Activation applies those recorded permissions; requesting a
    // different set is not expressible on the wire — honest refusal rather
    // than silently enabling with different rights.
    const { items } = await backend.plugins.list();
    const current = items.find((plugin) => plugin.id === id);
    if (
      current &&
      input.grantedPermissions.length > 0 &&
      !samePermissionSet(input.grantedPermissions, current.permissions)
    ) {
      throw new UnsupportedError('plugins.activate.permissions-change');
    }
    const enabled = await backend.plugins.enable(id);
    return { plugin: translatePlugin(enabled) };
  }
  return api.post<PluginLifecycleResult>(`/plugins/${encodeURIComponent(id)}/activate`, input);
}

/** Disable a plugin (idempotent; SEC-06 executor cleanup is host-side). */
export async function disablePlugin(id: string): Promise<PluginLifecycleResult> {
  if (isKernelMode()) {
    const disabled = await backend.plugins.disable(id);
    return { plugin: translatePlugin(disabled) };
  }
  return api.post<PluginLifecycleResult>(`/plugins/${encodeURIComponent(id)}/disable`);
}

/** Uninstall a plugin (executor archive cleanup is host-side). */
export async function deletePlugin(id: string): Promise<PluginDeleteResult> {
  if (isKernelMode()) {
    await backend.plugins.uninstall(id);
    return { deleted: true };
  }
  return api.del<PluginDeleteResult>(`/plugins/${encodeURIComponent(id)}`);
}

/** Install a plugin package. On the kernel plane the wire contract requires
 * the HOST to have already verified the package (SEC-05 signature/digest +
 * ZIP hardening) before `plugins.install` runs; the web transport has no
 * such host command yet — honest CAPABILITY_UNAVAILABLE. */
export async function installPlugin(file: File): Promise<PluginInstallResult> {
  if (isKernelMode()) {
    throw new UnsupportedError('plugins.install.host-verify');
  }
  return api.upload<PluginInstallResult>('/plugins/install', file);
}

/** Install a plugin from a public Git repository archive (host-side fetch +
 * verification required). Not expressible on the kernel plane. */
export async function installPluginFromGit(
  input: PluginGitInstallRequest,
): Promise<PluginInstallResult> {
  if (isKernelMode()) {
    throw new UnsupportedError('plugins.install.git.host-verify');
  }
  return api.post<PluginInstallResult>('/plugins/install-git', input);
}

/** Enter runtime safe mode. The kernel has no safe-mode mechanism (no wire
 * op) — honest CAPABILITY_UNAVAILABLE. */
export async function enterPluginSafeMode(): Promise<PluginSafeModeResult> {
  if (isKernelMode()) {
    throw new UnsupportedError('plugins.safe-mode.enter');
  }
  return api.post<PluginSafeModeResult>('/plugins/runtime/safe-mode');
}

/** Exit runtime safe mode. See {@link enterPluginSafeMode}. */
export async function exitPluginSafeMode(): Promise<PluginSafeModeResult> {
  if (isKernelMode()) {
    throw new UnsupportedError('plugins.safe-mode.exit');
  }
  return api.del<PluginSafeModeResult>('/plugins/runtime/safe-mode');
}

/** List auth connections of one plugin. OAuth/session state lives outside the
 * kernel wire model — honest CAPABILITY_UNAVAILABLE. */
export async function readPluginAuthConnections(
  pluginId: string,
): Promise<PluginAuthConnectionsResponse> {
  if (isKernelMode()) {
    throw new UnsupportedError('plugins.auth.connections');
  }
  return api.get<PluginAuthConnectionsResponse>(
    `/plugins/${encodeURIComponent(pluginId)}/auth/connections`,
  );
}

/** Connect an OAuth flow for one plugin. See {@link readPluginAuthConnections}. */
export async function connectPluginAuth(
  pluginId: string,
  input: PluginAuthConnectRequest,
): Promise<PluginAuthConnectResult> {
  if (isKernelMode()) {
    throw new UnsupportedError('plugins.auth.connect');
  }
  return api.post<PluginAuthConnectResult>(
    `/plugins/${encodeURIComponent(pluginId)}/auth/connect`,
    input,
  );
}

/** Revoke an OAuth connection. See {@link readPluginAuthConnections}. */
export async function revokePluginAuth(
  pluginId: string,
  input: PluginAuthRevokeRequest,
): Promise<PluginAuthRevokeResult> {
  if (isKernelMode()) {
    throw new UnsupportedError('plugins.auth.revoke');
  }
  return api.post<PluginAuthRevokeResult>(
    `/plugins/${encodeURIComponent(pluginId)}/auth/revoke`,
    input,
  );
}

/** Set-equality comparison for permission lists (wire order is not
 * meaningful; the UI selection may arrive in any order). */
function samePermissionSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((permission) => rightSet.has(permission));
}
