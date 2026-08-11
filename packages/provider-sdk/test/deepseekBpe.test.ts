import { describe, expect, it } from 'vitest';
import { DeepSeekCountingBpe, convertDeepSeekTokenizer, splitRegex } from '../src/deepseekBpe.js';

/** Shared compact payload for engine-level tests. */
function fixtureData(): { ranksText: string; addedTokens: string[] } {
  // Same merge set as the profile fixture: ranks = merge index. Byte-space
  // keys use the GPT-2 table ('你' = E4 BD A0 = 'ä½ł', '😀' = F0 9F 98 80 =
  // 'ðŁĺĢ'). Merges '3 4' and '你 a' cross split boundaries: they apply only
  // if the digit/CJK stages did NOT isolate the runs, making the split
  // stages observable.
  const merges = [
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
  ];
  return convertDeepSeekTokenizer({
    model: { merges },
    added_tokens: [
      { content: '<|end|>', special: true },
      { content: '<|User|>', special: false },
    ],
  });
}

describe('convertDeepSeekTokenizer', () => {
  it('maps merge pairs into byte-space keys with consecutive ranks', () => {
    const data = fixtureData();
    const lines = data.ranksText.split('\n').filter(Boolean);
    // 19 merges, grouped 64 per line → one line starting at rank 0.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^0 /);
    const tokens = lines[0].slice(2).split(' ');
    expect(tokens).toHaveLength(19);
    // 'h e' → bytes 0x68 0x65 → base64 'aGU='.
    expect(tokens[0]).toBe('aGU=');
    // 'ÐŁ ÑĢ' (Пр) → bytes D0 9F D1 80 → base64 '0J/RgA=='.
    expect(tokens[11]).toBe('0J/RgA==');
  });

  it('keeps all added tokens, special or not', () => {
    const data = fixtureData();
    expect(data.addedTokens).toEqual(['<|end|>', '<|User|>']);
  });

  it('throws on a malformed tokenizer.json', () => {
    expect(() => convertDeepSeekTokenizer({})).toThrow(TypeError);
    expect(() => convertDeepSeekTokenizer({ model: { merges: 'x' } })).toThrow(TypeError);
    expect(() => convertDeepSeekTokenizer({ model: { merges: ['\u0000 '] } })).toThrow(TypeError);
  });
});

describe('DeepSeekCountingBpe', () => {
  it('counts ASCII words exactly', () => {
    const bpe = new DeepSeekCountingBpe(fixtureData().ranksText, fixtureData().addedTokens);
    expect(bpe.count('hello world')).toBe(2);
    expect(bpe.count('hello')).toBe(1);
    expect(bpe.count('a b')).toBe(3);
    expect(bpe.count('')).toBe(0);
  });

  it('pre-splits added tokens even when they are not flagged special', () => {
    const bpe = new DeepSeekCountingBpe(fixtureData().ranksText, fixtureData().addedTokens);
    expect(bpe.count('<|end|>hello')).toBe(2);
    expect(bpe.count('<|User|>hello')).toBe(2);
    expect(bpe.count('<|end|><|User|>')).toBe(2);
    // 'Привет' = Пр(1) + и(2) + в(2) + е(2) + т(2) = 9.
    expect(bpe.count('<|end|>Привет')).toBe(10);
  });

  it('assembles non-ASCII words from byte pairs', () => {
    const bpe = new DeepSeekCountingBpe(fixtureData().ranksText, fixtureData().addedTokens);
    // 'Пр' = D0 9F D1 80: bytes assemble via ÐŁ(9), ÑĢ(10), ÐŁÑĢ(11).
    expect(bpe.count('Пр')).toBe(1);
    expect(bpe.count('ПрПр')).toBe(2);
    // 'П' alone = D0 9F → one byte-pair token.
    expect(bpe.count('П')).toBe(1);
    // '😀' = F0 9F 98 80: two byte pairs, no full merge → 2 tokens.
    expect(bpe.count('😀')).toBe(2);
    expect(bpe.count('Пр😀')).toBe(3);
  });

  it('applies the three split stages in order', () => {
    const bpe = new DeepSeekCountingBpe(fixtureData().ranksText, fixtureData().addedTokens);
    // Digit runs are split by \p{N}{1,3} BEFORE the GPT regex: '3 4' merges
    // only when '3' and '4' end up in the same piece, so the split is
    // observable — '1234567890' → '123','456','789','0' → 2+3+3+1 = 9.
    expect(bpe.count('1234567890')).toBe(9);
    // CJK runs are isolated from Latin neighbours: '你a' = 1 + 1 = 2, while
    // a single '你a' piece would merge via '你 a' into one token.
    expect(bpe.count('你')).toBe(1);
    expect(bpe.count('你a')).toBe(2);
    expect(bpe.count('a你')).toBe(2);
  });

  it('produces identical counts for repeated text via the word cache', () => {
    const bpe = new DeepSeekCountingBpe(fixtureData().ranksText, fixtureData().addedTokens);
    const text = 'hello world'.repeat(100);
    const first = bpe.count(text);
    const second = bpe.count(text);
    expect(second).toBe(first);
    expect(first).toBe(200);
  });
});

describe('splitRegex (Isolated semantics)', () => {
  it('keeps matches and interleaves gaps', () => {
    const re = /[a-z]+/gu;
    expect(splitRegex('12ab34', re)).toEqual(['12', 'ab', '34']);
    expect(splitRegex('ab', re)).toEqual(['ab']);
    expect(splitRegex('', re)).toEqual([]);
  });
});
