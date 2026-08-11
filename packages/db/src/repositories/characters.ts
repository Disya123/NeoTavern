/**
 * Character repository: CRUD, tags, cursor pagination and FTS search.
 * Never loads the whole catalog; list/search are bounded by limit (ТЗ §2, §12).
 */
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type {
  Character,
  CharacterCreate,
  CharacterUpdate,
  CharacterVersion,
  CursorPage,
} from '@neotavern/contracts';
import { uuidv7 } from '@neotavern/shared';
import type { DrizzleDb, DbExecutor, Clock } from '../db.js';
import { characters, characterTags, characterVersions, tags } from '../schema/index.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import { parseJson, toJson } from '../json.js';
import {
  likePattern,
  parseCharacterQuery,
  prefixPattern,
  type ParsedCharacterQuery,
} from './characterQuery.js';

/** FTS5 MATCH reports syntax problems this way; treated as a soft failure. */
function isFtsMatchError(error: unknown): boolean {
  return error instanceof Error && /fts5:|syntax error/i.test(error.message);
}

type CharacterRow = typeof characters.$inferSelect;

/**
 * `favorite` is authored in `Character.ext` (the editor writes `ext.favorite`,
 * legacy ST1 cards carry `ext.legacy.favorite`). This mirrors the same check
 * the frontend `characterToDraft` does, so the `favorite` column stays in sync
 * with `ext` at every write (migration 0012).
 */
function isFavoriteExt(ext: Record<string, unknown>): boolean {
  if (ext['favorite'] === true) return true;
  const legacy = ext['legacy'];
  return (
    typeof legacy === 'object' &&
    legacy !== null &&
    (legacy as Record<string, unknown>)['favorite'] === true
  );
}

function rowToCharacter(row: CharacterRow, tagsByChar: Map<string, string[]>): Character {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    description: row.description,
    personality: row.personality,
    scenario: row.scenario,
    firstMessage: row.firstMessage,
    exampleDialogues: row.exampleDialogues,
    systemPrompt: row.systemPrompt,
    postHistoryInstructions: row.postHistoryInstructions,
    creator: row.creator,
    creatorNotes: row.creatorNotes,
    ext: parseJson<Record<string, unknown>>(row.ext, {}),
    tags: tagsByChar.get(row.id) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * On-disk version snapshot shape. Matches the import-time snapshots written by
 * `DataImportRepository` (snake_case fields, `ext` as a JSON string, tags as a
 * name array) so both writers produce restorable, interchangeable versions.
 */
interface CharacterSnapshot {
  name?: string;
  avatar?: string | null;
  description?: string;
  personality?: string;
  scenario?: string;
  first_message?: string;
  example_dialogues?: string;
  system_prompt?: string | null;
  post_history_instructions?: string | null;
  creator?: string | null;
  creator_notes?: string | null;
  ext?: string;
  tags?: string[];
}

function rowToSnapshot(row: CharacterRow, tagNames: string[]): string {
  return toJson({
    name: row.name,
    avatar: row.avatar,
    description: row.description,
    personality: row.personality,
    scenario: row.scenario,
    first_message: row.firstMessage,
    example_dialogues: row.exampleDialogues,
    system_prompt: row.systemPrompt,
    post_history_instructions: row.postHistoryInstructions,
    creator: row.creator,
    creator_notes: row.creatorNotes,
    ext: row.ext,
    tags: tagNames,
  } satisfies CharacterSnapshot);
}

/** Canonical catalog sort values used by the character browser. */
export type CharacterSort =
  | 'name'
  | 'name-desc'
  | 'newest'
  | 'oldest'
  | 'favorites'
  | 'used'
  | 'chats-most'
  | 'chats-least'
  | 'tokens-most'
  | 'tokens-least'
  | 'random'
  | 'relevance';

/**
 * Map deprecated `sort` values to their canonical equivalents so existing
 * clients (and the old UI) keep working after the sort vocabulary was
 * expanded. The legacy values are documented as deprecated in `docs/api`.
 */
function normalizeSort(sort: string | undefined): CharacterSort {
  switch (sort) {
    case 'recent':
      // Historical `recent` sorted by created_at DESC, so it maps to `newest`,
      // not to the new "recently used" sort (`used`).
      return 'newest';
    case 'created':
      return 'oldest';
    case 'usage':
      return 'used';
    case undefined:
      return 'newest';
    default:
      return sort as CharacterSort;
  }
}

export interface CharacterListOptions {
  cursor?: string;
  limit?: number;
  tag?: string;
  q?: string;
  sort?: CharacterSort | 'recent' | 'created' | 'usage';
  includeDeleted?: boolean;
}

/**
 * Declarative sort descriptor for the catalog keyset pagination. Each entry
 * owns its ORDER BY, its cursor predicate (the "strictly after the cursor"
 * WHERE clause) and its cursor encoder, so adding a sort is one table row
 * instead of another if/else branch. The tie-breaker is always `id` so the
 * cursor is total (no rows share the full key).
 */
interface SortDescriptor {
  orderBy: SQL[];
  cursorPredicate(cursor: Record<string, unknown>): SQL | undefined;
  encodeCursor(row: CharacterRow): string;
}

const usageKey = sql`COALESCE(${characters.lastUsedAt}, 0)`;

const SORT_DESCRIPTORS: Record<Exclude<CharacterSort, 'relevance' | 'random'>, SortDescriptor> = {
  name: {
    orderBy: [asc(characters.name), asc(characters.id)],
    cursorPredicate: (c) => {
      const n = typeof c['n'] === 'string' ? (c['n'] as string) : null;
      const i = typeof c['i'] === 'string' ? (c['i'] as string) : null;
      return n !== null && i !== null
        ? or(gt(characters.name, n), and(eq(characters.name, n), gt(characters.id, i)))
        : undefined;
    },
    encodeCursor: (row) => encodeCursor({ n: row.name, i: row.id }),
  },
  'name-desc': {
    orderBy: [desc(characters.name), desc(characters.id)],
    cursorPredicate: (c) => {
      const n = typeof c['n'] === 'string' ? (c['n'] as string) : null;
      const i = typeof c['i'] === 'string' ? (c['i'] as string) : null;
      return n !== null && i !== null
        ? or(lt(characters.name, n), and(eq(characters.name, n), lt(characters.id, i)))
        : undefined;
    },
    encodeCursor: (row) => encodeCursor({ n: row.name, i: row.id }),
  },
  newest: {
    orderBy: [desc(characters.createdAt), desc(characters.id)],
    cursorPredicate: (c) => {
      const ct = typeof c['c'] === 'number' ? (c['c'] as number) : null;
      const i = typeof c['i'] === 'string' ? (c['i'] as string) : null;
      return ct !== null && i !== null
        ? or(lt(characters.createdAt, ct), and(eq(characters.createdAt, ct), lt(characters.id, i)))
        : undefined;
    },
    encodeCursor: (row) => encodeCursor({ c: row.createdAt, i: row.id }),
  },
  oldest: {
    orderBy: [asc(characters.createdAt), asc(characters.id)],
    cursorPredicate: (c) => {
      const ct = typeof c['c'] === 'number' ? (c['c'] as number) : null;
      const i = typeof c['i'] === 'string' ? (c['i'] as string) : null;
      return ct !== null && i !== null
        ? or(gt(characters.createdAt, ct), and(eq(characters.createdAt, ct), gt(characters.id, i)))
        : undefined;
    },
    encodeCursor: (row) => encodeCursor({ c: row.createdAt, i: row.id }),
  },
  used: {
    // "Never used" (NULL) sorts last under DESC because COALESCE lifts it to 0.
    orderBy: [desc(usageKey), desc(characters.id)],
    cursorPredicate: (c) => {
      const u = typeof c['u'] === 'number' ? (c['u'] as number) : null;
      const i = typeof c['i'] === 'string' ? (c['i'] as string) : null;
      return u !== null && i !== null
        ? or(lt(usageKey, u), and(eq(usageKey, u), lt(characters.id, i)))
        : undefined;
    },
    encodeCursor: (row) => encodeCursor({ u: row.lastUsedAt ?? 0, i: row.id }),
  },
  favorites: {
    // Favorites first, then A–Z by name, then id.
    orderBy: [desc(characters.favorite), asc(characters.name), asc(characters.id)],
    cursorPredicate: (c) => {
      const f = typeof c['f'] === 'number' ? (c['f'] as number) : null;
      const n = typeof c['n'] === 'string' ? (c['n'] as string) : null;
      const i = typeof c['i'] === 'string' ? (c['i'] as string) : null;
      if (f === null || n === null || i === null) return undefined;
      return or(
        lt(characters.favorite, f),
        or(
          and(eq(characters.favorite, f), gt(characters.name, n)),
          and(eq(characters.favorite, f), eq(characters.name, n), gt(characters.id, i)),
        ),
      );
    },
    encodeCursor: (row) => encodeCursor({ f: row.favorite, n: row.name, i: row.id }),
  },
  'chats-most': {
    orderBy: [desc(characters.chatCount), asc(characters.name), asc(characters.id)],
    cursorPredicate: (c) => {
      const k = typeof c['k'] === 'number' ? (c['k'] as number) : null;
      const n = typeof c['n'] === 'string' ? (c['n'] as string) : null;
      const i = typeof c['i'] === 'string' ? (c['i'] as string) : null;
      if (k === null || n === null || i === null) return undefined;
      return or(
        lt(characters.chatCount, k),
        or(
          and(eq(characters.chatCount, k), gt(characters.name, n)),
          and(eq(characters.chatCount, k), eq(characters.name, n), gt(characters.id, i)),
        ),
      );
    },
    encodeCursor: (row) => encodeCursor({ k: row.chatCount, n: row.name, i: row.id }),
  },
  'chats-least': {
    orderBy: [asc(characters.chatCount), asc(characters.name), asc(characters.id)],
    cursorPredicate: (c) => {
      const k = typeof c['k'] === 'number' ? (c['k'] as number) : null;
      const n = typeof c['n'] === 'string' ? (c['n'] as string) : null;
      const i = typeof c['i'] === 'string' ? (c['i'] as string) : null;
      if (k === null || n === null || i === null) return undefined;
      return or(
        gt(characters.chatCount, k),
        or(
          and(eq(characters.chatCount, k), gt(characters.name, n)),
          and(eq(characters.chatCount, k), eq(characters.name, n), gt(characters.id, i)),
        ),
      );
    },
    encodeCursor: (row) => encodeCursor({ k: row.chatCount, n: row.name, i: row.id }),
  },
  'tokens-most': {
    orderBy: [desc(characters.tokenCount), asc(characters.name), asc(characters.id)],
    cursorPredicate: (c) => {
      const k = typeof c['k'] === 'number' ? (c['k'] as number) : null;
      const n = typeof c['n'] === 'string' ? (c['n'] as string) : null;
      const i = typeof c['i'] === 'string' ? (c['i'] as string) : null;
      if (k === null || n === null || i === null) return undefined;
      return or(
        lt(characters.tokenCount, k),
        or(
          and(eq(characters.tokenCount, k), gt(characters.name, n)),
          and(eq(characters.tokenCount, k), eq(characters.name, n), gt(characters.id, i)),
        ),
      );
    },
    encodeCursor: (row) => encodeCursor({ k: row.tokenCount, n: row.name, i: row.id }),
  },
  'tokens-least': {
    orderBy: [asc(characters.tokenCount), asc(characters.name), asc(characters.id)],
    cursorPredicate: (c) => {
      const k = typeof c['k'] === 'number' ? (c['k'] as number) : null;
      const n = typeof c['n'] === 'string' ? (c['n'] as string) : null;
      const i = typeof c['i'] === 'string' ? (c['i'] as string) : null;
      if (k === null || n === null || i === null) return undefined;
      return or(
        gt(characters.tokenCount, k),
        or(
          and(eq(characters.tokenCount, k), gt(characters.name, n)),
          and(eq(characters.tokenCount, k), eq(characters.name, n), gt(characters.id, i)),
        ),
      );
    },
    encodeCursor: (row) => encodeCursor({ k: row.tokenCount, n: row.name, i: row.id }),
  },
};

export class CharacterRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly clock: Clock,
  ) {}

  async create(input: CharacterCreate): Promise<Character> {
    const now = this.clock();
    const id = uuidv7();
    const tagNames = input.tags ?? [];
    const ext = toJson(input.ext ?? {});
    const row = this.db.transaction((tx) => {
      const created = tx
        .insert(characters)
        .values({
          id,
          name: input.name,
          avatar: input.avatar ?? null,
          description: input.description ?? '',
          personality: input.personality ?? '',
          scenario: input.scenario ?? '',
          firstMessage: input.firstMessage ?? '',
          exampleDialogues: input.exampleDialogues ?? '',
          systemPrompt: input.systemPrompt ?? null,
          postHistoryInstructions: input.postHistoryInstructions ?? null,
          creator: input.creator ?? null,
          creatorNotes: input.creatorNotes ?? null,
          ext,
          // Mirror `ext.favorite` / `ext.legacy.favorite` so "favorites first"
          // is indexable; `ext` stays the source of truth (migration 0012).
          favorite: isFavoriteExt(parseJson<Record<string, unknown>>(ext, {})) ? 1 : 0,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        })
        .returning()
        .get();
      if (tagNames.length > 0) this.replaceTags(tx, id, tagNames);
      return created;
    });
    return rowToCharacter(row, new Map([[id, tagNames]]));
  }

  async getById(id: string): Promise<Character | null> {
    const row = await this.db.select().from(characters).where(eq(characters.id, id)).get();
    if (!row) return null;
    const tagsByChar = await this.loadTags([id]);
    return rowToCharacter(row, tagsByChar);
  }

  /** Resolve an earlier idempotent import by its SHA-256 source hash. */
  async findByImportHash(sourceHash: string): Promise<Character | null> {
    const row = await this.db
      .select()
      .from(characters)
      .where(sql`json_extract(${characters.ext}, '$._st2.importHash') = ${sourceHash}`)
      .limit(1)
      .get();
    if (!row) return null;
    const tagsByChar = await this.loadTags([row.id]);
    return rowToCharacter(row, tagsByChar);
  }

  async list(options: CharacterListOptions = {}): Promise<CursorPage<Character>> {
    const limit = options.limit ?? 50;
    const rawSort = normalizeSort(options.sort);
    const rawQ = options.q?.trim() ?? '';
    const parsed = rawQ.length > 0 ? parseCharacterQuery(rawQ) : null;

    // Any query with positive FTS terms (words, phrases, column filters) uses
    // the FTS path regardless of the requested sort — this is what makes
    // smart queries like `tag:NSFW author:Tidyup "magic sword"` work.
    if (parsed?.ftsText) {
      try {
        return await this.listByRelevance(parsed, options, limit);
      } catch (error) {
        // The parser quotes every term, so MATCH errors are effectively
        // unreachable; if one still happens, keep serving results with the
        // structured filters instead of failing the whole request.
        if (!isFtsMatchError(error)) throw error;
      }
    }

    // Relevance sorting is FTS-rank driven and needs a query; without one (or
    // after an FTS error) it degrades to "newest" rather than an arbitrary
    // order. Random is handled by its own branch (no cursor pagination).
    if (rawSort === 'random') {
      return this.listRandom(parsed, options, limit);
    }
    const sort: Exclude<CharacterSort, 'relevance' | 'random'> =
      rawSort === 'relevance' ? 'newest' : rawSort;

    return this.listFiltered(parsed, options, limit, sort);
  }

  /**
   * Cursor-paginated catalog page for structured filters (tags/author) and
   * plain sorting. Used when the query has no FTS text part (e.g. only
   * `tag:NSFW`), and as the FTS-error fallback.
   */
  private async listFiltered(
    parsed: ParsedCharacterQuery | null,
    options: CharacterListOptions,
    limit: number,
    sort: Exclude<CharacterSort, 'relevance' | 'random'>,
  ): Promise<CursorPage<Character>> {
    const descriptor = SORT_DESCRIPTORS[sort];

    const conds: SQL[] = [];
    if (!options.includeDeleted) conds.push(isNull(characters.deletedAt));
    if (options.tag) {
      conds.push(
        exists(
          this.db
            .select()
            .from(characterTags)
            .innerJoin(tags, eq(characterTags.tagId, tags.id))
            .where(and(eq(characterTags.characterId, characters.id), eq(tags.name, options.tag))),
        ),
      );
    }
    if (parsed) {
      for (const tagName of parsed.includeTags) {
        conds.push(
          exists(
            this.db
              .select()
              .from(characterTags)
              .innerJoin(tags, eq(characterTags.tagId, tags.id))
              .where(
                and(
                  eq(characterTags.characterId, characters.id),
                  sql`${tags.name} LIKE ${prefixPattern(tagName)} COLLATE NOCASE ESCAPE '\\'`,
                ),
              ),
          ),
        );
      }
      for (const tagName of parsed.excludeTags) {
        conds.push(
          sql`NOT EXISTS (
             SELECT 1 FROM character_tags ct JOIN tags t ON t.id = ct.tag_id
             WHERE ct.character_id = ${characters.id} AND t.name LIKE ${prefixPattern(tagName)} COLLATE NOCASE ESCAPE '\\'
           )`,
        );
      }
      if (parsed.author)
        conds.push(
          sql`${characters.creator} LIKE ${likePattern(parsed.author)} COLLATE NOCASE ESCAPE '\\'`,
        );
      if (parsed.excludeAuthor)
        conds.push(
          sql`(${characters.creator} IS NULL OR ${characters.creator} NOT LIKE ${likePattern(parsed.excludeAuthor)} COLLATE NOCASE ESCAPE '\\')`,
        );
      if (parsed.excludeName)
        conds.push(
          sql`${characters.name} NOT LIKE ${likePattern(parsed.excludeName)} COLLATE NOCASE ESCAPE '\\'`,
        );
    }

    const decoded = decodeCursor(options.cursor);
    if (decoded) {
      const cursorCond = descriptor.cursorPredicate(decoded);
      if (cursorCond) conds.push(cursorCond);
    }

    const rows = await this.db
      .select()
      .from(characters)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(...descriptor.orderBy)
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const tagsByChar = await this.loadTags(page.map((r) => r.id));
    const items = page.map((r) => rowToCharacter(r, tagsByChar));

    let nextCursor: string | null = null;
    if (hasMore) {
      const last = page[page.length - 1];
      if (last) nextCursor = descriptor.encodeCursor(last);
    }

    return { items, nextCursor, hasMore };
  }

  /**
   * Single random catalog page. `ORDER BY random()` is incompatible with
   * keyset pagination (the cursor position is not stable), so the page is
   * returned with `hasMore: false` and no cursor — each request is a fresh
   * shuffle. Structured filters (tags/author) still apply. FTS-text queries
   * never reach here: `list()` routes them to `listByRelevance` first.
   */
  private async listRandom(
    parsed: ParsedCharacterQuery | null,
    options: CharacterListOptions,
    limit: number,
  ): Promise<CursorPage<Character>> {
    const conds: SQL[] = [];
    if (!options.includeDeleted) conds.push(isNull(characters.deletedAt));
    if (options.tag) {
      conds.push(
        exists(
          this.db
            .select()
            .from(characterTags)
            .innerJoin(tags, eq(characterTags.tagId, tags.id))
            .where(and(eq(characterTags.characterId, characters.id), eq(tags.name, options.tag))),
        ),
      );
    }
    if (parsed) {
      for (const tagName of parsed.includeTags) {
        conds.push(
          exists(
            this.db
              .select()
              .from(characterTags)
              .innerJoin(tags, eq(characterTags.tagId, tags.id))
              .where(
                and(
                  eq(characterTags.characterId, characters.id),
                  sql`${tags.name} LIKE ${prefixPattern(tagName)} COLLATE NOCASE ESCAPE '\\'`,
                ),
              ),
          ),
        );
      }
      for (const tagName of parsed.excludeTags) {
        conds.push(
          sql`NOT EXISTS (
             SELECT 1 FROM character_tags ct JOIN tags t ON t.id = ct.tag_id
             WHERE ct.character_id = ${characters.id} AND t.name LIKE ${prefixPattern(tagName)} COLLATE NOCASE ESCAPE '\\'
           )`,
        );
      }
      if (parsed.author)
        conds.push(
          sql`${characters.creator} LIKE ${likePattern(parsed.author)} COLLATE NOCASE ESCAPE '\\'`,
        );
      if (parsed.excludeAuthor)
        conds.push(
          sql`(${characters.creator} IS NULL OR ${characters.creator} NOT LIKE ${likePattern(parsed.excludeAuthor)} COLLATE NOCASE ESCAPE '\\')`,
        );
      if (parsed.excludeName)
        conds.push(
          sql`${characters.name} NOT LIKE ${likePattern(parsed.excludeName)} COLLATE NOCASE ESCAPE '\\'`,
        );
    }

    const rows = await this.db
      .select()
      .from(characters)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(sql`random()`)
      .limit(limit);

    const tagsByChar = await this.loadTags(rows.map((r) => r.id));
    const items = rows.map((r) => rowToCharacter(r, tagsByChar));
    return { items, nextCursor: null, hasMore: false };
  }

  /**
   * FTS-rank ordered catalog page for smart queries. Searches name,
   * description, personality and scenario (via characters_fts) with
   * phrase/column filters from the query parser; tag/author filters are
   * applied as SQL conditions over the FTS hits. Cursor keys on (rank, id).
   */
  private async listByRelevance(
    parsed: ParsedCharacterQuery,
    options: CharacterListOptions,
    limit: number,
  ): Promise<CursorPage<Character>> {
    const ftsQuery = parsed.ftsText;
    if (ftsQuery === null) return this.list({ ...options, sort: 'recent' });

    const decoded = decodeCursor(options.cursor);
    const cursorR = typeof decoded?.['r'] === 'number' ? (decoded['r'] as number) : null;
    const cursorI = typeof decoded?.['i'] === 'string' ? (decoded['i'] as string) : null;

    const cursorCond =
      cursorR !== null && cursorI !== null
        ? sql`AND (f.rank > ${cursorR} OR (f.rank = ${cursorR} AND f.character_id > ${cursorI}))`
        : sql``;
    const deletedCond = options.includeDeleted ? sql`` : sql`AND c.deleted_at IS NULL`;

    const conds: SQL[] = [];
    if (options.tag) {
      conds.push(
        sql`AND EXISTS (
           SELECT 1 FROM character_tags ct
           JOIN tags t ON t.id = ct.tag_id
           WHERE ct.character_id = f.character_id AND t.name = ${options.tag} COLLATE NOCASE
         )`,
      );
    }
    for (const tagName of parsed.includeTags) {
      conds.push(
        sql`AND EXISTS (
           SELECT 1 FROM character_tags ct
           JOIN tags t ON t.id = ct.tag_id
           WHERE ct.character_id = f.character_id AND t.name LIKE ${prefixPattern(tagName)} COLLATE NOCASE ESCAPE '\\'
         )`,
      );
    }
    for (const tagName of parsed.excludeTags) {
      conds.push(
        sql`AND NOT EXISTS (
           SELECT 1 FROM character_tags ct
           JOIN tags t ON t.id = ct.tag_id
           WHERE ct.character_id = f.character_id AND t.name LIKE ${prefixPattern(tagName)} COLLATE NOCASE ESCAPE '\\'
         )`,
      );
    }
    if (parsed.author)
      conds.push(sql`AND c.creator LIKE ${likePattern(parsed.author)} COLLATE NOCASE ESCAPE '\\'`);
    if (parsed.excludeAuthor)
      conds.push(
        sql`AND (c.creator IS NULL OR c.creator NOT LIKE ${likePattern(parsed.excludeAuthor)} COLLATE NOCASE ESCAPE '\\')`,
      );
    if (parsed.excludeName)
      conds.push(
        sql`AND c.name NOT LIKE ${likePattern(parsed.excludeName)} COLLATE NOCASE ESCAPE '\\'`,
      );
    const filterConds = conds.length > 0 ? sql.join(conds, sql.raw(' ')) : sql``;

    const hits = await this.db.all<{ id: string; rank: number }>(
      sql`SELECT f.character_id AS id, f.rank AS rank
          FROM characters_fts f
          JOIN characters c ON c.id = f.character_id
          WHERE characters_fts MATCH ${ftsQuery} ${deletedCond} ${filterConds} ${cursorCond}
          ORDER BY f.rank ASC, f.character_id ASC
          LIMIT ${limit + 1}`,
    );

    const hasMore = hits.length > limit;
    const page = hasMore ? hits.slice(0, limit) : hits;
    const rows = await this.db
      .select()
      .from(characters)
      .where(
        inArray(
          characters.id,
          page.map((h) => h.id),
        ),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const tagsByChar = await this.loadTags(page.map((h) => h.id));
    const items = page
      .map((h) => {
        const row = byId.get(h.id);
        return row ? rowToCharacter(row, tagsByChar) : null;
      })
      .filter((c): c is Character => c !== null);

    let nextCursor: string | null = null;
    if (hasMore) {
      const last = page[page.length - 1];
      if (last) nextCursor = encodeCursor({ r: last.rank, i: last.id });
    }
    return { items, nextCursor, hasMore };
  }

  async update(id: string, patch: CharacterUpdate): Promise<Character | null> {
    const existing = await this.db.select().from(characters).where(eq(characters.id, id)).get();
    if (!existing) return null;

    const values: Partial<CharacterRow> = { updatedAt: this.clock() };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.avatar !== undefined) values.avatar = patch.avatar;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.personality !== undefined) values.personality = patch.personality;
    if (patch.scenario !== undefined) values.scenario = patch.scenario;
    if (patch.firstMessage !== undefined) values.firstMessage = patch.firstMessage;
    if (patch.exampleDialogues !== undefined) values.exampleDialogues = patch.exampleDialogues;
    if (patch.systemPrompt !== undefined) values.systemPrompt = patch.systemPrompt;
    if (patch.postHistoryInstructions !== undefined)
      values.postHistoryInstructions = patch.postHistoryInstructions;
    if (patch.creator !== undefined) values.creator = patch.creator;
    if (patch.creatorNotes !== undefined) values.creatorNotes = patch.creatorNotes;
    if (patch.ext !== undefined) {
      // Merge to preserve unknown/extension metadata (ТЗ §10.2).
      const merged = { ...parseJson<Record<string, unknown>>(existing.ext, {}), ...patch.ext };
      values.ext = toJson(merged);
      // Mirror `ext.favorite` / `ext.legacy.favorite` into the indexed column
      // (migration 0012). `ext` stays the source of truth; the column only
      // makes "favorites first" ordering indexable.
      values.favorite = isFavoriteExt(merged) ? 1 : 0;
    }

    // Snapshot + row update + tag replacement are one atomic unit (OTHER-62):
    // a failure mid-way must not leave replaced tags next to a stale snapshot.
    const snapshotTags = (await this.loadTags([id])).get(id) ?? [];
    const row = this.db.transaction((tx) => {
      this.snapshotVersion(tx, id, existing, snapshotTags);
      const updated = tx
        .update(characters)
        .set(values)
        .where(eq(characters.id, id))
        .returning()
        .get();
      if (patch.tags !== undefined) this.replaceTags(tx, id, patch.tags);
      return updated;
    });

    const tagsByChar = await this.loadTags([id]);
    return rowToCharacter(row, tagsByChar);
  }

  /** Soft delete (moves to trash). */
  async softDelete(id: string): Promise<boolean> {
    const result = await this.db
      .update(characters)
      .set({ deletedAt: this.clock(), updatedAt: this.clock() })
      .where(eq(characters.id, id))
      .run();
    return result.changes > 0;
  }

  async restore(id: string): Promise<boolean> {
    const result = await this.db
      .update(characters)
      .set({ deletedAt: null, updatedAt: this.clock() })
      .where(eq(characters.id, id))
      .run();
    return result.changes > 0;
  }

  /** Hard delete (permanent). */
  async hardDelete(id: string): Promise<boolean> {
    const result = await this.db.delete(characters).where(eq(characters.id, id)).run();
    return result.changes > 0;
  }

  /** Record that the character was used (chat created / message written). */
  async touchUsage(id: string): Promise<void> {
    await this.db
      .update(characters)
      .set({ lastUsedAt: this.clock() })
      .where(eq(characters.id, id))
      .run();
  }

  // --- version history (ТЗ §10.2 character_versions) ---

  async listVersions(characterId: string): Promise<CharacterVersion[]> {
    const rows = await this.db
      .select()
      .from(characterVersions)
      .where(eq(characterVersions.characterId, characterId))
      .orderBy(desc(characterVersions.version))
      .all();
    return rows.map((r) => ({
      id: r.id,
      characterId: r.characterId,
      version: r.version,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Restore a stored snapshot. The current state is snapshotted first, so a
   * restore is itself reversible. Returns null when the character or version
   * does not exist, or the snapshot is unreadable.
   */
  async restoreVersion(characterId: string, versionId: string): Promise<Character | null> {
    const version = await this.db
      .select()
      .from(characterVersions)
      .where(
        and(eq(characterVersions.id, versionId), eq(characterVersions.characterId, characterId)),
      )
      .get();
    if (!version) return null;
    const current = await this.db
      .select()
      .from(characters)
      .where(eq(characters.id, characterId))
      .get();
    if (!current) return null;

    const snapshot = parseJson<CharacterSnapshot | null>(version.snapshot, null);
    if (!snapshot) return null;

    const values: Partial<CharacterRow> = { updatedAt: this.clock() };
    if (snapshot.name !== undefined) values.name = snapshot.name;
    if (snapshot.avatar !== undefined) values.avatar = snapshot.avatar;
    if (snapshot.description !== undefined) values.description = snapshot.description;
    if (snapshot.personality !== undefined) values.personality = snapshot.personality;
    if (snapshot.scenario !== undefined) values.scenario = snapshot.scenario;
    if (snapshot.first_message !== undefined) values.firstMessage = snapshot.first_message;
    if (snapshot.example_dialogues !== undefined)
      values.exampleDialogues = snapshot.example_dialogues;
    if (snapshot.system_prompt !== undefined) values.systemPrompt = snapshot.system_prompt;
    if (snapshot.post_history_instructions !== undefined)
      values.postHistoryInstructions = snapshot.post_history_instructions;
    if (snapshot.creator !== undefined) values.creator = snapshot.creator;
    if (snapshot.creator_notes !== undefined) values.creatorNotes = snapshot.creator_notes;
    if (typeof snapshot.ext === 'string') values.ext = snapshot.ext;

    // Snapshot of the pre-restore state + the restore + tag sync are atomic
    // (OTHER-62).
    const snapshotTags = (await this.loadTags([characterId])).get(characterId) ?? [];
    const row = this.db.transaction((tx) => {
      this.snapshotVersion(tx, characterId, current, snapshotTags);
      const restored = tx
        .update(characters)
        .set(values)
        .where(eq(characters.id, characterId))
        .returning()
        .get();
      if (snapshot.tags !== undefined) this.replaceTags(tx, characterId, snapshot.tags);
      return restored;
    });
    const tagsByChar = await this.loadTags([characterId]);
    return rowToCharacter(row, tagsByChar);
  }

  /**
   * Insert the next numbered snapshot for a character's current row. Runs on
   * the passed executor so callers can include it in a transaction (the
   * MAX(version)+1 read is then race-free under the write lock).
   */
  private snapshotVersion(db: DbExecutor, id: string, row: CharacterRow, tagNames: string[]): void {
    const next = db
      .select({ v: sql<number>`COALESCE(MAX(${characterVersions.version}), 0) + 1` })
      .from(characterVersions)
      .where(eq(characterVersions.characterId, id))
      .get();
    db.insert(characterVersions)
      .values({
        id: uuidv7(),
        characterId: id,
        version: next?.v ?? 1,
        snapshot: rowToSnapshot(row, tagNames),
        createdAt: this.clock(),
      })
      .run();
  }

  /** Replace the full tag set for a character on the passed executor. */
  private replaceTags(db: DbExecutor, characterId: string, tagNames: string[]): void {
    const uniqueNames = [...new Set(tagNames.map((n) => n.trim()).filter((n) => n.length > 0))];

    // Ensure tags exist.
    for (const name of uniqueNames) {
      db.insert(tags)
        .values({ id: uuidv7(), name })
        .onConflictDoNothing({ target: tags.name })
        .run();
    }

    let tagIds: string[] = [];
    if (uniqueNames.length > 0) {
      const found = db.select().from(tags).where(inArray(tags.name, uniqueNames)).all();
      tagIds = found.map((t) => t.id);
    }

    // Remove existing links, then add the new set.
    db.delete(characterTags).where(eq(characterTags.characterId, characterId)).run();
    for (const tagId of tagIds) {
      db.insert(characterTags).values({ characterId, tagId }).onConflictDoNothing().run();
    }
  }

  private async loadTags(characterIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (characterIds.length === 0) return map;
    const rows = await this.db
      .select({
        characterId: characterTags.characterId,
        name: tags.name,
      })
      .from(characterTags)
      .innerJoin(tags, eq(characterTags.tagId, tags.id))
      .where(inArray(characterTags.characterId, characterIds));
    for (const row of rows) {
      const list = map.get(row.characterId) ?? [];
      list.push(row.name);
      map.set(row.characterId, list);
    }
    return map;
  }
}
