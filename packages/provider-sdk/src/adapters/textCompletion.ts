/**
 * Text-completion adapter for local / self-hosted backends that expose an
 * OpenAI-compatible legacy `/v1/completions` endpoint (text-generation-webui
 * "ooba", koboldcpp, vLLM, Ollama, llama.cpp server, etc.).
 *
 * Unlike chat adapters this consumes a **serialized prompt**: the prompt
 * pipeline renders the instruct format and hands the adapter a single `user`
 * message whose content is the finished prompt (see docs/prompt-pipeline,
 * `serializeAsText`). The adapter flattens `request.messages` into that prompt
 * and posts it to `/completions` — never to `/chat/completions`.
 *
 * Uses only the global `fetch` (AGENTS.md §7); the API key is optional (local
 * servers rarely need one) and never logged.
 */
import type {
  GenerationEvent,
  GenerationParameterId,
  GenerationRequest,
  ModelInfo,
} from '@neotavern/contracts';
import { createLogger, ErrorCodes, randomToken, type Logger } from '@neotavern/shared';
import { parseSseStream } from '../sse.js';
import { estimateRequestTokens, estimateTokens } from '../tokenizer.js';
import { httpProviderError, normalizeProviderError, validateHttpBaseUrl } from '../errors.js';
import { findProviderCatalogEntry } from '../catalog.js';
import { applyCustomBody, applyCustomHeaders } from '../additionalParams.js';
import { DeadlineController, resolveTimeouts, type ProviderTimeouts } from '../timeouts.js';
import { promptFromMessages } from './prompt.js';
import type {
  ProviderAdapter,
  ProviderRuntimeConfig,
  TokenCount,
  TokenCountRequest,
  ValidationResult,
} from '../types.js';

interface CompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** Legacy completions chunks carry `text` (not `delta.content`). */
interface CompletionStreamChunk {
  choices?: Array<{ text?: unknown }>;
  usage?: CompletionUsage;
}

interface CompletionResponse {
  choices?: Array<{ text?: unknown }>;
  usage?: CompletionUsage;
}

interface CompletionModelEntry {
  id: string;
  context_length?: number;
  context_window?: number;
  max_context_length?: number;
}

interface CompletionModelsResponse {
  data?: CompletionModelEntry[];
}

export class TextCompletionAdapter implements ProviderAdapter {
  readonly kind = 'text-completion';
  readonly capabilities = { assistantPrefill: true, textCompletion: true } as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeouts: ProviderTimeouts;
  private readonly log: Logger;
  private readonly samplerSupport: readonly GenerationParameterId[];

  constructor(private readonly config: ProviderRuntimeConfig) {
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeouts = resolveTimeouts(config.timeouts);
    this.log = config.logger ?? createLogger({ scope: 'provider:text-completion' });
    this.samplerSupport = findProviderCatalogEntry(config.settings['source'])?.samplerSupport ?? [
      'temperature',
      'topP',
      'topK',
      'minP',
      'topA',
      'repetitionPenalty',
      'frequencyPenalty',
      'presencePenalty',
      'seed',
    ];
  }

  private get baseUrl(): string {
    return (this.config.baseUrl ?? '').replace(/\/+$/, '');
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
      const json = (await response.json()) as CompletionModelsResponse;
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
      this.log.warn('Provider model listing failed', { kind: this.kind });
      throw normalizeProviderError(error, 'listModels');
    } finally {
      deadline.dispose();
    }
  }

  async *generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GenerationEvent> {
    const requestId = randomToken(8);
    yield { type: 'start', requestId };

    const prompt = `${promptFromMessages(request.messages)}${request.assistantPrefill ?? ''}`;
    const body: Record<string, unknown> = {
      model: request.model,
      prompt,
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
    if (request.stop && request.stop.length > 0) body['stop'] = request.stop;
    if (request.stream) body['stream_options'] = { include_usage: true };
    // Classic SillyTavern additional parameters: merge custom body keys, then
    // drop excluded keys. Forbidden headers are handled in headers().
    const finalBody = applyCustomBody(body, this.config.settings);

    let response: Response;
    const deadline = new DeadlineController(signal);
    deadline.arm(this.timeouts.connectMs, 'Timed out connecting to provider');
    try {
      response = await this.fetchImpl(`${this.baseUrl}/completions`, {
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
        const result = (await response.json()) as CompletionResponse;
        const content = result.choices?.[0]?.text;
        if (typeof content !== 'string') {
          throw new Error('Provider response does not contain completion text');
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
    let streamUsage: CompletionUsage | undefined;
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
        let chunk: CompletionStreamChunk;
        try {
          chunk = JSON.parse(data) as CompletionStreamChunk;
        } catch {
          continue;
        }
        if (chunk.usage) streamUsage = chunk.usage;
        const text = chunk.choices?.[0]?.text;
        if (typeof text === 'string' && text.length > 0) {
          fullText += text;
          // Disarm across the yield: consumer backpressure must not count
          // against the provider idle deadline (PROV-33 L5).
          deadline.disarm();
          yield { type: 'delta', text };
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
   * Approximate counting over the serialized prompt. Local text-completion
   * models rarely ship a bundled tokenizer, so the count is explicitly marked
   * approximate (AGENTS.md §10).
   */
  async countTokens(request: TokenCountRequest): Promise<TokenCount> {
    const prompt = promptFromMessages(request.messages);
    return { tokens: estimateTokens(prompt), approximate: true };
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
