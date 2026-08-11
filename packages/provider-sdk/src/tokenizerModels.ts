/**
 * Model-specific offline tokenizers registered by core.
 *
 * DeepSeek ships a byte-level BPE tokenizer (128 000 vocab, GPT-2-style
 * regex pre-tokenizer with a ByteLevel stage). Counting runs through the
 * compact `DeepSeekCountingBpe` engine (see deepseekBpe.ts): the official
 * `tokenizer.json` is downloaded once, converted into a ~1.4 MB ranks file
 * plus the added-token list, and cached in `data/cache/tokenizers/` — the
 * ~6 MB JSON and the tokenizers runtime are never kept.
 *
 * The download is best-effort: a failed or offline load degrades the profile
 * to the explicit approximate fallback (AGENTS.md §10) and is retried with a
 * bounded interval, so a missing tokenizer never blocks generation.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { convertDeepSeekTokenizer, DeepSeekCountingBpe } from './deepseekBpe.js';
import type { TokenizerProfile } from './tokenizer.js';

/** Model names that use the DeepSeek family tokenizer (OpenRouter-style
 * `deepseek/...` slugs, official `deepseek-chat`/`deepseek-reasoner`, local
 * `DeepSeek-V3` style checkpoints). Anchored so `notdeepseek` never matches. */
export const DEEPSEEK_MODEL_RE = /(?:^|[/:])deepseek(?:$|[-:._])/i;

/** HF repo shipping the tokenizer files; the V4-Flash vocab/merges are
 * identical to V3 (verified byte-for-byte), so one repo serves the family. */
export const DEEPSEEK_REPO = 'deepseek-ai/DeepSeek-V4-Flash';

/** After a failed download, do not retry for this long (prevents hammering
 * HF on every keystroke preview while offline). */
export const TOKENIZER_RETRY_MS = 15 * 60_000;

/** Single bounded download attempt budget. */
export const DOWNLOAD_TIMEOUT_MS = 30_000;

/** Compact cache payload produced by `convertDeepSeekTokenizer`. */
export interface DeepSeekTokenizerData {
  /** tiktoken-style ranks text (`<rank> <b64> <b64> …`). */
  ranksText: string;
  /** Contents of ALL added_tokens (special or not), pre-split from text. */
  addedTokens: string[];
}

export interface TokenizerModelOptions {
  /** Where tokenizer cache files are stored; defaults to the same
   * directory the server derives from `NEOTA_DATA_DIR` (config.ts). */
  cacheDir?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

function defaultTokenizerCacheDir(): string {
  const dataDir = process.env['NEOTA_DATA_DIR'];
  const base = dataDir ? resolve(dataDir) : resolve(process.cwd(), 'data');
  return join(base, 'cache', 'tokenizers');
}

function tokenizerFilePaths(cacheDir: string): { ranks: string; added: string } {
  return {
    ranks: join(cacheDir, 'deepseek-v4-flash', 'deepseek.tiktoken'),
    added: join(cacheDir, 'deepseek-v4-flash', 'added.json'),
  };
}

/** Module-level singleton: one download / one loaded tokenizer per process,
 * shared by the server registry and every adapter's static registry. On
 * success the promise is retained (no re-parse of the ranks per count); on
 * failure it is cleared and retried after TOKENIZER_RETRY_MS. */
let deepseekLoad: Promise<DeepSeekCountingBpe | null> | undefined;
let deepseekFailureAt = 0;

async function readCachedTokenizer(cacheDir: string): Promise<DeepSeekCountingBpe | null> {
  const { ranks, added } = tokenizerFilePaths(cacheDir);
  try {
    const [ranksText, addedJson] = await Promise.all([
      readFile(ranks, 'utf8'),
      readFile(added, 'utf8'),
    ]);
    const addedTokens: unknown = JSON.parse(addedJson);
    if (!Array.isArray(addedTokens) || !addedTokens.every((s) => typeof s === 'string')) {
      return null;
    }
    return new DeepSeekCountingBpe(ranksText, addedTokens as string[]);
  } catch {
    return null;
  }
}

async function downloadTokenizer(
  cacheDir: string,
  fetchImpl: typeof fetch,
): Promise<DeepSeekCountingBpe> {
  await mkdir(join(cacheDir, 'deepseek-v4-flash'), { recursive: true });
  const response = await fetchImpl(
    `https://huggingface.co/${DEEPSEEK_REPO}/resolve/main/tokenizer.json`,
    {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`DeepSeek tokenizer download failed (${response.status})`);
  }
  const tokenizerJson: unknown = await response.json();
  const data = convertDeepSeekTokenizer(tokenizerJson);
  const { ranks, added } = tokenizerFilePaths(cacheDir);
  const writes = [
    { target: ranks, body: data.ranksText },
    { target: added, body: JSON.stringify(data.addedTokens) },
  ];
  // Atomic writes: temp file + rename (AGENTS.md §12); a crash mid-write
  // leaves only a stale .tmp-* that the next read ignores.
  for (const { target, body } of writes) {
    const temp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
    await writeFile(temp, body, 'utf8');
    await rename(temp, target);
  }
  return new DeepSeekCountingBpe(data.ranksText, data.addedTokens);
}

/**
 * Load (or download once) the DeepSeek tokenizer. Returns `null` on any
 * failure — cache miss, network error, malformed file — so callers can
 * degrade to the approximate fallback; failures are retried after
 * TOKENIZER_RETRY_MS.
 */
export function loadDeepSeekTokenizer(
  options: TokenizerModelOptions = {},
): Promise<DeepSeekCountingBpe | null> {
  if (deepseekLoad !== undefined) return deepseekLoad;
  if (Date.now() - deepseekFailureAt < TOKENIZER_RETRY_MS) {
    return Promise.resolve(null);
  }
  const cacheDir = options.cacheDir ?? defaultTokenizerCacheDir();
  const fetchImpl = options.fetchImpl ?? fetch;
  deepseekLoad = (async (): Promise<DeepSeekCountingBpe | null> => {
    try {
      return (
        (await readCachedTokenizer(cacheDir)) ?? (await downloadTokenizer(cacheDir, fetchImpl))
      );
    } catch {
      deepseekFailureAt = Date.now();
      deepseekLoad = undefined;
      return null;
    }
  })();
  return deepseekLoad;
}

/** Exact DeepSeek family tokenizer profile. Priority is below the plugin
 * default (0) so a plugin-registered model-specific tokenizer wins. */
export function createDeepSeekTokenizerProfile(
  options: TokenizerModelOptions = {},
): TokenizerProfile {
  return {
    id: 'deepseek:bytelevel-bpe-v1',
    priority: -10,
    approximate: false,
    matches: async (model) =>
      DEEPSEEK_MODEL_RE.test(model) && (await loadDeepSeekTokenizer(options)) !== null,
    count: async (text) => {
      const tokenizer = await loadDeepSeekTokenizer(options);
      if (!tokenizer) throw new Error('DeepSeek tokenizer unavailable');
      return tokenizer.count(text);
    },
  };
}

/** Test-only: clear the module-level cached load so the next call re-reads
 * the cache or re-fetches. Never used by application code. */
export function resetDeepSeekTokenizerForTests(): void {
  deepseekLoad = undefined;
  deepseekFailureAt = 0;
}
