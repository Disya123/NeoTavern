import { describe, it, expect } from 'vitest';
import { uuidv7, isUuid, randomToken } from '../src/id.js';

describe('uuidv7', () => {
  it('produces a valid, hyphenated UUID string', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(isUuid(id)).toBe(true);
  });

  it('encodes version 7 and the RFC 4122 variant', () => {
    const id = uuidv7();
    // version nibble is the first char of the 3rd group
    expect(id[14]).toBe('7');
    // variant nibble (first char of 4th group) is one of 8,9,a,b
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('is monotonic-ish: later ids sort after earlier ones', () => {
    const a = uuidv7();
    const b = uuidv7();
    // Same millisecond may tie on the timestamp prefix; full equality is
    // astronomically unlikely due to the random component.
    expect(a).not.toBe(b);
    expect(a <= b).toBe(true);
  });

  it('preserves generation order inside the same millisecond', () => {
    const ids = Array.from({ length: 100 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
  });

  it('generates unique ids across many calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i += 1) seen.add(uuidv7());
    expect(seen.size).toBe(5000);
  });
});

describe('randomToken', () => {
  it('returns a hex string of the expected length', () => {
    const token = randomToken(8);
    expect(token).toMatch(/^[0-9a-f]{16}$/);
  });
});
