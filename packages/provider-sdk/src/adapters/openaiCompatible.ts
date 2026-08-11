/**
 * OpenAI-compatible chat completions adapter. Works with any server exposing
 * the OpenAI `/v1/chat/completions` + `/v1/models` API (OpenAI, OpenRouter,
 * LM Studio, llama.cpp server, Ollama with /v1, vLLM, etc.).
 *
 * Uses only the global `fetch` (AGENTS.md §7: vendor SDKs are not wired into
 * the core; the documented exception is the Anthropic adapter). The API key
 * is sent but never logged.
 */
import type {
  GenerationEvent,
  GenerationParameterId,
  GenerationRequest,
  ModelInfo,
  ReasoningEffort,
} from '@neotavern/contracts';
import { createLogger, ErrorCodes, randomToken, type Logger } from '@neotavern/shared';
import { parseSseStream } from '../sse.js';
import {
  estimateRequestTokens,
  estimateTokens,
  registerCoreTokenizers,
  TokenizerRegistry,
} from '../tokenizer.js';
import { httpProviderError, normalizeProviderError, validateHttpBaseUrl } from '../errors.js';
import { findProviderCatalogEntry } from '../catalog.js';
import { applyCustomBody, applyCustomHeaders } from '../additionalParams.js';
import { DeadlineController, resolveTimeouts, type ProviderTimeouts } from '../timeouts.js';
import type {
  ProviderAdapter,
  ProviderRuntimeConfig,
  TokenCount,
  TokenCountRequest,
  ValidationResult,
} from '../types.js';

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAIStreamChunk {
  choices?: Array<{ delta?: { content?: unknown } }>;
  /** Final chunk carries usage when stream_options.include_usage is set. */
  usage?: OpenAIUsage;
}

interface OpenAICompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: OpenAIUsage;
}

interface OpenAIModelEntry {
  id: string;
  /** Non-standard fields various compatible servers expose. */
  context_length?: number;
  context_window?: number;
  max_context_length?: number;
}

interface OpenAIModelsResponse {
  data?: OpenAIModelEntry[];
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly kind = 'openai-compatible';
  readonly capabilities = { assistantPrefill: true } as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeouts: ProviderTimeouts;
  private readonly log: Logger;
  private readonly samplerSupport: readonly GenerationParameterId[];
  private readonly reasoningEfforts: readonly ReasoningEffort[] | undefined;
  /** Offline exact tokenizers shared by all adapter instances. */
  private static readonly tokenizers: TokenizerRegistry = (() => {
    const registry = new TokenizerRegistry();
    registerCoreTokenizers(registry);
    return registry;
  })();

  constructor(private readonly config: ProviderRuntimeConfig) {
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeouts = resolveTimeouts(config.timeouts);
    this.log = config.logger ?? createLogger({ scope: 'provider:openai-compatible' });
    const catalogEntry = findProviderCatalogEntry(config.settings['source']);
    this.reasoningEfforts = catalogEntry?.reasoningEfforts;
    this.samplerSupport =
      catalogEntry?.id === 'openai-compatible'
        ? config.settings['samplerCompatibility'] === 'extended'
          ? catalogEntry.samplerSupport
          : ['temperature', 'topP']
        : (catalogEntry?.samplerSupport ?? [
            'temperature',
            'topP',
            'frequencyPenalty',
            'presencePenalty',
            'seed',
            'reasoningEffort',
            'topK',
            'minP',
            'topA',
            'repetitionPenalty',
          ]);
  }

  private get baseUrl(): string {
    const url = this.config.baseUrl ?? '';
    // Strip a trailing slash; allow callers to pass ".../v1" or the root.
    return url.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey && this.config.apiKey.length > 0) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    return applyCustomHeaders(headers, this.config.settings);
  }

  private supports(parameter: GenerationParameterId): boolean {
    return this.samplerSupport.includes(parameter);
  }

  async validateConfig(): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [
      ...validateHttpBaseUrl(this.config.baseUrl, { required: true }),
    ];
    return { valid: issues.length === 0, issues };
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    // Adapter-owned read deadline: a hung provider must not wait on the caller.
    const deadline = new DeadlineController(signal);
    deadline.arm(this.timeouts.readMs, 'Timed out listing provider models');
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: deadline.signal,
      });
      if (!response.ok) {
        const body = await safeReadError(response);
        throw httpProviderError(response.status, 'listModels', body);
      }
      const json = (await response.json()) as OpenAIModelsResponse;
      return (json.data ?? []).map((m) => {
        const contextLimit =
          m.context_length ?? m.context_window ?? m.max_context_length ?? undefined;
        return {
          id: m.id,
          name: m.id,
          ...(typeof contextLimit === 'number' && contextLimit > 0 ? { contextLimit } : {}),
        };
      });
    } catch (error) {
      // Structured, secret-free diagnostics (ТЗ §4.3): no keys, no raw bodies.
      this.log.warn('Provider model listing failed', { kind: this.kind });
      throw normalizeProviderError(error, 'listModels');
    } finally {
      deadline.dispose();
    }
  }

  async *generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GenerationEvent> {
    const requestId = randomToken(8);
    yield { type: 'start', requestId };

    const body: Record<string, unknown> = {
      model: request.model,
      messages: [
        ...request.messages,
        ...(request.assistantPrefill
          ? [{ role: 'assistant' as const, content: request.assistantPrefill }]
          : []),
      ].map((m) => ({
        // OpenAI-compatible APIs only accept system/user/assistant/tool; plugin
        // narration (rev4 chats) is user-facing content.
        role: m.role === 'plugin' ? 'user' : m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
      })),
      max_tokens: request.maxTokens,
      stream: request.stream,
    };
    if (this.supports('temperature')) body['temperature'] = request.temperature;
    if (this.supports('topP') && request.topP !== undefined) body['top_p'] = request.topP;
    if (this.supports('topK') && request.topK !== undefined) body['top_k'] = request.topK;
    if (this.supports('minP') && request.minP !== undefined) body['min_p'] = request.minP;
    if (this.supports('topA') && request.topA !== undefined) body['top_a'] = request.topA;
    if (this.supports('repetitionPenalty') && request.repetitionPenalty !== undefined) {
      body['repetition_penalty'] = request.repetitionPenalty;
    }
    if (this.supports('frequencyPenalty') && request.frequencyPenalty !== undefined) {
      body['frequency_penalty'] = request.frequencyPenalty;
    }
    if (this.supports('presencePenalty') && request.presencePenalty !== undefined) {
      body['presence_penalty'] = request.presencePenalty;
    }
    if (this.supports('seed') && request.seed !== undefined) body['seed'] = request.seed;
    if (
      this.supports('reasoningEffort') &&
      request.reasoningEffort !== undefined &&
      (this.reasoningEfforts === undefined ||
        this.reasoningEfforts.includes(request.reasoningEffort))
    ) {
      body['reasoning_effort'] = request.reasoningEffort;
    }
    if (request.stop && request.stop.length > 0) body['stop'] = request.stop;
    // Ask compatible servers to report real token usage in the final chunk.
    if (request.stream) body['stream_options'] = { include_usage: true };
    // Classic SillyTavern additional parameters: merge custom body keys, then
    // drop excluded keys. Forbidden headers are handled in headers().
    const finalBody = applyCustomBody(body, this.config.settings);

    let response: Response;
    // Adapter-owned deadlines (ТЗ §4.3): connect until headers arrive, then idle
    // between stream chunks (or a read deadline for non-streaming bodies). The
    // caller signal still cancels everything via the DeadlineController.
    const deadline = new DeadlineController(signal);
    deadline.arm(this.timeouts.connectMs, 'Timed out connecting to provider');
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(finalBody),
        signal: deadline.signal,
      });
    } catch (error) {
      deadline.dispose();
      const normalized = normalizeProviderError(error, 'generation');
      this.log.warn('Provider connection failed', {
        kind: this.kind,
        model: request.model,
        requestId,
        code: normalized.code,
      });
      yield { type: 'error', code: normalized.code, message: normalized.message };
      return;
    }
    deadline.disarm();

    if (!response.ok) {
      deadline.dispose();
      const bodyText = await safeReadError(response);
      const failure = httpProviderError(response.status, 'generation', bodyText, {
        providerStatus: response.status,
      });
      this.log.warn('Provider rejected generation request', {
        kind: this.kind,
        model: request.model,
        requestId,
        status: response.status,
        code: failure.code,
      });
      yield { type: 'error', code: failure.code, message: failure.message };
      return;
    }

    if (!request.stream) {
      deadline.arm(this.timeouts.readMs, 'Timed out reading provider response');
      try {
        const result = (await response.json()) as OpenAICompletionResponse;
        const content = result.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw new Error('Provider response does not contain assistant content');
        }
        yield { type: 'delta', text: content };
        const estimatedPromptTokens = estimateRequestTokens({
          model: request.model,
          messages: request.messages,
        }).tokens;
        const estimatedCompletionTokens = estimateTokens(content);
        yield {
          type: 'done',
          text: content,
          usage: {
            promptTokens: result.usage?.prompt_tokens ?? estimatedPromptTokens,
            completionTokens: result.usage?.completion_tokens ?? estimatedCompletionTokens,
            totalTokens:
              result.usage?.total_tokens ?? estimatedPromptTokens + estimatedCompletionTokens,
          },
        };
      } catch (error) {
        const normalized = normalizeProviderError(error, 'generation');
        yield { type: 'error', code: normalized.code, message: normalized.message };
      } finally {
        deadline.dispose();
      }
      return;
    }

    if (!response.body) {
      deadline.dispose();
      yield {
        type: 'error',
        code: ErrorCodes.GENERATION_FAILED,
        message: 'Provider returned an empty streaming response',
      };
      return;
    }

    let fullText = '';
    let streamUsage: OpenAIUsage | undefined;
    // Idle deadline: re-armed on every received chunk, so a stream that goes
    // silent (hung proxy, dead connection) is aborted even though the socket
    // is technically open.
    const idleMessage = 'Timed out waiting for provider stream data';
    deadline.arm(this.timeouts.idleMs, idleMessage);
    try {
      for await (const data of parseSseStream(response.body)) {
        deadline.arm(this.timeouts.idleMs, idleMessage);
        if (signal.aborted) {
          yield {
            type: 'error',
            code: ErrorCodes.GENERATION_CANCELLED,
            message: 'Generation aborted',
          };
          return;
        }
        if (data === '[DONE]') break;
        let chunk: OpenAIStreamChunk;
        try {
          chunk = JSON.parse(data) as OpenAIStreamChunk;
        } catch {
          continue; // ignore malformed keep-alive lines
        }
        if (chunk.usage) streamUsage = chunk.usage;
        const first = chunk.choices?.[0];
        const delta = first?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          fullText += delta;
          // Disarm across the yield: a slow consumer applying backpressure
          // suspends this generator, and the idle deadline firing during the
          // pause would abort a healthy stream (PROV-33 L5). Backpressure is
          // not provider silence.
          deadline.disarm();
          yield { type: 'delta', text: delta };
          deadline.arm(this.timeouts.idleMs, idleMessage);
        }
      }
    } catch (error) {
      const normalized = normalizeProviderError(error, 'streaming');
      this.log.warn('Provider stream failed', {
        kind: this.kind,
        model: request.model,
        requestId,
        code: normalized.code,
      });
      yield { type: 'error', code: normalized.code, message: normalized.message };
      return;
    } finally {
      deadline.dispose();
    }

    // Prefer the provider-reported usage (final SSE chunk); fall back to the
    // local estimate when the server did not send any.
    const estimatedPrompt = estimateRequestTokens({
      model: request.model,
      messages: request.messages,
    }).tokens;
    const estimatedCompletion = estimateTokens(fullText);
    yield {
      type: 'done',
      text: fullText,
      usage: {
        promptTokens: streamUsage?.prompt_tokens ?? estimatedPrompt,
        completionTokens: streamUsage?.completion_tokens ?? estimatedCompletion,
        totalTokens:
          streamUsage?.total_tokens ??
          (streamUsage?.prompt_tokens ?? estimatedPrompt) +
            (streamUsage?.completion_tokens ?? estimatedCompletion),
      },
    };
  }

  /**
   * Token counting via the shared offline tokenizer registry: exact tiktoken
   * profiles for known OpenAI model families, explicit approximation otherwise
   * (ТЗ §4.3 countTokens, AGENTS.md §10).
   */
  async countTokens(request: TokenCountRequest): Promise<TokenCount> {
    const resolved = await OpenAICompatibleAdapter.tokenizers.resolve(request.model);
    const perMessageOverhead = 4; // role + separators
    let tokens = 0;
    for (const message of request.messages) {
      tokens += (await resolved.count(message.content)) + perMessageOverhead;
    }
    return { tokens, approximate: resolved.approximate };
  }
}

async function safeReadError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return '';
  }
}
