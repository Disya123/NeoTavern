/**
 * Corrupted character-card import tests (ТЗ §17): every rejection path in
 * characterCards.ts is exercised with a hand-built malformed input.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isAppError } from '@neotavern/shared';
import { exportCharacterCard, parseCharacterCard } from '../src/lib/characterCards.js';

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  // The parser does not verify CRCs; zeros keep fixtures deterministic.
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngWithCharaPayload(textData: string): Buffer {
  const data = Buffer.concat([
    Buffer.from('chara', 'latin1'),
    Buffer.from([0]),
    Buffer.from(textData, 'latin1'),
  ]);
  return Buffer.concat([PNG_SIGNATURE, chunk('tEXt', data), chunk('IEND', Buffer.alloc(0))]);
}

function pngCard(json: unknown): Buffer {
  return pngWithCharaPayload(Buffer.from(JSON.stringify(json), 'utf8').toString('base64'));
}

function reasonOf(error: unknown): string | undefined {
  return isAppError(error) ? (error.params['reason'] as string | undefined) : undefined;
}

describe('corrupted character cards', () => {
  it('rejects malformed JSON with INVALID_JSON', () => {
    let error: unknown;
    try {
      parseCharacterCard(Buffer.from('{"name": nope', 'utf8'), 'json');
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) expect(error.code).toBe('CHARACTER_CARD_INVALID');
    expect(reasonOf(error)).toBe('INVALID_JSON');
  });

  it('rejects JSON roots that are not objects', () => {
    let error: unknown;
    try {
      parseCharacterCard(Buffer.from('["array"]', 'utf8'), 'json');
    } catch (caught) {
      error = caught;
    }
    expect(reasonOf(error)).toBe('INVALID_JSON');
  });

  it('rejects non-PNG bytes with INVALID_PNG_SIGNATURE', () => {
    let error: unknown;
    try {
      parseCharacterCard(Buffer.from('definitely not a png file', 'utf8'), 'png');
    } catch (caught) {
      error = caught;
    }
    expect(reasonOf(error)).toBe('INVALID_PNG_SIGNATURE');
  });

  it('rejects truncated PNG chunks with TRUNCATED_PNG_CHUNK', () => {
    const full = pngCard({ name: 'Truncated' });
    // Cut inside the tEXt chunk data: the chunk header is still readable
    // (offset+12 ≤ length) but its declared payload extends past the end.
    const truncated = full.subarray(0, 30);
    let error: unknown;
    try {
      parseCharacterCard(truncated, 'png');
    } catch (caught) {
      error = caught;
    }
    expect(reasonOf(error)).toBe('TRUNCATED_PNG_CHUNK');
  });

  it('rejects invalid base64 in the chara chunk with INVALID_PNG_CARD_ENCODING', () => {
    const bad = pngWithCharaPayload('%%%not-base64%%%');
    let error: unknown;
    try {
      parseCharacterCard(bad, 'png');
    } catch (caught) {
      error = caught;
    }
    expect(reasonOf(error)).toBe('INVALID_PNG_CARD_ENCODING');
  });

  it('rejects PNGs without card metadata with PNG_CARD_METADATA_MISSING', () => {
    const bare = Buffer.concat([PNG_SIGNATURE, chunk('IEND', Buffer.alloc(0))]);
    let error: unknown;
    try {
      parseCharacterCard(bare, 'png');
    } catch (caught) {
      error = caught;
    }
    expect(reasonOf(error)).toBe('PNG_CARD_METADATA_MISSING');
  });

  it('rejects cards without a name with NAME_REQUIRED (both containers)', () => {
    for (const source of [
      Buffer.from(JSON.stringify({ description: 'nameless' }), 'utf8'),
      pngCard({ description: 'nameless' }),
    ]) {
      let error: unknown;
      try {
        parseCharacterCard(source, source[0] === 137 ? 'png' : 'json');
      } catch (caught) {
        error = caught;
      }
      expect(reasonOf(error)).toBe('NAME_REQUIRED');
    }
  });

  it('parses valid V1 and V2 cards and preserves unknown fields', () => {
    const v1 = parseCharacterCard(
      Buffer.from(
        JSON.stringify({ name: 'V1 Hero', creatorcomment: 'hi', talkativeness: 0.7, custom: 1 }),
        'utf8',
      ),
      'json',
    );
    expect(v1.sourceFormat).toBe('json-v1');
    expect(v1.warnings).toContain('LEGACY_CHARACTER_CARD_V1');
    expect(v1.character.ext['custom']).toBe(1);
    expect(v1.character.creatorNotes).toBe('hi');

    const v2 = parseCharacterCard(
      Buffer.from(
        JSON.stringify({
          spec: 'chara_card_v2',
          spec_version: '2.0',
          data: {
            name: 'V2 Hero',
            description: 'd',
            extensions: { 'custom.tool': { setting: true } },
            unknown_field: 'kept',
          },
          publisher_meta: { id: 'x' },
        }),
        'utf8',
      ),
      'json',
    );
    expect(v2.sourceFormat).toBe('json-v2');
    expect(v2.warnings).toEqual([]);
    expect(v2.character.ext['unknown_field']).toBe('kept');
    expect(v2.character.ext['custom.tool']).toEqual({ setting: true });
    expect(v2.character.ext['sourceRoot']).toEqual({ publisher_meta: { id: 'x' } });

    // Round-trip export keeps extension metadata (ТЗ §10.2).
    const exported = exportCharacterCard({
      id: 'x',
      name: v2.character.name ?? '',
      avatar: null,
      description: v2.character.description ?? '',
      personality: '',
      scenario: '',
      firstMessage: '',
      exampleDialogues: '',
      systemPrompt: null,
      postHistoryInstructions: null,
      creator: null,
      creatorNotes: null,
      tags: [],
      ext: v2.character.ext ?? {},
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      deletedAt: null,
    });
    expect(exported.data.extensions['unknown_field']).toBe('kept');
  });

  it('parses the bundled Hazel JSON as V3 without losing V3 metadata', () => {
    const parsed = parseCharacterCard(
      readFileSync(new URL('../assets/starter/default_Hazel.json', import.meta.url)),
      'json',
    );

    expect(parsed.sourceFormat).toBe('json-v3');
    expect(parsed.character).toMatchObject({
      name: 'Hazel',
      scenario:
        "A stranger follows a dead signal into the rain-soaked underbelly of Vesper and finds Hazel's repair bench in a neon alley.",
      systemPrompt: null,
      postHistoryInstructions: null,
    });
    expect(parsed.character.ext['world']).toBe('Vesper');
    expect(parsed.character.ext['character_book']).toMatchObject({ name: 'Vesper' });
    expect(parsed.character.ext['group_only_greetings']).toEqual([]);
    expect(parsed.character.ext['alternateGreetings']).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it('parses a valid PNG card', () => {
    const parsed = parseCharacterCard(pngCard({ name: 'PNG Hero', first_mes: 'hello' }), 'png');
    expect(parsed.sourceFormat).toBe('png-v1');
    expect(parsed.character.name).toBe('PNG Hero');
    expect(parsed.character.firstMessage).toBe('hello');
  });
});
