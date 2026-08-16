/**
 * LegacyBackend — temporary NeoBackend adapter for features still served by
 * the legacy `/api/v2` server (ТЗ Фаза 0). Implemented here: `meta()`,
 * `characters.list` and `characters.get`, mapped onto the canonical wire DTOs.
 * Every other operation throws `UnsupportedError`.
 */
import {
  WIRE_PROTOCOL,
  type CreateMemoryRequestDto,
  type CreatePresetRequestDto,
  type DeleteMessageRequestDto,
  type EmptyResultDto,
  type ListMemoriesRequestDto,
  type ListMemoriesResultDto,
  type ListPresetsRequestDto,
  type ListPresetsResultDto,
  type MemoryDto,
  type MessageDto,
  type MetaDto,
  type PagedCharactersDto,
  type PresetDto,
  type ProductErrorDto,
  type BackupsRestoreResultDto,
  type ListCharactersRequestDto,
  type CharacterDto,
  type UpdateMemoryRequestDto,
  type UpdateMessageRequestDto,
  type UpdatePresetRequestDto,
} from '@neotavern/contracts';
import { ProductError } from '@neotavern/client-sdk';
import type {
  AssetsApi,
  BackupsApi,
  DataApi,
  CharactersApi,
  ChatsApi,
  DiagnosticsApi,
  GenerationApi,
  ImportsApi,
  LorebooksApi,
  MemoriesApi,
  NeoBackend,
  PersonasApi,
  PluginsApi,
  PresetsApi,
  ProfilesApi,
  ProvidersApi,
  SecretsApi,
  SettingsApi,
  ThemesApi,
} from './neobackend.js';

/**
 * Thrown for features the legacy `/api/v2` server does not expose yet.
 */
export class UnsupportedError extends Error {
  readonly code = 'UNSUPPORTED' as const;
  readonly feature: string;

  constructor(feature: string) {
    super(`Feature not supported by the legacy backend: ${feature}`);
    this.name = 'UnsupportedError';
    this.feature = feature;
  }
}

/** LegacyBackend constructor options. */
export interface LegacyBackendOptions {
  /** Base URL of the legacy server, e.g. `http://127.0.0.1:8000`. */
  baseUrl: string;
  /** Injectable fetch implementation (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Host-provided transport for the temporary raw passthrough (see
   * [`LegacyBackend.raw`]). When absent, `raw` throws [`UnsupportedError`].
   * The web app supplies its same-origin fetch/CSRF transport; other hosts
   * leave the typed methods on the default fetch.
   */
  transport?: LegacyTransport;
}

/**
 * Temporary raw transport over the legacy `/api/v2` surface (ТЗ Фаза 0).
 *
 * Exists only while features migrate to the Runtime Kernel (Фаза 3+ vertical
 * slices). Callers that need a feature still served by the legacy server use
 * [`LegacyRawApi`] — the migration routing table
 * (`docs/architecture/operations-inventory.md`) tracks which operations
 * remain on this path; each Phase 3 cutover deletes its slice from here.
 */
export interface LegacyTransport {
  /**
   * Raw legacy request. Returns the parsed JSON body (`undefined` for 204).
   * Errors surface as the caller's transport error type (the web transport
   * throws `ApiError` for `{code, params, traceId}` envelopes).
   */
  request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T>;
  /** Multipart upload (FormData `file` field); returns the parsed JSON body. */
  upload?(path: string, file: File, signal?: AbortSignal): Promise<unknown>;
  /** Full URL for a legacy SSE streaming endpoint. */
  sseUrl?(path: string): string;
}

/** Raw legacy call surface exposed through [`LegacyBackend.raw`]. */
export interface LegacyRawApi {
  request: LegacyTransport['request'];
  upload: NonNullable<LegacyTransport['upload']>;
  sseUrl: NonNullable<LegacyTransport['sseUrl']>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * NeoBackend over the legacy `/api/v2` server. Maps legacy responses onto the
 * canonical wire DTOs; legacy error envelopes `{code, params, traceId}` are
 * mapped to `ProductError` with code passthrough. Features not yet mapped
 * are reachable through the temporary [`LegacyBackend.raw`] passthrough when
 * the host supplies a [`LegacyTransport`].
 */
export class LegacyBackend implements NeoBackend {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly transport: LegacyTransport | undefined;
  constructor(options: LegacyBackendOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.transport = options.transport;
  }

  /**
   * Raw legacy passthrough for features not yet migrated to the Runtime
   * Kernel (ТЗ Фаза 0 temporary route). Throws [`UnsupportedError`] when the
   * host constructed this backend without a [`LegacyTransport`].
   */
  get raw(): LegacyRawApi {
    if (this.transport === undefined) {
      throw new UnsupportedError('legacy.raw');
    }
    return {
      request: this.transport.request,
      upload:
        this.transport.upload ??
        (() => {
          throw new UnsupportedError('legacy.raw.upload');
        }),
      sseUrl:
        this.transport.sseUrl ??
        (() => {
          throw new UnsupportedError('legacy.raw.sseUrl');
        }),
    };
  }

  /** Wire metadata from `/api/v2/version` + `/api/v2/health`. */
  async meta(): Promise<MetaDto> {
    const [versionBody] = await Promise.all([
      this.getJson('/api/v2/version'),
      this.getJson('/api/v2/health'),
    ]);
    return this.mapMeta(versionBody);
  }

  readonly characters: CharactersApi = {
    list: (req) => this.listCharacters(req),
    get: (characterId) => this.getCharacter(characterId),
    create: () => this.unsupported('characters.create'),
    update: () => this.unsupported('characters.update'),
    del: () => this.unsupported('characters.delete'),
    exportCard: () => this.unsupported('characters.export.card'),
  };

  readonly chats: ChatsApi = {
    list: () => this.unsupported('chats.list'),
    get: () => this.unsupported('chats.get'),
    create: () => this.unsupported('chats.create'),
    update: () => this.unsupported('chats.update'),
    del: () => this.unsupported('chats.delete'),
    listMessages: () => this.unsupported('chats.messages.list'),
    createMessage: () => this.unsupported('chats.messages.create'),
    updateMessage: (req) => this.updateMessage(req),
    delMessage: (req) => this.delMessage(req),
    createSnapshot: () => this.unsupported('chats.snapshots.create'),
    rollbackSnapshot: () => this.unsupported('chats.snapshots.rollback'),
    listMessageVariants: () => this.unsupported('chats.messages.variants.list'),
    createMessageVariant: () => this.unsupported('chats.messages.variants.create'),
    delMessageVariant: () => this.unsupported('chats.messages.variants.delete'),
    activateMessageVariant: () => this.unsupported('chats.messages.variants.activate'),
    listMessageRevisions: () => this.unsupported('chats.messages.revisions.list'),
    getMessageDraft: () => this.unsupported('chats.messages.drafts.get'),
    saveMessageDraft: () => this.unsupported('chats.messages.drafts.save'),
    commitMessageDraft: () => this.unsupported('chats.messages.drafts.commit'),
    discardMessageDraft: () => this.unsupported('chats.messages.drafts.discard'),
    export: () => this.unsupported('chats.export'),
  };

  readonly generation: GenerationApi = {
    start: () => this.unsupported('generation.start'),
    cancel: () => this.unsupported('generation.cancel'),
    get: () => this.unsupported('generation.get'),
    events: () => this.unsupported('generation.events'),
    retry: () => this.unsupported('generation.retry'),
    keep: () => this.unsupported('generation.keep'),
    discard: () => this.unsupported('generation.discard'),
    promptPlan: () => this.unsupported('generation.prompt.plan'),
    tools: {
      list: () => this.unsupported('generation.tools.list'),
      result: () => this.unsupported('generation.tool.result'),
    },
  };

  readonly backups: BackupsApi = {
    create: () => this.unsupported('backups.create'),
    list: () => this.unsupported('backups.list'),
    restore: (backupId) => this.restoreBackup(backupId),
  };

  readonly data: DataApi = {
    activationStatus: () => this.unsupported('data.activation.status'),
  };

  readonly lorebooks: LorebooksApi = {
    list: () => this.unsupported('lorebooks.list'),
    get: () => this.unsupported('lorebooks.get'),
    create: () => this.unsupported('lorebooks.create'),
    update: () => this.unsupported('lorebooks.update'),
    del: () => this.unsupported('lorebooks.delete'),
    listEntries: () => this.unsupported('lorebooks.entries.list'),
    createEntry: () => this.unsupported('lorebooks.entries.create'),
    updateEntry: () => this.unsupported('lorebooks.entries.update'),
    deleteEntry: () => this.unsupported('lorebooks.entries.delete'),
  };

  readonly personas: PersonasApi = {
    list: () => this.unsupported('personas.list'),
    get: () => this.unsupported('personas.get'),
    create: () => this.unsupported('personas.create'),
    update: () => this.unsupported('personas.update'),
    del: () => this.unsupported('personas.delete'),
  };

  readonly presets: PresetsApi = {
    list: (req) => this.listPresets(req),
    get: (presetId) => this.getPreset(presetId),
    create: (req) => this.createPreset(req),
    update: (req) => this.updatePreset(req),
    del: (presetId) => this.deletePreset(presetId),
  };

  readonly memories: MemoriesApi = {
    list: (req) => this.listMemories(req),
    create: (req) => this.createMemory(req),
    update: (req) => this.updateMemory(req),
    del: (memoryId) => this.deleteMemory(memoryId),
  };

  readonly providers: ProvidersApi = {
    list: () => this.unsupported('providers.list'),
    config: {
      set: () => this.unsupported('providers.config.set'),
      get: () => this.unsupported('providers.config.get'),
      list: () => this.unsupported('providers.config.list'),
      del: () => this.unsupported('providers.config.delete'),
    },
  };

  /**
   * Canonical kernel-only domains (ТЗ §13.1: a capability that lives in the
   * kernel must never be silently served by the legacy plane). These throw
   * `UnsupportedError` on the legacy backend until the UI runs on the kernel
   * facade only.
   */
  readonly plugins: PluginsApi = {
    list: () => this.unsupported('plugins.list'),
    install: () => this.unsupported('plugins.install'),
    uninstall: () => this.unsupported('plugins.uninstall'),
    enable: () => this.unsupported('plugins.enable'),
    disable: () => this.unsupported('plugins.disable'),
  };

  readonly themes: ThemesApi = {
    list: () => this.unsupported('themes.list'),
    install: () => this.unsupported('themes.install'),
    uninstall: () => this.unsupported('themes.uninstall'),
    activate: () => this.unsupported('themes.activate'),
    deactivate: () => this.unsupported('themes.deactivate'),
  };

  readonly profiles: ProfilesApi = {
    list: () => this.unsupported('profiles.list'),
    create: () => this.unsupported('profiles.create'),
    rename: () => this.unsupported('profiles.rename'),
    del: () => this.unsupported('profiles.delete'),
    export: () => this.unsupported('profile.export'),
    import: () => this.unsupported('profile.import'),
  };

  readonly settings: SettingsApi = {
    get: () => this.unsupported('settings.get'),
    update: () => this.unsupported('settings.update'),
  };

  readonly diagnostics: DiagnosticsApi = {
    export: () => this.unsupported('diagnostics.export'),
  };

  readonly secrets: SecretsApi = {
    status: () => this.unsupported('secrets.status'),
    lock: () => this.unsupported('secrets.lock'),
  };

  readonly assets: AssetsApi = {
    get: () => this.unsupported('assets.get'),
    content: () => this.unsupported('assets.content'),
    put: () => this.unsupported('assets.put'),
    del: () => this.unsupported('assets.delete'),
  };

  readonly imports: ImportsApi = {
    characterCard: () => this.unsupported('imports.character.card'),
  };

  private async listCharacters(req: ListCharactersRequestDto): Promise<PagedCharactersDto> {
    const query = new URLSearchParams();
    if (req.cursor !== undefined) {
      query.set('cursor', req.cursor);
    }
    if (req.limit !== undefined) {
      query.set('limit', String(req.limit));
    }
    const queryString = query.toString();
    const body = await this.getJson(`/api/v2/characters${queryString ? `?${queryString}` : ''}`);
    return this.mapCharacterPage(body);
  }

  private async getCharacter(characterId: string): Promise<CharacterDto> {
    const body = await this.getJson(`/api/v2/characters/${encodeURIComponent(characterId)}`);
    return this.mapCharacter(body);
  }

  /**
   * Migration shim for `chats.messages.update` (Этап 2.10): maps the wire
   * request onto the existing legacy `PATCH /api/v2/chats/:id/messages/:mid`
   * route. The legacy server answers with its own `Message` shape, which has
   * no wire `sequence`/`generationRunId`; the mapping fills `sequence` from
   * the response when present and otherwise reports 0 (the callers that use
   * this bridge today discard the return value and refetch through the query
   * cache). Content-only CAS (`expectedRevision`) is a legacy-only feature
   * and is not part of the wire contract — kernel updates are
   * last-write-wins; see `docs/architecture/operations-inventory.md`.
   */
  private async updateMessage(req: UpdateMessageRequestDto): Promise<MessageDto> {
    const body = await this.sendRequest<Record<string, unknown>>(
      'PATCH',
      `/api/v2/chats/${encodeURIComponent(req.chatId)}/messages/${encodeURIComponent(req.messageId)}`,
      { content: req.content },
    );
    return this.mapMessage(body);
  }

  /** Migration shim for `chats.messages.delete` (Этап 2.10): `DELETE /api/v2/chats/:id/messages/:mid`. */
  private async delMessage(req: DeleteMessageRequestDto): Promise<EmptyResultDto> {
    await this.sendRequest<unknown>(
      'DELETE',
      `/api/v2/chats/${encodeURIComponent(req.chatId)}/messages/${encodeURIComponent(req.messageId)}`,
    );
    return { ok: true };
  }

  /**
   * Send a mutating legacy request through the host transport when one is
   * supplied (the web app's same-origin transport adds the CSRF header and
   * surfaces `ApiError` envelopes), falling back to plain `fetch` otherwise.
   */
  private async sendRequest<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.transport !== undefined) {
      return this.transport.request<T>(method, path, body, signal);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = undefined;
      }
      throw this.mapError(errorBody, response.status);
    }
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      return undefined as T;
    }
  }

  /** Map a legacy `Message` body onto the canonical wire `MessageDto`. */
  private mapMessage(value: unknown): MessageDto {
    const item = isRecord(value) ? value : {};
    const id = typeof item['id'] === 'string' ? item['id'] : '';
    const chatId = typeof item['chatId'] === 'string' ? item['chatId'] : '';
    const role = item['role'] === 'assistant' ? 'assistant' : 'user';
    const content = typeof item['content'] === 'string' ? item['content'] : '';
    const createdAt = typeof item['createdAt'] === 'string' ? item['createdAt'] : '';
    const sequence = typeof item['sequence'] === 'number' ? item['sequence'] : 0;
    const generationRunId =
      typeof item['generationRunId'] === 'string' ? item['generationRunId'] : undefined;
    return {
      id,
      chatId,
      role,
      content,
      createdAt,
      sequence,
      meta: {},
      ...(generationRunId !== undefined ? { generationRunId } : {}),
    };
  }

  private async getJson(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
    } catch (cause) {
      throw new Error(
        `Legacy backend request to ${path} failed`,
        cause instanceof Error ? { cause } : undefined,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      throw this.mapError(body, response.status);
    }
    return body;
  }

  /**
   * `backups.restore` on the legacy plane: translates to the legacy sidecar
   * restore endpoint (`POST /backups/{id}/restore`), mapping its
   * `{ restored, restartRequired }` answer onto the canonical
   * `{ status: 'committed' | 'activation_pending' }` result. This is a pure
   * boundary translation of an existing user-facing capability — it adds no
   * authority (ARC-11).
   */
  private async restoreBackup(backupId: string): Promise<BackupsRestoreResultDto> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/backups/${encodeURIComponent(backupId)}/restore`,
        {
          method: 'POST',
          headers: { accept: 'application/json' },
        },
      );
    } catch (cause) {
      throw new Error(
        `Legacy backend request to /backups/${backupId}/restore failed`,
        cause instanceof Error ? { cause } : undefined,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      throw this.mapError(body, response.status);
    }
    const restartRequired = isRecord(body) && body['restartRequired'] === true;
    return { status: restartRequired ? 'activation_pending' : 'committed' };
  }

  private mapError(body: unknown, status: number): Error {
    if (isRecord(body) && typeof body['code'] === 'string') {
      const dto: ProductErrorDto = {
        code: body['code'],
        params: isRecord(body['params']) ? body['params'] : {},
        ...(typeof body['traceId'] === 'string' ? { traceId: body['traceId'] } : {}),
      };
      return new ProductError(dto);
    }
    return new Error(`Legacy backend request failed with status ${status}`);
  }

  private mapMeta(versionBody: unknown): MetaDto {
    const record = isRecord(versionBody) ? versionBody : {};
    const version = typeof record['version'] === 'string' ? record['version'] : '';
    return {
      appVersion: version.length > 0 ? version : 'unknown',
      api: { major: 2, minor: 0 },
      productWire: WIRE_PROTOCOL,
      features: { core: 1 },
    };
  }

  private mapCharacterPage(body: unknown): PagedCharactersDto {
    if (!isRecord(body) || !Array.isArray(body['items'])) {
      throw new Error('Legacy /api/v2/characters returned an unexpected shape');
    }
    const nextCursor = body['nextCursor'];
    return {
      items: body['items'].map((item) => this.mapCharacter(item)),
      nextCursor: typeof nextCursor === 'string' ? nextCursor : undefined,
    };
  }

  private mapCharacter(value: unknown): CharacterDto {
    const item = isRecord(value) ? value : {};
    const id = typeof item['id'] === 'string' ? item['id'] : '';
    const name = typeof item['name'] === 'string' ? item['name'] : '';
    const description = typeof item['description'] === 'string' ? item['description'] : undefined;
    const createdAt = typeof item['createdAt'] === 'string' ? item['createdAt'] : '';
    const updatedAt = typeof item['updatedAt'] === 'string' ? item['updatedAt'] : '';
    return {
      id,
      name,
      description,
      tags: Array.isArray(item['tags'])
        ? item['tags'].filter((tag): tag is string => typeof tag === 'string')
        : [],
      createdAt,
      updatedAt,
    };
  }

  /** M5 slice 3: `presets.list` over `GET /api/v2/presets?kind=`. */
  private async listPresets(req: ListPresetsRequestDto | undefined): Promise<ListPresetsResultDto> {
    const query = new URLSearchParams();
    if (req?.kind !== undefined) {
      query.set('kind', req.kind);
    }
    const queryString = query.toString();
    const body = await this.getJson(`/api/v2/presets${queryString ? `?${queryString}` : ''}`);
    if (!isRecord(body) || !Array.isArray(body['items'])) {
      throw new Error('Legacy /api/v2/presets returned an unexpected shape');
    }
    return { items: body['items'].map((item) => this.mapPreset(item)) };
  }

  /** M5 slice 3: `presets.get` over `GET /api/v2/presets/:id`. */
  private async getPreset(presetId: string): Promise<PresetDto> {
    const body = await this.getJson(`/api/v2/presets/${encodeURIComponent(presetId)}`);
    return this.mapPreset(body);
  }

  /** M5 slice 3: `presets.create` over `POST /api/v2/presets`. */
  private async createPreset(req: CreatePresetRequestDto): Promise<PresetDto> {
    const body = await this.sendRequest<unknown>('POST', '/api/v2/presets', req);
    return this.mapPreset(body);
  }

  /** M5 slice 3: `presets.update` over `PATCH /api/v2/presets/:id`. */
  private async updatePreset(req: UpdatePresetRequestDto): Promise<PresetDto> {
    const { presetId, ...patch } = req;
    const body = await this.sendRequest<unknown>(
      'PATCH',
      `/api/v2/presets/${encodeURIComponent(presetId)}`,
      patch,
    );
    return this.mapPreset(body);
  }

  /** M5 slice 3: `presets.delete` over `DELETE /api/v2/presets/:id`. */
  private async deletePreset(presetId: string): Promise<EmptyResultDto> {
    await this.sendRequest<unknown>('DELETE', `/api/v2/presets/${encodeURIComponent(presetId)}`);
    return { ok: true };
  }

  /** M5 slice 3: `memories.list` over `GET /api/v2/memories?scope=&characterId=&enabled=`. */
  private async listMemories(
    req: ListMemoriesRequestDto | undefined,
  ): Promise<ListMemoriesResultDto> {
    const query = new URLSearchParams();
    if (req?.scope !== undefined) query.set('scope', req.scope);
    if (req?.characterId !== undefined) query.set('characterId', req.characterId);
    if (req?.enabled !== undefined) query.set('enabled', String(req.enabled));
    const queryString = query.toString();
    const body = await this.getJson(`/api/v2/memories${queryString ? `?${queryString}` : ''}`);
    if (!isRecord(body) || !Array.isArray(body['items'])) {
      throw new Error('Legacy /api/v2/memories returned an unexpected shape');
    }
    return { items: body['items'].map((item) => this.mapMemory(item)) };
  }

  /** M5 slice 3: `memories.create` over `POST /api/v2/memories`. */
  private async createMemory(req: CreateMemoryRequestDto): Promise<MemoryDto> {
    const body = await this.sendRequest<unknown>('POST', '/api/v2/memories', req);
    return this.mapMemory(body);
  }

  /** M5 slice 3: `memories.update` over `PATCH /api/v2/memories/:id`. */
  private async updateMemory(req: UpdateMemoryRequestDto): Promise<MemoryDto> {
    const { memoryId, ...patch } = req;
    const body = await this.sendRequest<unknown>(
      'PATCH',
      `/api/v2/memories/${encodeURIComponent(memoryId)}`,
      patch,
    );
    return this.mapMemory(body);
  }

  /** M5 slice 3: `memories.delete` over `DELETE /api/v2/memories/:id`. */
  private async deleteMemory(memoryId: string): Promise<EmptyResultDto> {
    await this.sendRequest<unknown>('DELETE', `/api/v2/memories/${encodeURIComponent(memoryId)}`);
    return { ok: true };
  }

  /**
   * Maps a legacy `Preset` body onto the canonical wire `PresetDto`. Legacy
   * timestamps are INTEGER epoch-ms; the wire contract requires RFC 3339, so
   * numbers are converted (strings pass through unchanged).
   */
  private mapPreset(value: unknown): PresetDto {
    const item = isRecord(value) ? value : {};
    const id = typeof item['id'] === 'string' ? item['id'] : '';
    const kind = typeof item['kind'] === 'string' ? item['kind'] : '';
    const name = typeof item['name'] === 'string' ? item['name'] : '';
    const data = isRecord(item['data']) ? item['data'] : {};
    return {
      id,
      kind,
      name,
      data,
      createdAt: legacyTimestamp(item['createdAt']),
      updatedAt: legacyTimestamp(item['updatedAt']),
    };
  }

  /**
   * Maps a legacy `Memory` body onto the canonical wire `MemoryDto`. The
   * legacy `characterId` is `null` for global memories; the wire DTO omits it
   * (optional field), so `null` → absent. `scope` is a closed union; unknown
   * scopes fall back to `'global'` so a legacy extension value can never
   * break the wire validation.
   */
  private mapMemory(value: unknown): MemoryDto {
    const item = isRecord(value) ? value : {};
    const id = typeof item['id'] === 'string' ? item['id'] : '';
    const scope = item['scope'] === 'character' ? ('character' as const) : ('global' as const);
    const characterId = typeof item['characterId'] === 'string' ? item['characterId'] : undefined;
    const keys = Array.isArray(item['keys'])
      ? item['keys'].filter((key): key is string => typeof key === 'string')
      : [];
    const content = typeof item['content'] === 'string' ? item['content'] : '';
    const enabled = typeof item['enabled'] === 'boolean' ? item['enabled'] : true;
    const position = typeof item['position'] === 'number' ? item['position'] : 0;
    const metadata = isRecord(item['metadata']) ? item['metadata'] : {};
    return {
      id,
      scope,
      ...(characterId !== undefined ? { characterId } : {}),
      keys,
      content,
      enabled,
      position,
      metadata,
      createdAt: legacyTimestamp(item['createdAt']),
      updatedAt: legacyTimestamp(item['updatedAt']),
    };
  }

  private unsupported(feature: string): never {
    throw new UnsupportedError(feature);
  }
}

/** Maps a legacy INTEGER epoch-ms timestamp to the wire RFC 3339 string
 * (strings — already RFC 3339 — pass through; anything else → ''). */
function legacyTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return typeof value === 'string' ? value : '';
}
