/**
 * AI Horde (stablehorde.net) text-generation adapter.
 *
 * AI Horde is an asynchronous crowdsourced cluster: a job is submitted with
 * `POST /api/v2/generate/text/async`, then polled via
 * `GET /api/v2/generate/text/status/{id}` until `done`. The poll loop runs
 * inside the generator, re-checking the caller signal and an idle deadline so a
 * stuck job is aborted instead of polling forever. Anonymous use is allowed
 * (lower priority); an API key is sent as the `apikey` header when configured.
 * Uses only the global `fetch` (AGENTS.md §7).
 */
import type {
  GenerationEvent,
  GenerationParameterId,
  GenerationRequest,
  ModelInfo,
} from '@neotavern/contracts';
import { createLogger, ErrorCodes, randomToken, sleep, type Logger } from '@neotavern/shared';
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

const DEFAULT_BASE_URL = 'https://stablehorde.net';
/** Default pause between status polls while a job is queued/processing. */
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** Floor for the poll interval so a misconfiguration cannot hot-loop. */
const MIN_POLL_INTERVAL_MS = 250;

interface HordeAsyncResponse {
  id?: unknown;
  message?: unknown;
}

interface HordeGeneration {
  text?: unknown;
  state?: unknown;
}

interface HordeStatusResponse {
  done?: boolean;
  faulted?: boolean;
  generations?: HordeGeneration[];
}

interface HordeModelEntry {
  name?: unknown;
}

/**
 * Samplers the AI Horde adapter actually maps onto the request; the provider
 * catalog mirrors this list (PROV-33 L1).
 */
export const AI_HORDE_SAMPLERS = [
  'temperature',
  'topP',
  'topK',
  'repetitionPenalty',
] as const satisfies readonly GenerationParameterId[];

export class AIHordeAdapter implements ProviderAdapter {
  readonly kind = 'ai-horde';
  readonly capabilities = { assistantPrefill: true, textCompletion: true } as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeouts: ProviderTimeouts;
  private readonly log: Logger;
  private readonly pollIntervalMs: number;
  private readonly samplerSupport: readonly GenerationParameterId[] = AI_HORDE_SAMPLERS;

  constructor(private readonly config: ProviderRuntimeConfig) {
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeouts = resolveTimeouts(config.timeouts);
    this.log = config.logger ?? createLogger({ scope: 'provider:ai-horde' });
    this.pollIntervalMs = resolvePollInterval(config.settings['pollIntervalMs']);
  }

  private get baseUrl(): string {
    const url = this.config.baseUrl ?? DEFAULT_BASE_URL;
    return url.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      // "0000000000" is AI Horde's documented anonymous key.
      apikey:
        this.config.apiKey && this.config.apiKey.length > 0 ? this.config.apiKey : '0000000000',
      'Client-Agent': 'NeoTavern:2.0 (disya)',
    };
  }

  private supports(parameter: GenerationParameterId): boolean {
    return this.samplerSupport.includes(parameter);
  }

  async validateConfig(): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [
      ...validateHttpBaseUrl(this.baseUrl, { required: false }),
    ];
    return { valid: issues.length === 0, issues };
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const deadline = new DeadlineController(signal);
    deadline.arm(this.timeouts.readMs, 'Timed out listing AI Horde models');
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/v2/status/models?type=text`, {
        headers: this.headers(),
        signal: deadline.signal,
      });
      if (!response.ok) {
        const body = await safeReadError(response);
        throw httpProviderError(response.status, 'listModels', body);
      }
      const json = (await response.json()) as HordeModelEntry[];
      if (!Array.isArray(json)) return [];
      return json
        .map((entry) => (typeof entry.name === 'string' ? entry.name : ''))
        .filter((name) => name.length > 0)
        .map((name) => ({ id: name, name }));
    } catch (error) {
      this.log.warn('AI Horde model listing failed', { kind: this.kind });
      throw normalizeProviderError(error, 'listModels');
    } finally {
      deadline.dispose();
    }
  }

  async *generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GenerationEvent> {
    const requestId = randomToken(8);
    yield { type: 'start', requestId };

    const params: Record<string, unknown> = {
      max_length: request.maxTokens,
    };
    if (this.supports('temperature')) params['temperature'] = request.temperature;
    if (this.supports('topP') && request.topP !== undefined) params['top_p'] = request.topP;
    if (this.supports('topK') && request.topK !== undefined) params['top_k'] = request.topK;
    if (this.supports('repetitionPenalty') && request.repetitionPenalty !== undefined) {
      params['rep_pen'] = request.repetitionPenalty;
    }
    if (request.stop && request.stop.length > 0) params['stop_sequence'] = request.stop;

    const body = {
      prompt: `${promptFromMessages(request.messages)}${request.assistantPrefill ?? ''}`,
      params,
      models: [request.model],
    };

    const deadline = new DeadlineController(signal);
    let jobId: string;
    try {
      deadline.arm(this.timeouts.connectMs, 'Timed out submitting AI Horde job');
      const response = await this.fetchImpl(`${this.baseUrl}/api/v2/generate/text/async`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: deadline.signal,
      });
      if (!response.ok) {
        const bodyText = await safeReadError(response);
        throw httpProviderError(response.status, 'generation', bodyText, {
          providerStatus: response.status,
        });
      }
      const accepted = (await response.json()) as HordeAsyncResponse;
      if (typeof accepted.id !== 'string' || accepted.id.length === 0) {
        throw new Error('AI Horde did not return a job id');
      }
      jobId = accepted.id;
    } catch (error) {
      deadline.dispose();
      const normalized = normalizeProviderError(error, 'generation');
      this.log.warn('AI Horde job submission failed', {
        kind: this.kind,
        model: request.model,
        requestId,
        code: normalized.code,
      });
      yield { type: 'error', code: normalized.code, message: normalized.message };
      return;
    }
    deadline.disarm();

    // Poll until the job is done. The idle deadline is re-armed on every poll
    // response, so a silently-stuck job aborts instead of polling forever.
    try {
      for (;;) {
        if (signal.aborted) {
          yield {
            type: 'error',
            code: ErrorCodes.GENERATION_CANCELLED,
            message: 'Generation aborted',
          };
          return;
        }
        deadline.arm(this.timeouts.idleMs, 'Timed out waiting for AI Horde job');
        const statusResponse = await this.fetchImpl(
          `${this.baseUrl}/api/v2/generate/text/status/${encodeURIComponent(jobId)}`,
          { headers: this.headers(), signal: deadline.signal },
        );
        deadline.disarm();
        if (!statusResponse.ok) {
          const bodyText = await safeReadError(statusResponse);
          throw httpProviderError(statusResponse.status, 'generation', bodyText, {
            providerStatus: statusResponse.status,
          });
        }
        const status = (await statusResponse.json()) as HordeStatusResponse;
        if (status.faulted === true) {
          throw new Error('AI Horde job faulted');
        }
        if (status.done === true) {
          const text = this.extractText(status);
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
          return;
        }
        // The idle deadline covers the wait between polls too, so a job that
        // answers "still queued" forever trips the idle timeout instead of
        // polling indefinitely (PROV-33 L2). The shared sleep rejects on
        // abort/deadline; the loop head turns a client abort into the
        // GENERATION_CANCELLED event and the next fetch surfaces a deadline
        // expiry as a provider error.
        deadline.arm(this.timeouts.idleMs, 'Timed out waiting for AI Horde job');
        try {
          await sleep(this.pollIntervalMs, deadline.signal);
        } catch {
          // Abort or idle deadline — handled by the loop head / next fetch.
        }
        deadline.disarm();
      }
    } catch (error) {
      const normalized = normalizeProviderError(error, 'generation');
      this.log.warn('AI Horde generation failed', {
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

  private extractText(status: HordeStatusResponse): string {
    const generations = status.generations ?? [];
    return generations
      .map((generation) => (typeof generation.text === 'string' ? generation.text : ''))
      .filter((text) => text.length > 0)
      .join('\n');
  }

  async countTokens(request: TokenCountRequest): Promise<TokenCount> {
    return { tokens: estimateTokens(promptFromMessages(request.messages)), approximate: true };
  }
}

/** Resolve the poll cadence, clamped so a bad value cannot hot-loop the API. */
function resolvePollInterval(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.max(MIN_POLL_INTERVAL_MS, Math.min(value, 60_000));
  }
  return DEFAULT_POLL_INTERVAL_MS;
}

async function safeReadError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return '';
  }
}
