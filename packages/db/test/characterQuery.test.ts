/**
 * Unit tests for the smart character query parser (tag/author/phrase syntax).
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_CHARACTER_QUERY,
  escapeLikePattern,
  likePattern,
  parseCharacterQuery,
} from '../src/repositories/characterQuery.js';

describe('parseCharacterQuery', () => {
  it('returns an empty result for an empty query', () => {
    expect(parseCharacterQuery('')).toEqual(EMPTY_CHARACTER_QUERY);
    expect(parseCharacterQuery('   ')).toEqual(EMPTY_CHARACTER_QUERY);
  });

  it('renders bare words as quoted prefix terms', () => {
    const parsed = parseCharacterQuery('magic sword');
    expect(parsed.ftsText).toBe('"magic"* "sword"*');
    expect(parsed.includeTags).toEqual([]);
  });

  it('keeps quoted phrases as exact phrases', () => {
    const parsed = parseCharacterQuery('"magic sword"');
    expect(parsed.ftsText).toBe('"magic sword"');
  });

  it('mixes phrases and words', () => {
    const parsed = parseCharacterQuery('hero "dark lord"');
    expect(parsed.ftsText).toBe('"hero"* "dark lord"');
  });

  it('extracts tag filters (repeatable, AND semantics)', () => {
    const parsed = parseCharacterQuery('tag:NSFW tag:fantasy');
    expect(parsed.includeTags).toEqual(['NSFW', 'fantasy']);
    expect(parsed.ftsText).toBeNull();
  });

  it('handles tag values case-insensitively as keys', () => {
    const parsed = parseCharacterQuery('TAG:adult');
    expect(parsed.includeTags).toEqual(['adult']);
  });

  it('supports quoted tag values with spaces', () => {
    const parsed = parseCharacterQuery('tag:"science fiction"');
    expect(parsed.includeTags).toEqual(['science fiction']);
  });

  it('extracts author filters and negation', () => {
    const parsed = parseCharacterQuery('author:Tidyup');
    expect(parsed.author).toBe('Tidyup');
    expect(parsed.ftsText).toBeNull();

    const excluded = parseCharacterQuery('-author:Bot');
    expect(excluded.excludeAuthor).toBe('Bot');
    expect(excluded.ftsText).toBeNull();
  });

  it('combines fields with free text in one FTS expression', () => {
    const parsed = parseCharacterQuery('tag:NSFW author:Tidyup "magic sword"');
    expect(parsed.includeTags).toEqual(['NSFW']);
    expect(parsed.author).toBe('Tidyup');
    expect(parsed.ftsText).toBe('"magic sword"');
  });

  it('renders negated words as FTS NOT phrases', () => {
    const parsed = parseCharacterQuery('sword -magic');
    expect(parsed.ftsText).toBe('"sword"* NOT "magic"*');
  });

  it('returns null ftsText when the query has only negations', () => {
    const parsed = parseCharacterQuery('-tag:NSFW');
    expect(parsed.ftsText).toBeNull();
    expect(parsed.excludeTags).toEqual(['NSFW']);
  });

  it('maps column filters to FTS columns', () => {
    expect(parseCharacterQuery('name:Harry').ftsText).toBe('name : "Harry"*');
    expect(parseCharacterQuery('desc:brave').ftsText).toBe('description : "brave"*');
    expect(parseCharacterQuery('persona:clever').ftsText).toBe('personality : "clever"*');
    expect(parseCharacterQuery('scenario:hogwarts').ftsText).toBe('scenario : "hogwarts"*');
  });

  it('falls back negated name filter to SQL and drops other negated columns', () => {
    const parsed = parseCharacterQuery('-name:evil -desc:dark');
    expect(parsed.excludeName).toBe('evil');
    expect(parsed.ftsText).toBeNull();
  });

  it('treats unknown keys as free text', () => {
    const parsed = parseCharacterQuery('actor:Tom');
    expect(parsed.ftsText).toBe('"actor:Tom"*');
    expect(parsed.includeTags).toEqual([]);
  });

  it('strips quotes from words', () => {
    const parsed = parseCharacterQuery("hero's");
    expect(parsed.ftsText).toBe('"heros"*');
  });

  it('escapes double quotes inside phrases', () => {
    const parsed = parseCharacterQuery('"say ""hi"""');
    expect(parsed.ftsText).toBe('"say ""hi"""');
  });

  it('caps the number of parsed tokens', () => {
    const q = Array.from({ length: 15 }, (_, index) => `w${index}`).join(' ');
    const parsed = parseCharacterQuery(q);
    expect(parsed.ftsText?.split(' ')).toHaveLength(10);
  });
});

describe('likePattern / escapeLikePattern', () => {
  it('escapes LIKE wildcards', () => {
    expect(likePattern('100%')).toBe('%100\\%%');
    expect(likePattern('a_b')).toBe('%a\\_b%');
    expect(likePattern('back\\slash')).toBe('%back\\\\slash%');
    expect(escapeLikePattern('plain')).toBe('plain');
  });
});
