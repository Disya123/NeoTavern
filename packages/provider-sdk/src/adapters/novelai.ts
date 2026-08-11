/**
 * NovelAI text-generation adapter (classic SillyTavern "NovelAI" backend).
 *
 * Implemented against NovelAI's documented HTTP API using only the global
 * `fetch` (AGENTS.md §7): `POST {baseUrl}/ai/generate` with a Bearer API key,
 * body `{ input, model, parameters }`, response `{ output }`. Generation is
 * non-streaming — a single `delta` + terminal `done` is emitted, matching the
 * unified event contract. Model discovery is not offered by the API, so
 * `listModels` returns the configured model.
 *
 * Marked **experimental**: NovelAI's parameter surface evolves; only the
 * well-established samplers are mapped. The API key is never logged.
 */
import type {
  GenerationEvent,
  GenerationParameterId,
  GenerationRequest,
  ModelInfo,
} from '@neotavern/contracts';
import { createLogger, randomToken, type Logger } from '@neotavern/shared';
import { estimateRequestTokens, estimateTokens } from '../tokenizer.js';
import { httpProviderError, normalizeProviderError, validateHttpBaseUrl } from '../errors.js';
import { DeadlineController, resolveTimeouts, type ProviderTimeouts } from '../timeouts.js';
import { promptFromMessages } from './prompt.js';
import type {
  ProviderAdapter,
  ProviderRuntimeConfig,
  TokenCount,
  TokenCountRequest,
  ValidationResult,
} from '../types.js';

const DEFAULT_BASE_URL = 'https://api.novelai.net';

interface NovelAIGenerateResponse {
  output?: unknown;
}

/**
 * Samplers the NovelAI adapter actually maps onto the request body. The
 * provider catalog exposes exactly this list so the UI picker cannot offer
 * parameters the adapter would silently drop (PROV-33 L1).
 */
export const NOVELAI_SAMPLERS = [
  'temperature',
  'topP',
  'topK',
  'topA',
  'repetitionPenalty',
  'frequencyPenalty',
  'presencePenalty',
  'seed',
] as const satisfies readonly GenerationParameterId[];

export class NovelAIAdapter implements ProviderAdapter {
  readonly kind = 'novelai';
  readonly capabilities = { assistantPrefill: true, textCompletion: true } as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeouts: ProviderTimeouts;
  private readonly log: Logger;
  private readonly samplerSupport: readonly GenerationParameterId[] = NOVELAI_SAMPLERS;

  constructor(private readonly config: ProviderRuntimeConfig) {
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeouts = resolveTimeouts(config.timeouts);
    this.log = config.logger ?? createLogger({ scope: 'provider:novelai' });
  }

  private get baseUrl(): string {
    const url = this.config.baseUrl ?? DEFAULT_BASE_URL;
    return url.replace(/\/+$/, '');
  }

  private supports(parameter: GenerationParameterId): boolean {
    return this.samplerSupport.includes(parameter);
  }

  async validateConfig(): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [];
    if (!this.config.apiKey || this.config.apiKey.trim().length === 0) {
      issues.push({ path: 'apiKey', message: 'apiKey is required' });
    }
    issues.push(...validateHttpBaseUrl(this.baseUrl, { required: false }));
    return { valid: issues.length === 0, issues };
  }

  async listModels(_signal: AbortSignal): Promise<ModelInfo[]> {
    // NovelAI does not expose a model listing; surface the configured model so
    // the UI has a selectable entry rather than an empty picker.
    const model = this.config.model?.trim();
    return model && model.length > 0 ? [{ id: model, name: model }] : [];
  }

  async *generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GenerationEvent> {
    const requestId = randomToken(8);
    yield { type: 'start', requestId };

    const parameters: Record<string, unknown> = {
      max_length: request.maxTokens,
      // A non-positive seed means "random" to NovelAI.
      seed: this.supports('seed') && request.seed !== undefined ? request.seed : -1,
    };
    if (this.supports('temperature')) parameters['temperature'] = request.temperature;
    if (this.supports('topP') && request.topP !== undefined) parameters['top_p'] = request.topP;
    if (this.supports('topK') && request.topK !== undefined) parameters['top_k'] = request.topK;
    if (this.supports('topA') && request.topA !== undefined) parameters['top_a'] = request.topA;
    if (this.supports('repetitionPenalty') && request.repetitionPenalty !== undefined) {
      parameters['repetition_penalty'] = request.repetitionPenalty;
    }
    if (this.supports('frequencyPenalty') && request.frequencyPenalty !== undefined) {
      parameters['frequency_penalty'] = request.frequencyPenalty;
    }
    if (this.supports('presencePenalty') && request.presencePenalty !== undefined) {
      parameters['presence_penalty'] = request.presencePenalty;
    }
    if (request.stop && request.stop.length > 0) parameters['stop_sequences'] = request.stop;

    const body = {
      input: `${promptFromMessages(request.messages)}${request.assistantPrefill ?? ''}`,
      model: request.model,
      parameters,
    };

    const deadline = new DeadlineController(signal);
    deadline.arm(
      Math.max(this.timeouts.connectMs, this.timeouts.readMs),
      'Timed out waiting for NovelAI generation',
    );
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/ai/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: deadline.signal,
      });
      if (!response.ok) {
        const bodyText = await safeReadError(response);
        throw httpProviderError(response.status, 'generation', bodyText, {
          providerStatus: response.status,
        });
      }
      const result = (await response.json()) as NovelAIGenerateResponse;
      if (typeof result.output !== 'string') {
        throw new Error('NovelAI response does not contain output text');
      }
      const text = result.output;
      if (text.length > 0) yield { type: 'delta', text };
      const promptTokens = estimateRequestTokens({
        model: request.model,
        messages: request.messages,
      }).tokens;
      const completionTokens = estimateTokens(text);
      yield {
        type: 'done',
        text,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
      };
    } catch (error) {
      const normalized = normalizeProviderError(error, 'generation');
      this.log.warn('NovelAI generation failed', {
        kind: this.kind,
        model: request.model,
        requestId,
        code: normalized.code,
      });
      yield { type: 'error', code: normalized.code, message: normalized.message };
    } finally {
      deadline.dispose();
    }
  }

  async countTokens(request: TokenCountRequest): Promise<TokenCount> {
    return { tokens: estimateTokens(promptFromMessages(request.messages)), approximate: true };
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
