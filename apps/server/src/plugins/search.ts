/** Full-text search route: /api/v2/search (SQLite FTS5). */
import { SearchQuerySchema, SearchResponseSchema } from '@neotavern/contracts';
import type { AppContext, TypedApp } from '../types.js';

export async function registerSearchRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  app.get(
    '/api/v2/search',
    { schema: { querystring: SearchQuerySchema, response: { 200: SearchResponseSchema } } },
    async (req) => {
      const { q, scope, limit, tag, sort } = req.query;
      return ctx.database.repos.search.search(q, scope, limit ?? 50, { tag, sort });
    },
  );

  // Manual FTS index rebuild (ТЗ §12).
  app.post(
    '/api/v2/search/rebuild',
    { schema: { response: { 200: SearchResponseSchema } } },
    async () => {
      await ctx.database.repos.search.rebuild();
      return { query: '', results: [] };
    },
  );
}
