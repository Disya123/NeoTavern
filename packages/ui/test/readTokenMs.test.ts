// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readTokenMs } from '../src/lib/readTokenMs.js';

describe('readTokenMs', () => {
  it('parses millisecond and second token values from the document root', () => {
    const root = document.documentElement;
    root.style.setProperty('--st-test-duration-ms', '850ms');
    root.style.setProperty('--st-test-duration-s', '1.25s');

    expect(readTokenMs('--st-test-duration-ms', 100)).toBe(850);
    expect(readTokenMs('--st-test-duration-s', 100)).toBe(1250);

    root.style.removeProperty('--st-test-duration-ms');
    root.style.removeProperty('--st-test-duration-s');
  });

  it('returns the fallback for missing or invalid values', () => {
    expect(readTokenMs('--st-missing-duration', 1000)).toBe(1000);
    expect(readTokenMs('--st-invalid-duration', 1000)).toBe(1000);
  });
});
