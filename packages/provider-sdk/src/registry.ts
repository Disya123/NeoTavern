/**
 * Provider registry. Maps provider kinds to adapter factories. Plugins can
 * register new provider kinds at runtime (ТЗ §4.3) — registration returns a
 * cleanup function, consistent with the Plugin SDK contract.
 */
import { AppError, ErrorCodes } from '@neotavern/shared';
import { OpenAICompatibleAdapter } from './adapters/openaiCompatible.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { TextCompletionAdapter } from './adapters/textCompletion.js';
import { NovelAIAdapter } from './adapters/novelai.js';
import { KoboldAIAdapter } from './adapters/koboldai.js';
import { AIHordeAdapter } from './adapters/aiHorde.js';
import { EchoAdapter } from './adapters/echo.js';
import { registerCoreTokenizers, TokenizerRegistry } from './tokenizer.js';
import type { ProviderAdapter, ProviderAdapterFactory, ProviderRuntimeConfig } from './types.js';

export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderAdapterFactory>();
  /** Local tokenizer profiles shared by core providers and provider plugins. */
  readonly tokenizers = new TokenizerRegistry();

  constructor(registerBuiltins = true) {
    if (registerBuiltins) {
      this.register('openai-compatible', (config) => new OpenAICompatibleAdapter(config));
      this.register('anthropic', (config) => new AnthropicAdapter(config));
      this.register('text-completion', (config) => new TextCompletionAdapter(config));
      this.register('novelai', (config) => new NovelAIAdapter(config));
      this.register('koboldai', (config) => new KoboldAIAdapter(config));
      this.register('ai-horde', (config) => new AIHordeAdapter(config));
      this.register('echo', (config) => new EchoAdapter(config));
      registerCoreTokenizers(this.tokenizers);
    }
  }

  /** Register (or replace) a provider kind. Returns an unregister function. */
  register(kind: string, factory: ProviderAdapterFactory): () => void {
    this.factories.set(kind, factory);
    return () => {
      if (this.factories.get(kind) === factory) this.factories.delete(kind);
    };
  }

  has(kind: string): boolean {
    return this.factories.has(kind);
  }

  kinds(): string[] {
    return [...this.factories.keys()];
  }

  /** Instantiate an adapter for a kind. Throws PROVIDER_NOT_FOUND if unknown. */
  create(kind: string, config: ProviderRuntimeConfig): ProviderAdapter {
    const factory = this.factories.get(kind);
    if (!factory) {
      throw new AppError({
        code: ErrorCodes.PROVIDER_NOT_FOUND,
        params: { kind },
        message: `No provider registered for kind "${kind}"`,
      });
    }
    return factory(config);
  }
}
