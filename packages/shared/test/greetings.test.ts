import { describe, expect, it } from 'vitest';
import {
  clampSwipeIndex,
  collectCharacterGreetings,
  readGreetingSwipes,
} from '../src/greetings.js';

describe('collectCharacterGreetings', () => {
  it('returns first message and non-empty alternates', () => {
    expect(
      collectCharacterGreetings({
        firstMessage: 'Hello',
        ext: { alternateGreetings: ['Alt 1', '  ', 'Alt 2'] },
      }),
    ).toEqual(['Hello', 'Alt 1', 'Alt 2']);
  });

  it('skips blank first messages', () => {
    expect(
      collectCharacterGreetings({
        firstMessage: '   ',
        ext: { alternateGreetings: ['Only alt'] },
      }),
    ).toEqual(['Only alt']);
  });
});

describe('readGreetingSwipes', () => {
  it('reads greeting swipe metadata', () => {
    expect(
      readGreetingSwipes({
        greeting: true,
        swipes: ['A', 'B', 'C'],
        swipeId: 1,
      }),
    ).toEqual({ swipes: ['A', 'B', 'C'], swipeId: 1 });
  });

  it('returns null when not a greeting swipe set', () => {
    expect(readGreetingSwipes({})).toBeNull();
    expect(readGreetingSwipes({ greeting: true, swipes: [] })).toBeNull();
  });
});

describe('clampSwipeIndex', () => {
  it('clamps into range', () => {
    expect(clampSwipeIndex(-1, 3)).toBe(0);
    expect(clampSwipeIndex(9, 3)).toBe(2);
    expect(clampSwipeIndex(1.8, 3)).toBe(1);
  });
});
