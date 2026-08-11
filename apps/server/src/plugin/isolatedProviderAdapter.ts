/** Provider adapter proxy for one capability-isolated plugin worker. */
import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  GenerationEventSchema,
  ImageEventSchema,
  ModelInfoSchema,
  SpeechEventSchema,
  type GenerationEvent,
  type GenerationRequest,
  type ImageEvent,
  type ImageRequest,
  type ModelInfo,
  type SpeechEvent,
  type SpeechRequest,
  type TranscriptionRequest,
  type TranscriptionResult,
} from '@neotavern/contracts';
import type {
  ProviderAdapter,
  ProviderRuntimeConfig,
  TokenCount,
  TokenCountRequest,
  ValidationResult,
} from '@neotavern/provider-sdk';
import { AppError, ErrorCodes } from '@neotavern/shared';

export interface PluginCallbackProcess {
  invokeCallback(
    registrationId: string,
    operation: string,
    payload: unknown,
    signal: AbortSignal,
    onEvent?: (value: unknown) => void,
    options?: { idleTimeoutMs?: number },
  ): Promise<unknown>;
}

/** Bridges a registered plugin provider to its isolated worker callback. */
export class IsolatedPluginProviderAdapter implements ProviderAdapter {
  constructor(
    readonly kind: string,
    private readonly registrationId: string,
    private readonly config: ProviderRuntimeConfig,
    private readonly process: PluginCallbackProcess,
    readonly capabilities?: Readonly<{ assistantPrefill?: boolean; textCompletion?: boolean }>,
  ) {}

  async validateConfig(): Promise<ValidationResult> {
    const value = await this.process.invokeCallback(
      this.registrationId,
      'provider.validateConfig',
      { config: serializableProviderConfig(this.config) },
      new AbortController().signal,
    );
    return normalizeValidationResult(value);
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const value = await this.process.invokeCallback(
      this.registrationId,
      'provider.listModels',
      { config: serializableProviderConfig(this.config) },
      signal,
    );
    if (!Array.isArray(value) || !value.every((item) => Value.Check(ModelInfoSchema, item))) {
      throw invalidPluginCallback(this.kind, 'MODELS_INVALID');
    }
    return value as ModelInfo[];
  }

  async *generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GenerationEvent> {
    const queue: unknown[] = [];
    let wake: (() => void) | null = null;
    let settled = false;
    let failure: unknown;
    const completion = this.process
      .invokeCallback(
        this.registrationId,
        'provider.generate',
        { config: serializableProviderConfig(this.config), request },
        signal,
        (event) => {
          queue.push(event);
          wake?.();
          wake = null;
        },
        { idleTimeoutMs: this.config.timeouts?.idleMs ?? 60_000 },
      )
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        settled = true;
        wake?.();
        wake = null;
      });

    while (!settled || queue.length > 0) {
      const value = queue.shift();
      if (value !== undefined) {
        if (!Value.Check(GenerationEventSchema, value)) {
          throw invalidPluginCallback(this.kind, 'GENERATION_EVENT_INVALID');
        }
        yield value as GenerationEvent;
        continue;
      }
      await new Promise<void>((resolveWake) => {
        wake = resolveWake;
      });
    }
    await completion;
    if (failure) throw failure;
  }

  async *speech(request: SpeechRequest, signal: AbortSignal): AsyncIterable<SpeechEvent> {
    yield* this.streamCallback(
      'provider.speech',
      { config: serializableProviderConfig(this.config), request },
      signal,
      SpeechEventSchema,
    );
  }

  async *image(request: ImageRequest, signal: AbortSignal): AsyncIterable<ImageEvent> {
    yield* this.streamCallback(
      'provider.image',
      { config: serializableProviderConfig(this.config), request },
      signal,
      ImageEventSchema,
    );
  }

  async transcribe(
    request: TranscriptionRequest,
    signal: AbortSignal,
  ): Promise<TranscriptionResult> {
    const value = await this.process.invokeCallback(
      this.registrationId,
      'provider.transcribe',
      { config: serializableProviderConfig(this.config), request },
      signal,
    );
    if (!isMessage(value) || typeof value['text'] !== 'string') {
      throw invalidPluginCallback(this.kind, 'TRANSCRIPTION_INVALID');
    }
    return {
      text: value['text'],
      ...(typeof value['language'] === 'string' ? { language: value['language'] } : {}),
    };
  }

  async countTokens(request: TokenCountRequest): Promise<TokenCount> {
    const value = await this.process.invokeCallback(
      this.registrationId,
      'provider.countTokens',
      { config: serializableProviderConfig(this.config), request },
      new AbortController().signal,
    );
    if (
      !isMessage(value) ||
      !Number.isSafeInteger(value['tokens']) ||
      (value['tokens'] as number) < 0 ||
      typeof value['approximate'] !== 'boolean'
    ) {
      throw invalidPluginCallback(this.kind, 'TOKEN_COUNT_INVALID');
    }
    return { tokens: value['tokens'] as number, approximate: value['approximate'] };
  }

  private async *streamCallback<T>(
    operation: string,
    payload: unknown,
    signal: AbortSignal,
    schema: TSchema,
  ): AsyncIterable<T> {
    const queue: unknown[] = [];
    let wake: (() => void) | null = null;
    let settled = false;
    let failure: unknown;
    const completion = this.process
      .invokeCallback(
        this.registrationId,
        operation,
        payload,
        signal,
        (event) => {
          queue.push(event);
          wake?.();
          wake = null;
        },
        { idleTimeoutMs: this.config.timeouts?.idleMs ?? 60_000 },
      )
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        settled = true;
        wake?.();
        wake = null;
      });

    while (!settled || queue.length > 0) {
      const value = queue.shift();
      if (value !== undefined) {
        if (!Value.Check(schema, value)) {
          throw invalidPluginCallback(this.kind, 'PROVIDER_EVENT_INVALID');
        }
        yield value as T;
        continue;
      }
      await new Promise<void>((resolveWake) => {
        wake = resolveWake;
      });
    }
    await completion;
    if (failure) throw failure;
  }
}

function serializableProviderConfig(
  config: ProviderRuntimeConfig,
): Omit<ProviderRuntimeConfig, 'fetchImpl'> {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: config.apiKey,
    settings: config.settings,
  };
}

function normalizeValidationResult(value: unknown): ValidationResult {
  if (!isMessage(value) || typeof value['valid'] !== 'boolean' || !Array.isArray(value['issues'])) {
    throw invalidPluginCallback('unknown', 'VALIDATION_RESULT_INVALID');
  }
  const issues = value['issues'].filter(
    (issue): issue is { path: string; message: string } =>
      isMessage(issue) && typeof issue['path'] === 'string' && typeof issue['message'] === 'string',
  );
  if (issues.length !== value['issues'].length) {
    throw invalidPluginCallback('unknown', 'VALIDATION_RESULT_INVALID');
  }
  return { valid: value['valid'], issues };
}

function invalidPluginCallback(kind: string, reason: string): AppError {
  return new AppError({
    code: ErrorCodes.PLUGIN_LOAD_FAILED,
    params: { kind, reason },
  });
}

function isMessage(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
