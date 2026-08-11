/**
 * Provider adapter contract (ТЗ §4.3). Every LLM/TTS/STT/image provider
 * implements {@link ProviderAdapter}. Adapters must support cancellation via
 * AbortSignal, a unified streaming event format, timeouts, error
 * normalization, and secret-free logging.
 *
 * Request/event shapes are the shared contracts from @neotavern/contracts so backend
 * and frontend agree on one source of truth.
 */
import type {
  GenerationEvent,
  GenerationRequest,
  ImageEvent,
  ImageRequest,
  ModelInfo,
  ProviderModality,
  SpeechEvent,
  SpeechRequest,
  TranscriptionRequest,
  TranscriptionResult,
} from '@neotavern/contracts';
import type { Logger } from '@neotavern/shared';
import type { ProviderTimeouts } from './timeouts.js';

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface TokenCountRequest {
  model: string;
  messages: ReadonlyArray<{ role: string; content: string }>;
}

export interface TokenCount {
  tokens: number;
  /** True when the count is an approximation (no exact tokenizer available). */
  approximate: boolean;
}

/**
 * A provider that can generate completions and optionally speech, images and
 * transcriptions (ТЗ §4.3). Text generation is the base capability; the other
 * modalities are optional so an LLM-only adapter stays a valid provider.
 */
export interface ProviderAdapter {
  /** Stable provider kind, e.g. "openai-compatible". */
  readonly kind: string;

  /**
   * Declared capabilities. Defaults to `['text']` when omitted. Hosts use it
   * to reject unsupported modalities with a typed error before any call.
   */
  readonly modalities?: readonly ProviderModality[];

  /**
   * Optional generation-wire capabilities. Plugin adapters must opt in before
   * a connection profile can use the respective feature; the host never
   * silently drops a persisted profile override.
   */
  readonly capabilities?: Readonly<{
    /** Serializes {@link GenerationRequest.assistantPrefill} as an assistant turn prefix. */
    assistantPrefill?: boolean;
    /** Uses a serialized text-completion prompt instead of chat messages. */
    textCompletion?: boolean;
  }>;

  /** Validate provider configuration without performing network calls. */
  validateConfig(): Promise<ValidationResult>;

  /** List available models. Must respect the abort signal. */
  listModels(signal: AbortSignal): Promise<ModelInfo[]>;

  /**
   * Generate a completion, streaming unified events. Exactly one terminal
   * event (`done` or `error`) is yielded. Must abort promptly on signal.
   */
  generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GenerationEvent>;

  /** Text-to-speech. Same streaming contract shape as {@link generate}. */
  speech?(request: SpeechRequest, signal: AbortSignal): AsyncIterable<SpeechEvent>;

  /** Image generation. Same streaming contract shape as {@link generate}. */
  image?(request: ImageRequest, signal: AbortSignal): AsyncIterable<ImageEvent>;

  /** Speech-to-text (single result, not streamed). */
  transcribe?(request: TranscriptionRequest, signal: AbortSignal): Promise<TranscriptionResult>;

  /** Optional local token counting (approximation allowed with a flag). */
  countTokens?(request: TokenCountRequest): Promise<TokenCount>;
}

/** Constructor signature for provider adapters registered in the registry. */
export type ProviderAdapterFactory = (config: ProviderRuntimeConfig) => ProviderAdapter;

/**
 * Runtime configuration handed to an adapter. `apiKey` is provided by the
 * server from secure storage; adapters must never log it.
 */
export interface ProviderRuntimeConfig {
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
  settings: Record<string, unknown>;
  /** Injectable fetch for tests / custom transports. */
  fetchImpl?: typeof fetch;
  /**
   * Connect/read/idle deadlines enforced by the adapter itself, independent of
   * the caller's AbortSignal (ТЗ §4.3). Omitted fields fall back to
   * {@link DEFAULT_PROVIDER_TIMEOUTS}.
   */
  timeouts?: Partial<ProviderTimeouts>;
  /**
   * Structured logger for secret-free provider diagnostics (ТЗ §4.3). Defaults
   * to a scoped console logger; the shared logger redacts known secret shapes.
   */
  logger?: Logger;
}
