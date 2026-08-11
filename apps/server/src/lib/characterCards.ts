/**
 * Character Card V1/V2/V3 parsing and V2 export.
 *
 * Parsing is deliberately independent from persistence so malformed cards can
 * be rejected before any database or filesystem mutation occurs.
 */
import type { Character, CharacterCardV2, CharacterCreate } from '@neotavern/contracts';
import { AppError, ErrorCodes } from '@neotavern/shared';

type UnknownRecord = Record<string, unknown>;

interface ParsedCharacterCard {
  character: CharacterCreate;
  sourceFormat: 'json-v1' | 'json-v2' | 'json-v3' | 'png-v1' | 'png-v2' | 'png-v3';
  warnings: string[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(record: UnknownRecord, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function nullableString(record: UnknownRecord, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArray(record: UnknownRecord, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function parseJson(bytes: Buffer): UnknownRecord {
  try {
    const decoded: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isRecord(decoded)) throw new Error('root must be an object');
    return decoded;
  } catch (cause) {
    throw new AppError({
      code: ErrorCodes.CHARACTER_CARD_INVALID,
      params: { reason: 'INVALID_JSON' },
      cause,
    });
  }
}

function extractPngCharacterJson(bytes: Buffer): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < signature.length || !bytes.subarray(0, 8).equals(signature)) {
    throw new AppError({
      code: ErrorCodes.CHARACTER_CARD_INVALID,
      params: { reason: 'INVALID_PNG_SIGNATURE' },
    });
  }

  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > bytes.length) {
      throw new AppError({
        code: ErrorCodes.CHARACTER_CARD_INVALID,
        params: { reason: 'TRUNCATED_PNG_CHUNK' },
      });
    }

    const type = bytes.toString('ascii', typeStart, dataStart);
    if (type === 'tEXt') {
      const data = bytes.subarray(dataStart, dataEnd);
      const separator = data.indexOf(0);
      if (separator > 0 && data.toString('latin1', 0, separator) === 'chara') {
        const encoded = data.toString('latin1', separator + 1).trim();
        if (
          encoded.length === 0 ||
          encoded.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
        ) {
          throw new AppError({
            code: ErrorCodes.CHARACTER_CARD_INVALID,
            params: { reason: 'INVALID_PNG_CARD_ENCODING' },
          });
        }
        try {
          return Buffer.from(encoded, 'base64');
        } catch (cause) {
          throw new AppError({
            code: ErrorCodes.CHARACTER_CARD_INVALID,
            params: { reason: 'INVALID_PNG_CARD_ENCODING' },
            cause,
          });
        }
      }
    }
    if (type === 'IEND') break;
    offset = chunkEnd;
  }

  throw new AppError({
    code: ErrorCodes.CHARACTER_CARD_INVALID,
    params: { reason: 'PNG_CARD_METADATA_MISSING' },
  });
}

function unknownFields(record: UnknownRecord, known: ReadonlySet<string>): UnknownRecord {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !known.has(key)));
}

const V2_KNOWN = new Set([
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
  'alternate_greetings',
  'tags',
  'creator',
  'character_version',
  'extensions',
]);

const V1_KNOWN = new Set([
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'creatorcomment',
  'avatar',
  'chat',
  'talkativeness',
  'fav',
  'tags',
]);

export function parseCharacterCard(sourceBytes: Buffer, kind: 'json' | 'png'): ParsedCharacterCard {
  const root = parseJson(kind === 'png' ? extractPngCharacterJson(sourceBytes) : sourceBytes);
  const hasStructuredData = isRecord(root['data']);
  const isV3 =
    hasStructuredData && (root['spec'] === 'chara_card_v3' || root['spec_version'] === '3.0');
  const isV2 = hasStructuredData && root['spec'] === 'chara_card_v2';
  const isStructured = isV2 || isV3;
  const data = isStructured ? (root['data'] as UnknownRecord) : root;
  const name = stringValue(data, 'name').trim();
  if (name.length === 0) {
    throw new AppError({
      code: ErrorCodes.CHARACTER_CARD_INVALID,
      params: { reason: 'NAME_REQUIRED' },
    });
  }

  const extensions = isRecord(data['extensions']) ? data['extensions'] : {};
  const ext: UnknownRecord = isStructured
    ? {
        ...unknownFields(data, V2_KNOWN),
        ...extensions,
        characterVersion: stringValue(data, 'character_version'),
        alternateGreetings: stringArray(data, 'alternate_greetings'),
        sourceRoot: unknownFields(root, new Set(['spec', 'spec_version', 'data'])),
      }
    : {
        ...unknownFields(data, V1_KNOWN),
        legacy: {
          creatorComment: stringValue(data, 'creatorcomment'),
          talkativeness: data['talkativeness'],
          favorite: data['fav'],
        },
      };

  return {
    character: {
      name,
      description: stringValue(data, 'description'),
      personality: stringValue(data, 'personality'),
      scenario: stringValue(data, 'scenario'),
      firstMessage: stringValue(data, 'first_mes'),
      exampleDialogues: stringValue(data, 'mes_example'),
      systemPrompt: nullableString(data, 'system_prompt'),
      postHistoryInstructions: nullableString(data, 'post_history_instructions'),
      creator: nullableString(data, 'creator'),
      creatorNotes: nullableString(data, isStructured ? 'creator_notes' : 'creatorcomment'),
      tags: stringArray(data, 'tags'),
      ext,
    },
    sourceFormat: `${kind}-${isV3 ? 'v3' : isV2 ? 'v2' : 'v1'}`,
    warnings: isStructured ? [] : ['LEGACY_CHARACTER_CARD_V1'],
  };
}

export function exportCharacterCard(character: Character): CharacterCardV2 {
  const alternateGreetings = Array.isArray(character.ext['alternateGreetings'])
    ? character.ext['alternateGreetings'].filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  const characterVersion =
    typeof character.ext['characterVersion'] === 'string' ? character.ext['characterVersion'] : '';
  const extensions = Object.fromEntries(
    Object.entries(character.ext).filter(
      ([key]) =>
        key !== '_st2' &&
        key !== 'alternateGreetings' &&
        key !== 'characterVersion' &&
        key !== 'sourceRoot' &&
        key !== 'legacy',
    ),
  );
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: character.name,
      description: character.description,
      personality: character.personality,
      scenario: character.scenario,
      first_mes: character.firstMessage,
      mes_example: character.exampleDialogues,
      creator_notes: character.creatorNotes ?? '',
      system_prompt: character.systemPrompt ?? '',
      post_history_instructions: character.postHistoryInstructions ?? '',
      alternate_greetings: alternateGreetings,
      tags: character.tags,
      creator: character.creator ?? '',
      character_version: characterVersion,
      extensions,
    },
  };
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'latin1');
  const chunk = Buffer.allocUnsafe(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
  return chunk;
}

/**
 * Embeds a V2 character card in the SillyTavern-compatible `chara` PNG tEXt
 * chunk. The input must already be normalized to PNG so stale source metadata
 * cannot leak into the exported card.
 */
export function embedCharacterCardInPng(png: Buffer, character: Character): Buffer {
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new AppError({
      code: ErrorCodes.CHARACTER_CARD_INVALID,
      params: { reason: 'INVALID_EXPORT_AVATAR' },
    });
  }

  let offset = PNG_SIGNATURE.length;
  let iendOffset = -1;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > png.length) break;
    if (png.toString('latin1', offset + 4, offset + 8) === 'IEND') {
      iendOffset = offset;
      break;
    }
    offset = end;
  }
  if (iendOffset < 0) {
    throw new AppError({
      code: ErrorCodes.CHARACTER_CARD_INVALID,
      params: { reason: 'INVALID_EXPORT_AVATAR' },
    });
  }

  const encoded = Buffer.from(JSON.stringify(exportCharacterCard(character)), 'utf8').toString(
    'base64',
  );
  const text = Buffer.concat([
    Buffer.from('chara', 'latin1'),
    Buffer.from([0]),
    Buffer.from(encoded, 'latin1'),
  ]);
  return Buffer.concat([
    png.subarray(0, iendOffset),
    pngChunk('tEXt', text),
    png.subarray(iendOffset),
  ]);
}
