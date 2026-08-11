import { describe, expect, it } from 'vitest';
import type { RetrievalEntry } from '@neotavern/db';
import { retrieveLoreBlocks } from '../src/lib/lorebookRetrieval.js';

function entry(partial: Partial<RetrievalEntry> & { id: string }): RetrievalEntry {
  return {
    lorebookId: 'book-1',
    keys: [],
    secondaryKeys: [],
    content: `content of ${partial.id}`,
    position: 0,
    constant: false,
    selective: false,
    ...partial,
  };
}

describe('retrieveLoreBlocks', () => {
  it('activates entries by case-insensitive key match', () => {
    const blocks = retrieveLoreBlocks(
      [
        entry({ id: 'e1', keys: ['Ancient Map'], content: 'The map glows.' }),
        entry({ id: 'e2', keys: ['tea'], content: 'Bob likes tea.' }),
      ],
      'User asks about the ancient map',
    );
    expect(blocks.map((b) => b.content)).toEqual(['The map glows.']);
    expect(blocks[0]?.source).toBe('lorebook');
  });

  it('always injects constant entries as required blocks, first', () => {
    const blocks = retrieveLoreBlocks(
      [
        entry({ id: 'kw', keys: ['zebra'], content: 'Never matches.' }),
        entry({ id: 'const', constant: true, content: 'World rule.' }),
      ],
      'zebras everywhere',
    );
    expect(blocks[0]).toMatchObject({ content: 'World rule.', required: true });
    expect(blocks.length).toBe(2);
  });

  it('selective entries require a secondary key too', () => {
    const entries = [
      entry({
        id: 'sel',
        keys: ['dragon'],
        secondaryKeys: ['cave'],
        selective: true,
        content: 'Dragon in cave.',
      }),
    ];
    expect(retrieveLoreBlocks(entries, 'a dragon flies').length).toBe(0);
    expect(retrieveLoreBlocks(entries, 'a dragon guards the cave').length).toBe(1);
  });

  it('ranks by matched-key relevance', () => {
    const blocks = retrieveLoreBlocks(
      [
        entry({ id: 'one', keys: ['alpha', 'beta', 'gamma'], content: 'wide' }),
        entry({ id: 'two', keys: ['alpha'], content: 'narrow' }),
      ],
      'alpha and beta appear',
    );
    expect(blocks.map((b) => b.content)).toEqual(['narrow', 'wide']);
    expect(blocks[0]?.relevance).toBe(1);
    expect(blocks[1]?.relevance).toBeCloseTo(2 / 3);
  });

  it('returns nothing for empty context and keyless entries', () => {
    expect(retrieveLoreBlocks([entry({ id: 'x', keys: ['a'] })], '')).toEqual([]);
    expect(retrieveLoreBlocks([entry({ id: 'y' })], 'anything')).toEqual([]);
  });
});
