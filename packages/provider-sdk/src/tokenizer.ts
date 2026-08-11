/**
 * Local, offline token estimation.
 *
 * Exact tokenizers (tiktoken / SentencePiece / HF tokenizer JSON) can be added
 * as model-specific plugins (ТЗ §10). Until an exact tokenizer is registered
 * for a model, we use a script-aware character heuristic and mark the result
 * as an approximation — callers must surface that to the user (AGENTS.md §10).
 */
import type { TokenCount, TokenCountRequest } from './types.js';
import { getEncoding, type Tiktoken } from 'js-tiktoken';
import { estimateTokens as sharedEstimateTokens } from '@neotavern/shared';
import { createDeepSeekTokenizerProfile, type TokenizerModelOptions } from './tokenizerModels.js';

/** Rough token estimate for a single piece of text (script-aware; exact
 * profiles registered for a model always win). */
export function estimateTokens(text: string): number {
  return sharedEstimateTokens(text);
}

/** Estimate the total prompt tokens for a message array (approximate). */
export function estimateRequestTokens(request: TokenCountRequest): TokenCount {
  // ~4 tokens of per-message overhead (role, separators).
  const overhead = 4;
  const total = request.messages.reduce(
    (sum, message) => sum + estimateTokens(message.content) + overhead,
    0,
  );
  return { tokens: total, approximate: true };
}

/** Local tokenizer profile registered by core or a process-isolated provider plugin. */
export interface TokenizerProfile {
  /** Stable diagnostic id, for example `openai:o200k_base`. */
  readonly id: string;
  /** Higher-priority profiles win when multiple profiles match a model. */
  readonly priority?: number;
  /** False only for a deterministic exact tokenizer implementation. */
  readonly approximate: boolean;
  matches(model: string): boolean | Promise<boolean>;
  count(text: string): number | Promise<number>;
}

/** Resolved tokenizer with an async, memoized text counter. */
export interface ResolvedTokenizer {
  profile: string;
  approximate: boolean;
  count(text: string): Promise<number>;
}

let cl100kEncoder: Tiktoken | undefined;
let o200kEncoder: Tiktoken | undefined;

/**
 * Register exact, offline Tiktoken profiles for known OpenAI model families
 * plus the DeepSeek family tokenizer. Unknown and local model names
 * deliberately continue to use the explicit approximate fallback unless a
 * provider plugin supplies their tokenizer.
 *
 * `options.tokenizerCacheDir` / `options.fetchImpl` override where the
 * DeepSeek tokenizer files are cached and how they are fetched (tests);
 * both default to the data-directory convention from config.ts.
 */
export function registerCoreTokenizers(
  registry: TokenizerRegistry,
  options?: TokenizerModelOptions,
): () => void {
  const cleanups = [
    registry.register({
      id: 'openai:o200k_base',
      priority: 200,
      approximate: false,
      matches: (model) => /(?:^|[/:])(?:gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4)(?:$|[-:])/i.test(model),
      count: (text) => {
        o200kEncoder ??= getEncoding('o200k_base');
        return o200kEncoder.encode(text).length;
      },
    }),
    registry.register({
      id: 'openai:cl100k_base',
      priority: 100,
      approximate: false,
      matches: (model) =>
        /(?:^|[/:])(?:gpt-4|gpt-3\.5-turbo|text-embedding-3)(?:$|[-:])/i.test(model),
      count: (text) => {
        cl100kEncoder ??= getEncoding('cl100k_base');
        return cl100kEncoder.encode(text).length;
      },
    }),
    registry.register(createDeepSeekTokenizerProfile(options)),
  ];
  return () => {
    for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]?.();
  };
}

/**
 * Local model-to-tokenizer registry.
 *
 * Provider plugins can register Tiktoken, SentencePiece, Hugging Face JSON or
 * model-specific profiles. Registration returns cleanup and the registry
 * always has an explicit approximate fallback.
 */
export class TokenizerRegistry {
  private readonly profiles: TokenizerProfile[] = [];

  register(profile: TokenizerProfile): () => void {
    if (profile.id.trim().length === 0) {
      throw new Error('Tokenizer profile id must not be empty');
    }
    this.profiles.push(profile);
    this.profiles.sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
    return () => {
      const index = this.profiles.indexOf(profile);
      if (index >= 0) this.profiles.splice(index, 1);
    };
  }

  async resolve(model: string): Promise<ResolvedTokenizer> {
    let profile: TokenizerProfile | undefined;
    for (const candidate of this.profiles) {
      // A broken plugin profile (throwing or hanging `matches`) must not
      // poison every generation: skip it and fall through to the next
      // candidate / approximate fallback (ADR-0007 «авария одного плагина не
      // останавливает prompt pipeline»). Hangs are bounded by the host-side
      // invocation timeout; throws are contained here.
      try {
        if (await candidate.matches(model)) {
          profile = candidate;
          break;
        }
      } catch {
        // Unusable profile — try the next one.
      }
    }
    if (!profile) {
      return {
        profile: 'approximate-character-v1',
        approximate: true,
        count: async (text) => estimateTokens(text),
      };
    }
    const cache = new Map<string, Promise<number>>();
    return {
      profile: profile.id,
      approximate: profile.approximate,
      count: async (text) => {
        const cached = cache.get(text);
        if (cached) return cached;
        const pending = Promise.resolve(profile.count(text)).then((tokens) => {
          if (!Number.isSafeInteger(tokens) || tokens < 0) {
            throw new Error(`Tokenizer "${profile.id}" returned an invalid token count`);
          }
          return tokens;
        });
        cache.set(text, pending);
        try {
          return await pending;
        } catch {
          // A failing exact tokenizer degrades to the character estimate
          // instead of taking the whole pipeline down with a 500.
          cache.delete(text);
          return estimateTokens(text);
        }
      },
    };
  }

  profilesList(): string[] {
    return this.profiles.map((profile) => profile.id);
  }
}
