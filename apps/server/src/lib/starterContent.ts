import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { LorebookEntryCreate } from '@neotavern/contracts';
import type { AppDatabase } from '@neotavern/db';
import type { Logger } from '@neotavern/shared';
import { parseCharacterCard } from './characterCards.js';
import { storeAvatar } from './fileStore.js';
import type { DataPaths } from './paths.js';

const STARTER_VERSION = 'hazel-v1';
export const STARTER_CHARACTER_ID_KEY = 'starter.hazel.v1.characterId';
export const STARTER_LOREBOOK_ID_KEY = 'starter.hazel.v1.lorebookId';
export const STARTER_COMPLETE_KEY = 'starter.hazel.v1.complete';

const AVATAR_PNG = 'default_Hazel_avatar.png';
const CARD_JSON = 'default_Hazel.json';
const LOREBOOK_JSON = 'Vesper-lore-book.json';

interface StarterSeedOptions {
  database: AppDatabase;
  paths: DataPaths;
  logger: Logger;
  assetsDir?: string;
}

export interface StarterSeedResult {
  status: 'seeded' | 'already-complete' | 'retry';
  characterId: string | null;
  lorebookId: string | null;
}

type UnknownRecord = Record<string, unknown>;

/** Resolve bundled assets in source, dist, and pkg snapshot layouts. */
export function defaultStarterAssetsDir(): string {
  return fileURLToPath(new URL('../../assets/starter/', import.meta.url));
}

/**
 * Offer the bundled Hazel character and Vesper lore exactly once per
 * installation. Staged app_meta markers make interruption safe to resume.
 */
export async function seedStarterContent({
  database,
  paths,
  logger,
  assetsDir = defaultStarterAssetsDir(),
}: StarterSeedOptions): Promise<StarterSeedResult> {
  const { appMeta, characters, lorebooks, cacheMetadata } = database.repos;
  const complete = await appMeta.get(STARTER_COMPLETE_KEY);
  if (complete !== null) {
    return {
      status: 'already-complete',
      characterId: await appMeta.get(STARTER_CHARACTER_ID_KEY),
      lorebookId: await appMeta.get(STARTER_LOREBOOK_ID_KEY),
    };
  }

  try {
    const [avatarPng, cardJson, lorebookJson] = await Promise.all([
      readFile(join(assetsDir, AVATAR_PNG)),
      readFile(join(assetsDir, CARD_JSON)),
      readFile(join(assetsDir, LOREBOOK_JSON)),
    ]);
    const parsedJson = parseCharacterCard(cardJson, 'json');
    if (parsedJson.sourceFormat !== 'json-v3') {
      throw new Error('STARTER_CARD_MISMATCH');
    }
    const sourceEntries = parseLorebookEntries(lorebookJson);
    const sourceHash = createHash('sha256').update(cardJson).digest('hex');

    let characterId = await appMeta.get(STARTER_CHARACTER_ID_KEY);
    let character = characterId ? await characters.getById(characterId) : null;
    if (!character) {
      character = await characters.findByImportHash(sourceHash);
    }
    if (!character) {
      const avatar = await storeAvatar(avatarPng, paths, 256, (record) =>
        cacheMetadata.record(record),
      );
      const priorSt2 = isRecord(parsedJson.character.ext?.['_st2'])
        ? parsedJson.character.ext['_st2']
        : {};
      character = await characters.create({
        ...parsedJson.character,
        avatar: avatar.thumbnailUrl,
        ext: {
          ...(parsedJson.character.ext ?? {}),
          _st2: {
            ...priorSt2,
            importHash: sourceHash,
            sourceFormat: parsedJson.sourceFormat,
            starterBundle: STARTER_VERSION,
          },
        },
      });
    }
    characterId = character.id;
    await appMeta.set(STARTER_CHARACTER_ID_KEY, characterId);

    let lorebookId = await appMeta.get(STARTER_LOREBOOK_ID_KEY);
    let lorebook = lorebookId ? await lorebooks.getById(lorebookId) : null;
    if (!lorebook || lorebook.characterId !== characterId) {
      const books = await lorebooks.list({ characterId, limit: 1000 });
      lorebook =
        books.items.find(
          (book) =>
            book.characterId === characterId && book.metadata['starterBundle'] === STARTER_VERSION,
        ) ?? null;
    }
    if (!lorebook) {
      lorebook = await lorebooks.create(
        {
          name: 'Vesper',
          description: '',
          characterId,
        },
        { starterBundle: STARTER_VERSION },
      );
    }
    lorebookId = lorebook.id;
    await appMeta.set(STARTER_LOREBOOK_ID_KEY, lorebookId);

    const existingEntries = await lorebooks.listEntries(lorebookId);
    const existingSourceIds = new Set(
      existingEntries
        .map((entry) => entry.metadata['starterEntryId'])
        .filter((value): value is string => typeof value === 'string'),
    );
    for (const sourceEntry of sourceEntries) {
      if (existingSourceIds.has(sourceEntry.sourceId)) continue;
      await lorebooks.createEntry(lorebookId, sourceEntry.entry);
    }

    await appMeta.set(STARTER_COMPLETE_KEY, '1');
    logger.info('starter content ready', {
      bundle: STARTER_VERSION,
      characterId,
      lorebookId,
    });
    return { status: 'seeded', characterId, lorebookId };
  } catch {
    logger.warn('starter content unavailable; startup will retry', {
      code: 'STARTER_CONTENT_RETRY',
      bundle: STARTER_VERSION,
    });
    return {
      status: 'retry',
      characterId: await appMeta.get(STARTER_CHARACTER_ID_KEY),
      lorebookId: await appMeta.get(STARTER_LOREBOOK_ID_KEY),
    };
  }
}

function parseLorebookEntries(bytes: Buffer): Array<{
  sourceId: string;
  entry: LorebookEntryCreate;
}> {
  let root: unknown;
  try {
    root = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('STARTER_LOREBOOK_JSON_INVALID');
  }
  if (!isRecord(root) || !isRecord(root['entries'])) {
    throw new Error('STARTER_LOREBOOK_ENTRIES_INVALID');
  }
  const entries = Object.entries(root['entries']).map(([sourceId, value]) => {
    if (!isRecord(value)) throw new Error('STARTER_LOREBOOK_ENTRY_INVALID');
    const keys = stringArray(value['key']);
    const secondaryKeys = stringArray(value['keysecondary']);
    const content = value['content'];
    const order = value['order'];
    const placement = value['position'];
    if (
      keys.length === 0 ||
      typeof content !== 'string' ||
      content.trim().length === 0 ||
      typeof order !== 'number' ||
      !Number.isInteger(order) ||
      (placement !== 0 && placement !== 1)
    ) {
      throw new Error('STARTER_LOREBOOK_ENTRY_INVALID');
    }
    const selective = value['selective'] === true && secondaryKeys.length > 0;
    const comment = typeof value['comment'] === 'string' ? value['comment'] : undefined;
    return {
      sourceId,
      entry: {
        keys,
        secondaryKeys,
        content,
        enabled: value['disable'] !== true,
        position: order,
        constant: value['constant'] === true,
        selective,
        metadata: {
          promptPlacement: placement === 0 ? 'before' : 'after',
          starterEntryId: sourceId,
          ...(comment ? { comment } : {}),
        },
      },
    };
  });
  if (entries.length !== 4) throw new Error('STARTER_LOREBOOK_ENTRY_COUNT_INVALID');
  return entries;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
