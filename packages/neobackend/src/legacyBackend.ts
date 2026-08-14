/**
 * LegacyBackend — temporary NeoBackend adapter for features still served by
 * the legacy `/api/v2` server (ТЗ Фаза 0). Implemented here: `meta()`,
 * `characters.list` and `characters.get`, mapped onto the canonical wire DTOs.
 * Every other operation throws `UnsupportedError`.
 */
import {
  WIRE_PROTOCOL,
  type MetaDto,
  type PagedCharactersDto,
  type ProductErrorDto,
  type ListCharactersRequestDto,
  type CharacterDto,
} from '@neotavern/contracts';
import { ProductError } from '@neotavern/client-sdk';
import type {
  BackupsApi,
  CharactersApi,
  ChatsApi,
  GenerationApi,
  LorebooksApi,
  NeoBackend,
  PresetsApi,
  ProvidersApi,
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
  };

  readonly chats: ChatsApi = {
    list: () => this.unsupported('chats.list'),
    get: () => this.unsupported('chats.get'),
    create: () => this.unsupported('chats.create'),
    update: () => this.unsupported('chats.update'),
    del: () => this.unsupported('chats.delete'),
    listMessages: () => this.unsupported('chats.messages.list'),
    createMessage: () => this.unsupported('chats.messages.create'),
    updateMessage: () => this.unsupported('chats.messages.update'),
    delMessage: () => this.unsupported('chats.messages.delete'),
  };

  readonly generation: GenerationApi = {
    start: () => this.unsupported('generation.start'),
    cancel: () => this.unsupported('generation.cancel'),
    get: () => this.unsupported('generation.get'),
    events: () => this.unsupported('generation.events'),
    retry: () => this.unsupported('generation.retry'),
    keep: () => this.unsupported('generation.keep'),
    discard: () => this.unsupported('generation.discard'),
  };

  readonly backups: BackupsApi = {
    create: () => this.unsupported('backups.create'),
    list: () => this.unsupported('backups.list'),
  };

  readonly lorebooks: LorebooksApi = {
    list: () => this.unsupported('lorebooks.list'),
  };

  readonly presets: PresetsApi = {
    list: () => this.unsupported('presets.list'),
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

  private unsupported(feature: string): never {
    throw new UnsupportedError(feature);
  }
}
