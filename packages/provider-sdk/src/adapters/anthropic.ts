import Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParamsBase } from '@anthropic-ai/sdk/resources/messages';
import type { GenerationEvent, GenerationRequest, ModelInfo } from '@neotavern/contracts';
import { AppError, createLogger, ErrorCodes, randomToken, type Logger } from '@neotavern/shared';
import { normalizeProviderError } from '../errors.js';
import { DeadlineController, resolveTimeouts, type ProviderTimeouts } from '../timeouts.js';
import type {
  ProviderAdapter,
  ProviderRuntimeConfig,
  TokenCount,
  TokenCountRequest,
  ValidationResult,
} from '../types.js';

interface AnthropicPrompt {
  system?: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
}

/** Native Anthropic Messages API adapter with prompt caching and adaptive thinking. */
export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = 'anthropic';
  readonly capabilities = { assistantPrefill: true } as const;
  private readonly client: Anthropic;
  private readonly timeouts: ProviderTimeouts;
  private readonly log: Logger;

  constructor(private readonly config: ProviderRuntimeConfig) {
    this.timeouts = resolveTimeouts(config.timeouts);
    this.log = config.logger ?? createLogger({ scope: 'provider:anthropic' });
    this.client = new Anthropic({
      apiKey: config.apiKey ?? '',
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
      maxRetries: 0,
      timeout: Math.max(this.timeouts.connectMs, this.timeouts.readMs),
    });
  }

  async validateConfig(): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [];
    if (!this.config.apiKey || this.config.apiKey.trim().length === 0) {
      issues.push({ path: 'apiKey', message: 'apiKey is required' });
    }
    if (this.config.baseUrl) {
      try {
        void new URL(this.config.baseUrl);
      } catch {
        issues.push({ path: 'baseUrl', message: 'baseUrl is not a valid URL' });
      }
    }
    return { valid: issues.length === 0, issues };
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const deadline = new DeadlineController(signal);
    deadline.arm(this.timeouts.readMs, 'Timed out listing Anthropic models');
    try {
      const models: ModelInfo[] = [];
      for await (const model of this.client.models.list(
        { limit: 100 },
        { signal: deadline.signal },
      )) {
        models.push({
          id: model.id,
          name: model.display_name,
          ...(model.max_input_tokens ? { contextLimit: model.max_input_tokens } : {}),
        });
        if (models.length >= 1000) break;
      }
      return models;
    } catch (error) {
      const normalized = this.normalizeError(error, 'listModels', signal, deadline.signal);
      this.log.warn('Anthropic model listing failed', { kind: this.kind, code: normalized.code });
      throw normalized;
    } finally {
      deadline.dispose();
    }
  }

  async *generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GenerationEvent> {
    const requestId = randomToken(8);
    yield { type: 'start', requestId };

    const deadline = new DeadlineController(signal);
    try {
      const prompt = this.toAnthropicPrompt([
        ...request.messages,
        ...(request.assistantPrefill
          ? [{ role: 'assistant' as const, content: request.assistantPrefill }]
          : []),
      ]);
      const reasoningEffort = this.mapEffort(request.reasoningEffort);
      const common: MessageCreateParamsBase = {
        model: request.model,
        max_tokens: request.maxTokens,
        messages: prompt.messages,
        ...(prompt.system ? { system: prompt.system } : {}),
        ...(request.stop && request.stop.length > 0 ? { stop_sequences: request.stop } : {}),
        ...(request.reasoning
          ? {
              thinking: { type: 'adaptive' },
              ...(reasoningEffort ? { output_config: { effort: reasoningEffort } } : {}),
            }
          : {}),
      };

      if (!request.stream) {
        deadline.arm(this.timeouts.readMs, 'Timed out reading Anthropic response');
        const response = await this.client.messages.create(
          { ...common, stream: false },
          { signal: deadline.signal },
        );
        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');
        if (text.length > 0) yield { type: 'delta', text };
        yield {
          type: 'done',
          text,
          usage: {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
            totalTokens: response.usage.input_tokens + response.usage.output_tokens,
          },
        };
        return;
      }

      deadline.arm(this.timeouts.connectMs, 'Timed out connecting to Anthropic');
      const stream = this.client.messages.stream(common, { signal: deadline.signal });
      let text = '';
      for await (const event of stream) {
        deadline.arm(this.timeouts.idleMs, 'Timed out waiting for Anthropic stream data');
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          text += event.delta.text;
          yield { type: 'delta', text: event.delta.text };
        }
      }
      deadline.disarm();
      const finalMessage = await stream.finalMessage();
      if (text.length === 0) {
        text = finalMessage.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');
        if (text.length > 0) yield { type: 'delta', text };
      }
      yield {
        type: 'done',
        text,
        usage: {
          promptTokens: finalMessage.usage.input_tokens,
          completionTokens: finalMessage.usage.output_tokens,
          totalTokens: finalMessage.usage.input_tokens + finalMessage.usage.output_tokens,
        },
      };
    } catch (error) {
      const normalized = this.normalizeError(error, 'generation', signal, deadline.signal);
      this.log.warn('Anthropic generation failed', {
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
    const prompt = this.toAnthropicPrompt(request.messages);
    const signal = AbortSignal.timeout(this.timeouts.readMs);
    try {
      const count = await this.client.messages.countTokens(
        {
          model: request.model,
          messages: prompt.messages,
          ...(prompt.system ? { system: prompt.system } : {}),
        },
        { signal },
      );
      return { tokens: count.input_tokens, approximate: false };
    } catch (error) {
      throw this.normalizeError(error, 'token counting', signal, signal);
    }
  }

  private toAnthropicPrompt(messages: TokenCountRequest['messages']): AnthropicPrompt {
    let index = 0;
    const leadingSystem: string[] = [];
    while (messages[index]?.role === 'system') {
      leadingSystem.push(messages[index]?.content ?? '');
      index += 1;
    }

    const converted: Anthropic.MessageParam[] = [];
    const pendingSystem: string[] = [];
    const append = (role: 'user' | 'assistant', content: string): void => {
      const last = converted.at(-1);
      if (last?.role === role && typeof last.content === 'string') {
        last.content = `${last.content}\n\n${content}`;
      } else {
        converted.push({ role, content });
      }
    };

    for (; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message) continue;
      if (message.role === 'system') {
        pendingSystem.push(message.content);
        continue;
      }
      if (message.role === 'assistant') {
        append('assistant', message.content);
        continue;
      }

      let content = message.content;
      if (message.role === 'tool') {
        const name =
          'name' in message && typeof message.name === 'string'
            ? ` (${message.name.replace(/\s+/g, ' ').slice(0, 200)})`
            : '';
        content = `--- tool message${name} ---\n${content}\n--- end tool message ---`;
      }
      if (pendingSystem.length > 0) {
        const reminders = pendingSystem
          .map((system) => `<system-reminder>\n${system}\n</system-reminder>`)
          .join('\n\n');
        content = `${reminders}\n\n${content}`;
        pendingSystem.length = 0;
      }
      append('user', content);
    }

    if (pendingSystem.length > 0) {
      append(
        'user',
        pendingSystem
          .map((system) => `<system-reminder>\n${system}\n</system-reminder>`)
          .join('\n\n'),
      );
    }
    if (!converted.some((message) => message.role === 'user')) {
      throw new AppError({
        code: ErrorCodes.GENERATION_FAILED,
        message: 'Anthropic requests require at least one user message',
      });
    }

    const system = leadingSystem.map<Anthropic.TextBlockParam>((text, systemIndex) => ({
      type: 'text',
      text,
      ...(systemIndex === leadingSystem.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
    }));
    return {
      ...(system.length > 0 ? { system } : {}),
      messages: converted,
    };
  }

  private mapEffort(
    effort: GenerationRequest['reasoningEffort'],
  ): 'low' | 'medium' | 'high' | undefined {
    if (effort === 'low' || effort === 'medium' || effort === 'high') return effort;
    // Preserve the previous minimal -> low behavior for saved presets. Other
    // provider-specific values are omitted instead of being silently changed.
    if (effort === 'minimal') return 'low';
    return undefined;
  }

  private normalizeError(
    error: unknown,
    context: string,
    callerSignal: AbortSignal,
    deadlineSignal: AbortSignal,
  ): AppError {
    if (callerSignal.aborted && callerSignal.reason instanceof AppError) {
      return callerSignal.reason;
    }
    if (
      callerSignal.aborted &&
      callerSignal.reason instanceof Error &&
      callerSignal.reason.name === 'TimeoutError'
    ) {
      return new AppError({
        code: ErrorCodes.TIMEOUT,
        message: `Anthropic ${context} timed out`,
        cause: error,
      });
    }
    if (callerSignal.aborted && callerSignal === deadlineSignal) {
      return new AppError({
        code: ErrorCodes.TIMEOUT,
        message: `Anthropic ${context} timed out`,
        cause: error,
      });
    }
    if (callerSignal.aborted) {
      return new AppError({
        code: ErrorCodes.GENERATION_CANCELLED,
        message: `Anthropic ${context} cancelled`,
        cause: error,
      });
    }
    if (deadlineSignal.aborted && deadlineSignal.reason instanceof AppError) {
      return deadlineSignal.reason;
    }
    if (error instanceof Anthropic.APIUserAbortError) {
      return new AppError({
        code: ErrorCodes.GENERATION_CANCELLED,
        message: `Anthropic ${context} cancelled`,
        cause: error,
      });
    }
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      return new AppError({
        code: ErrorCodes.TIMEOUT,
        message: `Anthropic ${context} timed out`,
        cause: error,
      });
    }
    if (
      error instanceof Anthropic.AuthenticationError ||
      error instanceof Anthropic.PermissionDeniedError
    ) {
      return new AppError({
        code: ErrorCodes.UNAUTHORIZED,
        message: `Anthropic rejected authentication during ${context}`,
        cause: error,
      });
    }
    if (error instanceof Anthropic.NotFoundError) {
      return new AppError({
        code: ErrorCodes.MODEL_NOT_FOUND,
        message: `Anthropic model or endpoint was not found during ${context}`,
        cause: error,
      });
    }
    if (error instanceof Anthropic.RateLimitError) {
      return new AppError({
        code: ErrorCodes.RATE_LIMITED,
        message: `Anthropic rate-limited ${context}`,
        cause: error,
      });
    }
    if (error instanceof Anthropic.APIError) {
      return new AppError({
        code: ErrorCodes.GENERATION_FAILED,
        params: { providerStatus: error.status },
        message: `Anthropic API failed during ${context}`,
        cause: error,
      });
    }
    return normalizeProviderError(error, context);
  }
}
