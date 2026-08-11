/**
 * Backend Plugin SDK (ТЗ §7.3). Server plugins receive only these restricted
 * abstractions — never the Fastify root instance, the SQLite connection,
 * internal tables, absolute paths, all env vars, or other providers' API keys.
 *
 * The server (apps/server) provides the concrete implementations.
 */
import type { MessageRole } from '@neotavern/contracts';
import type { PluginEventBus } from './events.js';

export interface PluginRouteHandler {
  (request: PluginRequest): Promise<PluginResponse> | PluginResponse;
}

export interface PluginRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  /** Parsed JSON body, if any. */
  body: unknown;
  signal: AbortSignal;
}

export interface PluginResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Scoped router. Paths are mounted under /api/plugins/{pluginId}/. */
export interface PluginRouter {
  get(path: string, handler: PluginRouteHandler): () => void;
  post(path: string, handler: PluginRouteHandler): () => void;
  put(path: string, handler: PluginRouteHandler): () => void;
  delete(path: string, handler: PluginRouteHandler): () => void;
}

/** Namespaced key/value storage isolated per plugin. */
export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface PluginLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * fetch guarded by the plugin's `network:<host>` permissions. Requests to
 * non-granted hosts reject. Secrets from other providers are never injected.
 */
export type PermissionCheckedFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

/** Local model-specific tokenizer profile registered with a provider plugin. */
export interface PluginTokenizerProfile {
  readonly id: string;
  readonly priority?: number;
  readonly approximate: boolean;
  matches(model: string): boolean | Promise<boolean>;
  count(text: string): number | Promise<number>;
}

/** Provider registration surface (providers.register permission). */
export interface PluginProviderCapabilities {
  /** The provider serializes an assistant reply prefix without dropping it. */
  assistantPrefill?: boolean;
  /** The provider accepts a text-completion serialization instead of chat turns. */
  textCompletion?: boolean;
}

export interface PluginProviderRegistrationOptions {
  /** Explicit wire capabilities used by the host for connection-profile validation. */
  capabilities?: PluginProviderCapabilities;
}

export interface PluginProviderRegistry {
  register(kind: string, factory: unknown, options?: PluginProviderRegistrationOptions): () => void;
  registerTokenizer(profile: PluginTokenizerProfile): () => void;
}

export interface PluginContextMessage {
  id?: string;
  role: MessageRole;
  content: string;
  name?: string;
  pinned?: boolean;
  pairId?: string;
  source?: 'system' | 'history' | 'user' | 'lorebook' | 'memory' | 'plugin';
  relevance?: number;
}

export interface PluginContextStrategy {
  readonly id: string;
  readonly priority?: number;
  shift(context: {
    messages: PluginContextMessage[];
    budgetTokens: number;
    countTokens(text: string): number;
    manualExcludedIds?: ReadonlySet<string>;
  }):
    | {
        kept: PluginContextMessage[];
        excluded: PluginContextMessage[];
        estimatedTokens: number;
        truncated: boolean;
        fitsBudget: boolean;
      }
    | Promise<{
        kept: PluginContextMessage[];
        excluded: PluginContextMessage[];
        estimatedTokens: number;
        truncated: boolean;
        fitsBudget: boolean;
      }>;
}

export interface PluginContextStrategyRegistry {
  register(strategy: PluginContextStrategy): () => void;
}

/**
 * Generation post-processing hook registered by a backend plugin (ТЗ §4.4).
 * Runs after the stream completes and before the message is saved; returning
 * a new string replaces the assistant reply. Requires `prompt.modify`.
 */
export interface PluginPostProcessor {
  id: string;
  /** Lower priority runs first. */
  priority?: number;
  process(
    text: string,
    context: { chatId: string; characterId: string | null; model: string },
  ): string | Promise<string>;
}

export interface PluginPostProcessorRegistry {
  register(processor: PluginPostProcessor): () => void;
}

/** Sandboxed virtual filesystem rooted at the plugin's own data directory. */
export interface PluginVirtualFileSystem {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  list(dir: string): Promise<string[]>;
  delete(path: string): Promise<void>;
}

/** The API object handed to a backend plugin's entry point. */
export interface ServerPluginApi {
  readonly pluginId: string;
  readonly routes: PluginRouter;
  readonly storage: PluginStorage;
  readonly events: PluginEventBus;
  readonly logger: PluginLogger;
  readonly fetch: PermissionCheckedFetch;
  readonly providers: PluginProviderRegistry;
  readonly contextStrategies: PluginContextStrategyRegistry;
  readonly postProcessors: PluginPostProcessorRegistry;
  readonly files: PluginVirtualFileSystem;
}

/** Backend plugin entry contract. */
export interface ServerPluginDefinition {
  activate(api: ServerPluginApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
