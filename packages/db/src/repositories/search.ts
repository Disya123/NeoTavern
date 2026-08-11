/**
 * Full-text search over characters, chats, messages and lorebooks using SQLite
 * FTS5. The FTS indexes are kept in sync by database triggers (see migrations).
 *
 * Supports prefix search, tag-aware filtering for tagged scopes (characters),
 * date/name/relevance sorting and transactional rebuilds (ТЗ §12).
 */
import { and, eq, exists, inArray, isNull, sql } from 'drizzle-orm';
import type { SearchResponse, SearchResult, SearchScope, SearchSort } from '@neotavern/contracts';
import type { DrizzleDb } from '../db.js';
import {
  characters,
  characterTags,
  chats,
  lorebooks,
  loreEntries,
  messages,
  tags,
} from '../schema/index.js';

/**
 * Build a safe FTS5 MATCH expression from free text. Each token is quoted and
 * given a `*` suffix for prefix search (ТЗ §12); quoting prevents FTS syntax
 * errors from punctuation. Limited to 10 tokens.
 */
export function buildFtsQuery(q: string): string {
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, '').trim())
    .filter((t) => t.length > 0)
    .slice(0, 10);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"*`).join(' ');
}

interface FtsHit {
  id: string;
  rank: number;
}

export interface SearchOptions {
  /** Tag filter — applied to scopes that carry tags (characters only). */
  tag?: string;
  /** Result ordering; defaults to relevance (FTS rank). */
  sort?: SearchSort;
}

export class SearchRepository {
  constructor(private readonly db: DrizzleDb) {}

  async search(
    q: string,
    scope: SearchScope | undefined,
    limit: number,
    options: SearchOptions = {},
  ): Promise<SearchResponse> {
    const ftsQuery = buildFtsQuery(q);
    if (ftsQuery.length === 0) return { query: q, results: [] };

    const scopes: SearchScope[] = scope
      ? [scope]
      : ['characters', 'chats', 'messages', 'lorebooks'];
    const results: SearchResult[] = [];
    for (const s of scopes) {
      if (s === 'characters')
        results.push(...(await this.searchCharacters(ftsQuery, limit, options.tag)));
      else if (s === 'chats') results.push(...(await this.searchChats(ftsQuery, limit)));
      else if (s === 'messages') results.push(...(await this.searchMessages(ftsQuery, limit)));
      else if (s === 'lorebooks') results.push(...(await this.searchLorebooks(ftsQuery, limit)));
    }

    const sort = options.sort ?? 'relevance';
    if (sort === 'date') {
      results.sort((a, b) => b.timestamp - a.timestamp);
    } else if (sort === 'name') {
      results.sort((a, b) => a.title.localeCompare(b.title));
    } else {
      // Best (most negative rank → highest score) first.
      results.sort((a, b) => b.score - a.score);
    }
    return { query: q, results: results.slice(0, limit) };
  }

  private async searchCharacters(
    ftsQuery: string,
    limit: number,
    tag?: string,
  ): Promise<SearchResult[]> {
    const hits = await this.db.all<FtsHit>(
      sql`SELECT character_id AS id, rank AS rank
          FROM characters_fts
          WHERE characters_fts MATCH ${ftsQuery}
          ORDER BY rank
          LIMIT ${limit}`,
    );
    if (hits.length === 0) return [];
    const ids = hits.map((h) => h.id);
    const conds = [and(inArray(characters.id, ids), isNull(characters.deletedAt))];
    if (tag) {
      conds.push(
        exists(
          this.db
            .select()
            .from(characterTags)
            .innerJoin(tags, eq(characterTags.tagId, tags.id))
            .where(and(eq(characterTags.characterId, characters.id), eq(tags.name, tag))),
        ),
      );
    }
    const rows = await this.db
      .select()
      .from(characters)
      .where(and(...conds));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return hits
      .map((h): SearchResult | null => {
        const row = byId.get(h.id);
        if (!row) return null;
        return {
          scope: 'characters',
          id: row.id,
          title: row.name,
          snippet: snippet(row.description || row.personality, 160),
          score: -h.rank,
          timestamp: row.updatedAt,
        };
      })
      .filter((r): r is SearchResult => r !== null);
  }

  private async searchChats(ftsQuery: string, limit: number): Promise<SearchResult[]> {
    const hits = await this.db.all<FtsHit>(
      sql`SELECT chat_id AS id, rank AS rank
          FROM chats_fts
          WHERE chats_fts MATCH ${ftsQuery}
          ORDER BY rank
          LIMIT ${limit}`,
    );
    if (hits.length === 0) return [];
    const ids = hits.map((h) => h.id);
    const rows = await this.db
      .select()
      .from(chats)
      .where(and(inArray(chats.id, ids), isNull(chats.deletedAt)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return hits
      .map((h): SearchResult | null => {
        const row = byId.get(h.id);
        if (!row) return null;
        return {
          scope: 'chats',
          id: row.id,
          title: row.title,
          snippet: snippet(row.summary, 160),
          score: -h.rank,
          timestamp: row.updatedAt,
        };
      })
      .filter((r): r is SearchResult => r !== null);
  }

  private async searchMessages(ftsQuery: string, limit: number): Promise<SearchResult[]> {
    const hits = await this.db.all<FtsHit>(
      sql`SELECT message_id AS id, rank AS rank
          FROM messages_fts
          WHERE messages_fts MATCH ${ftsQuery}
          ORDER BY rank
          LIMIT ${limit}`,
    );
    if (hits.length === 0) return [];
    const ids = hits.map((h) => h.id);
    // Exclude messages of soft-deleted chats (trash is not searchable).
    const rows = await this.db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(chats, eq(messages.chatId, chats.id))
      .where(and(inArray(messages.id, ids), isNull(chats.deletedAt)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return hits
      .map((h): SearchResult | null => {
        const row = byId.get(h.id);
        if (!row) return null;
        return {
          scope: 'messages',
          id: row.id,
          title: row.role,
          snippet: snippet(row.content, 160),
          score: -h.rank,
          timestamp: row.createdAt,
        };
      })
      .filter((r): r is SearchResult => r !== null);
  }

  private async searchLorebooks(ftsQuery: string, limit: number): Promise<SearchResult[]> {
    // Books themselves (name/description) — via the dedicated lorebooks_fts.
    const bookHits = await this.db.all<FtsHit>(
      sql`SELECT lorebook_id AS id, rank AS rank
          FROM lorebooks_fts
          WHERE lorebooks_fts MATCH ${ftsQuery}
          ORDER BY rank
          LIMIT ${limit}`,
    );
    const bookResults: SearchResult[] = [];
    if (bookHits.length > 0) {
      const bookRows = await this.db
        .select()
        .from(lorebooks)
        .where(
          and(
            inArray(
              lorebooks.id,
              bookHits.map((h) => h.id),
            ),
            isNull(lorebooks.deletedAt),
          ),
        );
      const byId = new Map(bookRows.map((r) => [r.id, r]));
      for (const h of bookHits) {
        const row = byId.get(h.id);
        if (!row) continue;
        bookResults.push({
          scope: 'lorebooks',
          id: row.id,
          title: row.name,
          snippet: snippet(row.description, 160),
          score: -h.rank,
          timestamp: row.updatedAt,
        });
      }
    }

    // Entries inside books — via lore_entries_fts (the richer content index).
    const entryHits = await this.db.all<FtsHit>(
      sql`SELECT entry_id AS id, rank AS rank
          FROM lore_entries_fts
          WHERE lore_entries_fts MATCH ${ftsQuery}
          ORDER BY rank
          LIMIT ${limit}`,
    );
    const entryResults: SearchResult[] = [];
    if (entryHits.length > 0) {
      const ids = entryHits.map((h) => h.id);
      const rows = await this.db
        .select({
          entryId: loreEntries.id,
          content: loreEntries.content,
          updatedAt: loreEntries.updatedAt,
          bookName: lorebooks.name,
        })
        .from(loreEntries)
        .innerJoin(lorebooks, eq(loreEntries.lorebookId, lorebooks.id))
        .where(and(inArray(loreEntries.id, ids), isNull(lorebooks.deletedAt)));
      const byId = new Map(rows.map((r) => [r.entryId, r]));
      for (const h of entryHits) {
        const row = byId.get(h.id);
        if (!row) continue;
        entryResults.push({
          scope: 'lorebooks',
          id: row.entryId,
          title: row.bookName,
          snippet: snippet(row.content, 160),
          score: -h.rank,
          timestamp: row.updatedAt,
        });
      }
    }

    return [...bookResults, ...entryResults].slice(0, limit * 2);
  }

  /**
   * Rebuild all FTS indexes from base tables (ТЗ §12: rebuild from UI).
   * Transactional: readers never observe an emptied or partial index.
   */
  async rebuild(): Promise<void> {
    await this.db.transaction((tx) => {
      tx.run(sql`DELETE FROM characters_fts`);
      tx.run(
        sql`INSERT INTO characters_fts(character_id, name, description, personality, scenario, tags)
            SELECT c.id, c.name, c.description, c.personality, c.scenario,
                   COALESCE((SELECT group_concat(t.name, ' ') FROM character_tags ct
                             JOIN tags t ON t.id = ct.tag_id WHERE ct.character_id = c.id), '')
            FROM characters c`,
      );
      tx.run(sql`DELETE FROM chats_fts`);
      tx.run(
        sql`INSERT INTO chats_fts(chat_id, title, summary) SELECT id, title, summary FROM chats`,
      );
      tx.run(sql`DELETE FROM messages_fts`);
      tx.run(
        sql`INSERT INTO messages_fts(message_id, chat_id, content)
            SELECT id, chat_id, content FROM messages`,
      );
      tx.run(sql`DELETE FROM lore_entries_fts`);
      tx.run(
        sql`INSERT INTO lore_entries_fts(entry_id, lorebook_id, keys, content)
            SELECT id, lorebook_id, keys_json, content FROM lore_entries`,
      );
      tx.run(sql`DELETE FROM lorebooks_fts`);
      tx.run(
        sql`INSERT INTO lorebooks_fts(lorebook_id, name, description)
            SELECT id, name, description FROM lorebooks`,
      );
      // memories_fts (migration 0006) must be rebuilt too — omitting it left
      // the index permanently stale after any rebuild.
      tx.run(sql`DELETE FROM memories_fts`);
      tx.run(
        sql`INSERT INTO memories_fts(memory_id, keys, content)
            SELECT id, keys_json, content FROM memories`,
      );
    });
  }
}

function snippet(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
