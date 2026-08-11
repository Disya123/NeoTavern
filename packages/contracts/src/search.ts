/**
 * Full-text search contracts (SQLite FTS5 backend, ТЗ §12).
 */
import { Type, type Static } from '@sinclair/typebox';
import { IdSchema } from './common.js';

export const SearchScopeSchema = Type.Union([
  Type.Literal('characters'),
  Type.Literal('chats'),
  Type.Literal('messages'),
  Type.Literal('lorebooks'),
]);
export type SearchScope = Static<typeof SearchScopeSchema>;

/** Result ordering for global search (ТЗ §12). */
export const SearchSortSchema = Type.Union([
  Type.Literal('relevance'),
  Type.Literal('date'),
  Type.Literal('name'),
]);
export type SearchSort = Static<typeof SearchSortSchema>;

export const SearchQuerySchema = Type.Object({
  q: Type.String({ minLength: 1, maxLength: 500 }),
  scope: Type.Optional(SearchScopeSchema),
  /** Tag filter; applies to scopes that carry tags (characters). */
  tag: Type.Optional(Type.String()),
  sort: Type.Optional(SearchSortSchema),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
});
export type SearchQuery = Static<typeof SearchQuerySchema>;

export const SearchResultSchema = Type.Object({
  scope: SearchScopeSchema,
  id: IdSchema,
  title: Type.String(),
  snippet: Type.String(),
  score: Type.Number(),
  /** Last modification time of the matched entity (epoch ms), for date sorting. */
  timestamp: Type.Integer(),
});
export type SearchResult = Static<typeof SearchResultSchema>;

export const SearchResponseSchema = Type.Object({
  query: Type.String(),
  results: Type.Array(SearchResultSchema),
});
export type SearchResponse = Static<typeof SearchResponseSchema>;
