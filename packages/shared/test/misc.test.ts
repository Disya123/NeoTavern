import { describe, expect, it } from 'vitest';
import { assertNever, clamp, deepMerge, isPlainObject, stableStringify } from '../src/misc.js';

describe('clamp', () => {
  it('keeps values inside the inclusive range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it('clamps values outside the range', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe('assertNever', () => {
  it('throws with the JSON-serialized unhandled member', () => {
    expect(() => assertNever({ kind: 'unknown' } as never)).toThrow(
      'Unhandled discriminated union member: {"kind":"unknown"}',
    );
  });

  it('supports a custom message', () => {
    expect(() => assertNever('x' as never, 'Custom guard')).toThrow('Custom guard: "x"');
  });
});

describe('isPlainObject', () => {
  it('accepts plain objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it('rejects null, arrays and primitives', () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject([1, 2])).toBe(false);
    expect(isPlainObject('text')).toBe(false);
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject(() => undefined)).toBe(false);
  });
});

describe('deepMerge', () => {
  it('merges nested plain objects with right precedence', () => {
    const base = { a: 1, nested: { x: 1, y: 2 }, keep: 'base' };
    const override = { b: 2, nested: { y: 99, z: 3 } };
    expect(deepMerge(base, override)).toEqual({
      a: 1,
      b: 2,
      nested: { x: 1, y: 99, z: 3 },
      keep: 'base',
    });
  });

  it('replaces arrays and non-plain values instead of merging them', () => {
    const base = { list: [1, 2, 3], value: { deep: true } as unknown };
    const override = { list: [9], value: 'scalar' };
    expect(deepMerge(base, override)).toEqual({ list: [9], value: 'scalar' });

    const reverse = deepMerge({ list: [1], value: 'scalar' }, { value: { deep: true } });
    expect(reverse).toEqual({ list: [1], value: { deep: true } });
  });

  it('does not mutate its inputs', () => {
    const base = { nested: { x: 1 } };
    const override = { nested: { y: 2 } };
    deepMerge(base, override);
    expect(base).toEqual({ nested: { x: 1 } });
    expect(override).toEqual({ nested: { y: 2 } });
  });
});

describe('stableStringify', () => {
  it('produces identical output regardless of key insertion order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('sorts keys recursively and preserves array order', () => {
    expect(stableStringify({ b: { d: 1, c: 2 }, a: [{ z: 1, y: 2 }] })).toBe(
      '{"a":[{"y":2,"z":1}],"b":{"c":2,"d":1}}',
    );
    expect(stableStringify([2, 1])).toBe('[2,1]');
  });

  it('serializes primitives like JSON.stringify', () => {
    expect(stableStringify('text')).toBe('"text"');
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify(null)).toBe('null');
  });
});
