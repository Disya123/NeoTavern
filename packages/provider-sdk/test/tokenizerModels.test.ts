import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../src/registry.js';
import { TokenizerRegistry, registerCoreTokenizers } from '../src/tokenizer.js';
import {
  createDeepSeekTokenizerProfile,
  resetDeepSeekTokenizerForTests,
} from '../src/tokenizerModels.js';

/**
 * A minimal byte-level BPE tokenizer in DeepSeek's exact shape: the same
 * pre_tokenizer Sequence (Split digits / Split CJK / Split GPT regex /
 * ByteLevel) over a hand-built merge list, so the conversion path and the
 * engine exercise every stage of the real tokenizer (regex pieces, `Ġ`
 * space byte, byte-pair assembly for non-ASCII, added-token pre-split).
 *
 * Merge ranks = array index (the converter keeps that order):
 *   h+e(0), he+l(1), hel+l(2), hell+o(3), Ġ+w(4), Ġw+o(5), Ġwo+r(6),
 *   Ġwor+l(7), Ġworl+d(8), Ð+Ł(9), Ñ+Ģ(10), ÐŁ+ÑĢ(11), ð+Ł(12), ĺ+Ģ(13)
 *
 * Byte-level space (GPT-2 table): 'П' = D0 9F = 'ÐŁ', 'р' = D1 80 = 'ÑĢ',
 * '😀' = F0 9F 98 80 = 'ðŁĺĢ'. The full 'Пр' merge (11) and the two
 * byte-pair merges for the emoji (12, 13) exist; a full emoji merge does
 * not, so '😀' stays two tokens.
 *
 * Hand-derived encodings:
 *   'hello world' → ['hello','Ġworld'] = 2 ids
 *   'hello'       → 1 id, 'a b' → ['a','Ġ','b'] = 3 ids (no 'Ġ b' merge)
 *   '<|end|>hello' → 2 ids, '<|User|>hello' → 2 ids (added tokens are
 *     pre-split whether or not they are flagged `special`)
 *   'Пр'          → 1 id (byte pairs assemble via merges 9-11)
 *   '😀'          → 2 ids (two byte-pair tokens, no full merge)
 *   'Пр😀'        → 1 + 2 = 3 ids
 *   '你'          → 1 id ('你' = E4 BD A0 = 'ä½ł', merges 16-17)
 *   '你a'         → 2 ids (CJK split isolates '你' from 'a'; merge 18
 *     would join them into one piece without the split)
 *   '1234567890'  → digit-split pieces '123','456','789','0' → 2+3+3+1 = 9
 *     (merges 14-15 only apply inside a chunk; '3 4' crosses the boundary
 *     of the unsplit run, making the digit stage observable)
 */
const FIXTURE_TOKENIZER = {
  version: '1.0',
  truncation: null,
  padding: null,
  added_tokens: [
    {
      id: 22,
      content: '<|end|>',
      single_word: false,
      lstrip: false,
      rstrip: false,
      normalized: false,
      special: true,
    },
    {
      id: 23,
      content: '<|User|>',
      single_word: false,
      lstrip: false,
      rstrip: false,
      normalized: false,
      special: false,
    },
  ],
  normalizer: { type: 'Sequence', normalizers: [] },
  pre_tokenizer: {
    type: 'Sequence',
    pretokenizers: [
      { type: 'Split', pattern: { Regex: '\\p{N}{1,3}' }, behavior: 'Isolated', invert: false },
      {
        type: 'Split',
        pattern: { Regex: '[一-龥぀-ゟ゠-ヿ]+' },
        behavior: 'Isolated',
        invert: false,
      },
      {
        type: 'Split',
        pattern: {
          Regex:
            '[!"#$%&\'()*+,\\-./:;<=>?@\\[\\\\\\]^_`{|}~][A-Za-z]+|[^\\r\\n\\p{L}\\p{P}\\p{S}]?[\\p{L}\\p{M}]+| ?[\\p{P}\\p{S}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+',
        },
        behavior: 'Isolated',
        invert: false,
      },
      { type: 'ByteLevel', add_prefix_space: false, trim_offsets: true, use_regex: false },
    ],
  },
  post_processor: {
    type: 'ByteLevel',
    add_prefix_space: true,
    trim_offsets: false,
    use_regex: true,
  },
  decoder: { type: 'ByteLevel', add_prefix_space: true, trim_offsets: false, use_regex: true },
  model: {
    type: 'BPE',
    dropout: null,
    unk_token: null,
    continuing_subword_prefix: null,
    end_of_word_suffix: null,
    fuse_unk: false,
    byte_fallback: false,
    vocab: {
      Ġ: 0,
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
      h: 6,
      l: 7,
      o: 8,
      r: 9,
      t: 10,
      w: 11,
      y: 12,
      he: 13,
      hel: 14,
      hell: 15,
      hello: 16,
      Ġw: 17,
      Ġwo: 18,
      Ġwor: 19,
      Ġworl: 20,
      Ġworld: 21,
      П: 24,
      р: 25,
      Пр: 26,
      ðŁ: 27,
      ĺĢ: 28,
    },
    merges: [
      'h e',
      'he l',
      'hel l',
      'hell o',
      'Ġ w',
      'Ġw o',
      'Ġwo r',
      'Ġwor l',
      'Ġworl d',
      'Ð Ł',
      'Ñ Ģ',
      'ÐŁ ÑĢ',
      'ð Ł',
      'ĺ Ģ',
      '1 2',
      '3 4',
      'ä ½',
      'ä½ ł',
      'ä½ł a',
    ],
  },
};

function countingFetch(requests: { count: number }, fail: boolean): typeof fetch {
  return (async (_input: string | URL | Request) => {
    requests.count += 1;
    if (fail) throw new Error('network unavailable');
    return new Response(JSON.stringify(FIXTURE_TOKENIZER), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function registryWithDeepSeek(options: {
  cacheDir: string;
  fetchImpl: typeof fetch;
}): TokenizerRegistry {
  const registry = new TokenizerRegistry();
  registerCoreTokenizers(registry, options);
  return registry;
}

describe('deepseek tokenizer profile', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'neotavern-tok-'));
    resetDeepSeekTokenizerForTests();
  });

  afterEach(() => {
    resetDeepSeekTokenizerForTests();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('resolves deepseek models to the exact profile and counts with the engine', async () => {
    const registry = registryWithDeepSeek({
      cacheDir,
      fetchImpl: countingFetch({ count: 0 }, false),
    });
    const tokenizer = await registry.resolve('deepseek/deepseek-v4-flash');
    expect(tokenizer).toMatchObject({ profile: 'deepseek:bytelevel-bpe-v1', approximate: false });
    await expect(tokenizer.count('hello world')).resolves.toBe(2);
    await expect(tokenizer.count('hello')).resolves.toBe(1);
    await expect(tokenizer.count('a b')).resolves.toBe(3);
    await expect(tokenizer.count('<|end|>hello')).resolves.toBe(2);
    await expect(tokenizer.count('<|User|>hello')).resolves.toBe(2);
    await expect(tokenizer.count('Пр')).resolves.toBe(1);
    await expect(tokenizer.count('😀')).resolves.toBe(2);
    await expect(tokenizer.count('Пр😀')).resolves.toBe(3);
    await expect(tokenizer.count('1234567890')).resolves.toBe(9);
    await expect(tokenizer.count('你a')).resolves.toBe(2);
    // Compact cache files were written; the bulky tokenizer.json is not kept.
    expect(existsSync(join(cacheDir, 'deepseek-v4-flash', 'deepseek.tiktoken'))).toBe(true);
    expect(existsSync(join(cacheDir, 'deepseek-v4-flash', 'added.json'))).toBe(true);
    expect(existsSync(join(cacheDir, 'deepseek-v4-flash', 'tokenizer.json'))).toBe(false);
  });

  it('reuses the on-disk cache without fetching again', async () => {
    const requests = { count: 0 };
    const fetchImpl = countingFetch(requests, false);
    // First resolve downloads and converts.
    const registry = registryWithDeepSeek({ cacheDir, fetchImpl });
    await expect(
      (await registry.resolve('deepseek/deepseek-v4-flash')).count('hello world'),
    ).resolves.toBe(2);
    expect(requests.count).toBe(1);
    // A fresh process state (new singleton) with a broken network still
    // counts from the compact cache files.
    resetDeepSeekTokenizerForTests();
    const failingFetch = countingFetch({ count: 0 }, true);
    const cached = await new ProviderRegistry().tokenizers.resolve('deepseek/deepseek-v4-flash');
    await expect(cached.count('hello')).resolves.toBe(1);
    expect(failingFetch).toBeDefined();
  });

  it('falls back to the approximate profile when the download fails and does not hammer the network', async () => {
    const requests = { count: 0 };
    const registry = registryWithDeepSeek({ cacheDir, fetchImpl: countingFetch(requests, true) });
    const tokenizer = await registry.resolve('deepseek/deepseek-v4-flash');
    expect(tokenizer).toMatchObject({ profile: 'approximate-character-v1', approximate: true });
    await expect(tokenizer.count('hello world')).resolves.toBeGreaterThan(0);
    expect(requests.count).toBe(1);
    // Immediate retry is suppressed by the retry TTL.
    await registry.resolve('deepseek/deepseek-v4-flash');
    expect(requests.count).toBe(1);
  });

  it('ignores malformed cache files and falls back instead of crashing', async () => {
    mkdirSync(join(cacheDir, 'deepseek-v4-flash'), { recursive: true });
    writeFileSync(join(cacheDir, 'deepseek-v4-flash', 'deepseek.tiktoken'), 'not base64 !!!');
    writeFileSync(join(cacheDir, 'deepseek-v4-flash', 'added.json'), '{broken json');
    const registry = registryWithDeepSeek({
      cacheDir,
      fetchImpl: countingFetch({ count: 0 }, true),
    });
    const tokenizer = await registry.resolve('deepseek/deepseek-v4-flash');
    expect(tokenizer).toMatchObject({ profile: 'approximate-character-v1', approximate: true });
  });

  it('keeps non-deepseek models on their existing profiles', async () => {
    const registry = registryWithDeepSeek({
      cacheDir,
      fetchImpl: countingFetch({ count: 0 }, true),
    });
    await expect(registry.resolve('gpt-4o')).resolves.toMatchObject({
      profile: 'openai:o200k_base',
      approximate: false,
    });
    await expect(registry.resolve('echo')).resolves.toMatchObject({
      profile: 'approximate-character-v1',
      approximate: true,
    });
  });

  it('createDeepSeekTokenizerProfile count throws when the tokenizer is unavailable', async () => {
    const profile = createDeepSeekTokenizerProfile({
      cacheDir,
      fetchImpl: countingFetch({ count: 0 }, true),
    });
    await expect(profile.matches('deepseek-chat')).resolves.toBe(false);
    await expect(profile.count('hello')).rejects.toThrow('DeepSeek tokenizer unavailable');
  });
});
