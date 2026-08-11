import { describe, it, expect } from 'vitest';
import { cx } from '../src/lib/cx.js';

describe('cx', () => {
  it('joins string parts with a single space', () => {
    expect(cx('a', 'b', 'c')).toBe('a b c');
  });

  it('drops false, null and undefined', () => {
    expect(cx('a', false, null, undefined, 'b')).toBe('a b');
  });

  it('drops empty strings', () => {
    expect(cx('a', '', 'b')).toBe('a b');
  });

  it('returns an empty string when nothing survives', () => {
    expect(cx(false, null, undefined, '')).toBe('');
    expect(cx()).toBe('');
  });
});
