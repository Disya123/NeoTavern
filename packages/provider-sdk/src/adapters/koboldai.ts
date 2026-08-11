/**
 * KoboldAI Classic adapter (classic SillyTavern "KoboldAI" backend).
 *
 * Talks to a KoboldAI/Kobold server's native API using only the global `fetch`
 * (AGENTS.md §7): `POST {baseUrl}/api/v1/generate` with a prompt and sampler
 * body, response `{ results: [{ text }] }`. Generation is non-streaming — one
 * `delta` + terminal `done`. The loaded model is read from `GET /api/v1/model`
 * for discovery. No API key is required for typical local installs.
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

interface KoboldGenerateResponse {
  results?: Array<{ text?: unknown }>;
}

interface KoboldModelResponse {
  result?: unknown;
}

/**
 * Samplers the KoboldAI adapter actually maps onto the request body; the
 * provider catalog mirrors this list (PROV-33 L1).
 */
export const KOBOLDAI_SAMPLERS = [
  'temperature',
  'topP',
  'topK',
  'topA',
  'repetitionPenalty',
] as const satisfies readonly GenerationParameterId[];

export class KoboldAIAdapter implements ProviderAdapter {
  readonly kind = 'koboldai';
  readonly capabilities = { assistantPrefill: true, textCompletion: true } as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeouts: ProviderTimeouts;
  private readonly log: Logger;
  private readonly samplerSupport: readonly GenerationParameterId[] = KOBOLDAI_SAMPLERS;

  constructor(private readonly config: ProviderRuntimeConfig) {
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeouts = resolveTimeouts(config.timeouts);
    this.log = config.logger ?? createLogger({ scope: 'provider:koboldai' });
  }

  private get baseUrl(): string {
    return (this.config.baseUrl ?? '').replace(/\/+$/, '');
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
    deadline.arm(this.timeouts.readMs, 'Timed out querying KoboldAI model');
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/v1/model`, {
        signal: deadline.signal,
      });
      if (!response.ok) {
        const body = await safeReadError(response);
        throw httpProviderError(response.status, 'listModels', body);
      }
      const json = (await response.json()) as KoboldModelResponse;
      const name = typeof json.result === 'string' ? json.result : '';
      return name.length > 0 ? [{ id: name, name }] : [];
    } catch (error) {
      this.log.warn('KoboldAI model query failed', { kind: this.kind });
      throw normalizeProviderError(error, 'listModels');
    } finally {
      deadline.dispose();
    }
  }

  async *generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GenerationEvent> {
    const requestId = randomToken(8);
    yield { type: 'start', requestId };

    const body: Record<string, unknown> = {
      prompt: `${promptFromMessages(request.messages)}${request.assistantPrefill ?? ''}`,
      max_length: request.maxTokens,
    };
    if (this.supports('temperature')) body['temperature'] = request.temperature;
    if (this.supports('topP') && request.topP !== undefined) body['top_p'] = request.topP;
    if (this.supports('topK') && request.topK !== undefined) body['top_k'] = request.topK;
    if (this.supports('topA') && request.topA !== undefined) body['top_a'] = request.topA;
    if (this.supports('repetitionPenalty') && request.repetitionPenalty !== undefined) {
      body['rep_pen'] = request.repetitionPenalty;
    }
    if (request.stop && request.stop.length > 0) body['stop_sequence'] = request.stop;

    const deadline = new DeadlineController(signal);
    deadline.arm(
      Math.max(this.timeouts.connectMs, this.timeouts.readMs),
      'Timed out waiting for KoboldAI generation',
    );
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/v1/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: deadline.signal,
      });
      if (!response.ok) {
        const bodyText = await safeReadError(response);
        throw httpProviderError(response.status, 'generation', bodyText, {
          providerStatus: response.status,
        });
      }
      const result = (await response.json()) as KoboldGenerateResponse;
      const text = result.results?.[0]?.text;
      if (typeof text !== 'string') {
        throw new Error('KoboldAI response does not contain result text');
      }
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
      this.log.warn('KoboldAI generation failed', {
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
