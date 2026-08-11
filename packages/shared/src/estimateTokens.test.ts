import { describe, expect, it } from 'vitest';
import { estimateTokens } from './estimateTokens.js';

describe('estimateTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('weights Latin letters at ~4.6 chars/token', () => {
    expect(estimateTokens('hello world')).toBe(3); // 11 letters / 4.6 + 1 space / 3.0 = 2.72 → 3
    expect(estimateTokens('abc')).toBe(1); // 3 / 4.6 = 0.65 → 1 (floor at 1)
  });

  it('weights Cyrillic at ~4.0 chars/token', () => {
    expect(estimateTokens('а')).toBe(1);
    expect(estimateTokens('аааа')).toBe(1); // 4 / 4.0 = 1
    expect(estimateTokens('аааааааа')).toBe(2); // 8 / 4.0 = 2
  });

  it('never drops newlines (catch-all group is [\\s\\S])', () => {
    expect(estimateTokens('\n\n')).toBe(1); // 2 chars / 4.0 = 0.5 → 1
    expect(estimateTokens('a\nb')).toBe(1); // 2 letters / 4.6 + 1 newline / 4.0 = 0.68 → 1
  });

  it('weights emoji at ~1.1 chars/token', () => {
    expect(estimateTokens('😀')).toBe(1); // 1 / 1.1 = 0.91 → 1
    expect(estimateTokens('😀🎉🚀')).toBe(3); // 3 / 1.1 = 2.73 → 3
  });

  it('weights CJK at ~1.7 chars/token', () => {
    expect(estimateTokens('你好')).toBe(1); // 2 / 1.7 = 1.18 → 1
    expect(estimateTokens('你好世界')).toBe(2); // 4 / 1.7 = 2.35 → 2
  });

  it('weights digits at ~2.0 chars/token', () => {
    expect(estimateTokens('1234')).toBe(2); // 4 / 2.0 = 2
  });

  it('handles mixed-script text deterministically', () => {
    // 6 Cyrillic / 4.0 + 5 Latin / 4.6 + 1 space / 3.0 = 2.92 → 3
    expect(estimateTokens('Привет world')).toBe(3);
  });
});
