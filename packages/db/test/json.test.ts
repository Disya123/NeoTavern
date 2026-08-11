import { describe, expect, it } from 'vitest';
import { parseJson, toJson } from '../src/json.js';

describe('parseJson', () => {
  it('returns the fallback for null and undefined input', () => {
    expect(parseJson(null, { fallback: true })).toEqual({ fallback: true });
    expect(parseJson(undefined, [1, 2])).toEqual([1, 2]);
  });

  it('returns the fallback for invalid JSON', () => {
    expect(parseJson('{not json', 'fallback')).toBe('fallback');
    expect(parseJson('{"unterminated":', {})).toEqual({});
  });

  it('parses valid JSON documents', () => {
    expect(parseJson('{"a":1}', {})).toEqual({ a: 1 });
    expect(parseJson('[1,2,3]', [])).toEqual([1, 2, 3]);
    expect(parseJson('"text"', '')).toBe('text');
    expect(parseJson('42', 0)).toBe(42);
  });

  it('returns parsed null for a literal null document', () => {
    expect(parseJson<string | null>('null', 'fallback')).toBeNull();
  });
});

describe('toJson', () => {
  it('serializes values as JSON', () => {
    expect(toJson({ a: 1 })).toBe('{"a":1}');
    expect(toJson([1, 'two'])).toBe('[1,"two"]');
    expect(toJson(null)).toBe('null');
  });

  it('roundtrips through parseJson', () => {
    const value = { settings: { theme: 'dark', count: 3 }, tags: ['a', 'b'] };
    expect(parseJson(toJson(value), {})).toEqual(value);
  });
});
