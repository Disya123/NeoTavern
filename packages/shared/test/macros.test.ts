import { describe, expect, it } from 'vitest';
import { buildMacroContext, replaceMacros } from '../src/macros.js';

describe('replaceMacros', () => {
  it('replaces user/char and custom variables', () => {
    const out = replaceMacros('{{user}} meets {{char}} at {{place}}', {
      userName: 'Bob',
      charName: 'Alice',
      variables: { place: 'the café' },
    });
    expect(out).toBe('Bob meets Alice at the café');
  });

  it('leaves unknown macros untouched', () => {
    expect(replaceMacros('{{unknown}}', { userName: 'u', charName: 'c' })).toBe('{{unknown}}');
  });

  it('resolves time macros with an injectable clock', () => {
    const now = new Date('2026-07-31T14:05:00');
    const out = replaceMacros('{{date}} {{time}} {{weekday}}', {
      userName: 'u',
      charName: 'c',
      now,
    });
    expect(out).toBe('2026-07-31 14:05 Friday');
  });

  it('picks a random alternative', () => {
    const original = Math.random;
    Math.random = () => 0;
    try {
      expect(replaceMacros('{{random:one~two~three}}', { userName: 'u', charName: 'c' })).toBe(
        'one',
      );
    } finally {
      Math.random = original;
    }
  });
});

describe('buildMacroContext', () => {
  it('applies default names for empty inputs', () => {
    expect(buildMacroContext({})).toEqual({
      userName: 'User',
      charName: 'Assistant',
      variables: undefined,
      now: undefined,
    });
  });
});
