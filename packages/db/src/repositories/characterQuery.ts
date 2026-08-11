/**
 * Smart query parser for the character catalog (ТЗ §12).
 *
 * Transforms a single search string like
 * `tag:NSFW author:Tidyup "magic sword" -tag:beta`
 * into an FTS5 MATCH expression plus structured SQL filters.
 *
 * Syntax:
 * - `word`            free-text term, prefix match in FTS (`"word"*`)
 * - `"phrase"`        exact consecutive-token phrase in FTS
 * - `-word` / `-"phrase"`  FTS negation (rendered as `NOT ...`)
 * - `tag:value`       tag filter by prefix (case-insensitive), repeatable (AND);
 *                      `-tag:value` excludes matching tags
 * - `author:value`    creator substring filter (case-insensitive);
 *                      `-author:value` excludes matching creators
 * - `name:` / `desc:` / `persona:` / `scenario:`
 *                      column-scoped FTS prefix search; `-name:value` falls
 *                      back to a SQL `NOT LIKE` (FTS5 cannot negate column
 *                      filters), negated `desc:`/`persona:`/`scenario:` are
 *                      ignored (unsupported by FTS5)
 * - unknown `key:value` is treated as plain free text
 *
 * Quoted values are supported: `tag:"science fiction"`.
 *
 * Limitation: FTS5 rejects an expression that is all `NOT`s. When a query has
 * only negated terms, `ftsText` is `null` and only the structured SQL filters
 * (tags/author/name) are applied — documented behavior, not an error.
 */

/** Structured filters extracted from a character search query. */
export interface ParsedCharacterQuery {
  /** Safe FTS5 MATCH expression, or null when there is nothing to match. */
  ftsText: string | null;
  /** Tags the character must have (AND semantics). */
  includeTags: string[];
  /** Tags the character must not have. */
  excludeTags: string[];
  /** Creator substring filter. */
  author: string | null;
  /** Creator substring exclusion. */
  excludeAuthor: string | null;
  /** Name exclusion (SQL NOT LIKE; positive name filter goes through FTS). */
  excludeName: string | null;
}

type QueryField = 'tag' | 'author' | 'name' | 'desc' | 'persona' | 'scenario';

interface ParsedToken {
  negated: boolean;
  kind: 'word' | 'phrase' | 'field';
  value: string;
  field?: QueryField;
}

const FIELD_COLUMN: Record<'name' | 'desc' | 'persona' | 'scenario', string> = {
  name: 'name',
  desc: 'description',
  persona: 'personality',
  scenario: 'scenario',
};

const MAX_TOKENS = 10;

/** Split on whitespace outside double quotes, keeping quotes in the tokens. */
function splitQueryTokens(q: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of q) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (/\s/.test(char) && !inQuotes) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function parseToken(raw: string): ParsedToken | null {
  let negated = false;
  let token = raw;
  if (token.startsWith('-')) {
    negated = true;
    token = token.slice(1);
  }
  if (token.length === 0) return null;

  const fieldMatch = /^([A-Za-z]+):(.*)$/s.exec(token);
  if (fieldMatch) {
    const key = (fieldMatch[1] ?? '').toLowerCase();
    const value = unquote(fieldMatch[2] ?? '')
      .replace(/""/g, '"')
      .trim();
    if (value.length > 0) {
      if (key === 'tag' || key === 'author') {
        return { negated, kind: 'field', value, field: key };
      }
      if (key === 'name' || key === 'desc' || key === 'persona' || key === 'scenario') {
        return { negated, kind: 'field', value, field: key };
      }
    }
    // Unknown key or empty value: treat the original token as free text.
    token = raw;
  }

  if (token.startsWith('"') && token.endsWith('"') && token.length >= 2) {
    const inner = unquote(token).replace(/""/g, '"').trim();
    if (inner.length === 0) return null;
    return { negated, kind: 'phrase', value: inner };
  }

  const clean = token.replace(/["']/g, '').trim();
  if (clean.length === 0) return null;
  return { negated, kind: 'word', value: clean };
}

/** Escape a double quote inside an FTS5 phrase by doubling it. */
function ftsQuote(value: string): string {
  return value.replace(/"/g, '""');
}

/** Escape LIKE wildcards so user input matches literally. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export const EMPTY_CHARACTER_QUERY: ParsedCharacterQuery = {
  ftsText: null,
  includeTags: [],
  excludeTags: [],
  author: null,
  excludeAuthor: null,
  excludeName: null,
};

/**
 * Parse a character catalog search string. Structured filters are always
 * returned; `ftsText` is non-null only when there is at least one positive
 * FTS term/phrase/column filter to match.
 */
export function parseCharacterQuery(q: string): ParsedCharacterQuery {
  const parsed: ParsedCharacterQuery = {
    ftsText: null,
    includeTags: [],
    excludeTags: [],
    author: null,
    excludeAuthor: null,
    excludeName: null,
  };
  const positives: string[] = [];
  const negatives: string[] = [];

  for (const raw of splitQueryTokens(q).slice(0, MAX_TOKENS)) {
    const token = parseToken(raw);
    if (!token) continue;
    if (token.kind === 'field') {
      if (token.field === 'tag') {
        (token.negated ? parsed.excludeTags : parsed.includeTags).push(token.value);
        continue;
      }
      if (token.field === 'author') {
        if (token.negated) parsed.excludeAuthor = token.value;
        else parsed.author = token.value;
        continue;
      }
      // Column-scoped filters live in the FTS MATCH expression.
      if (token.negated) {
        // FTS5 cannot negate column filters; only name has a SQL fallback.
        if (token.field === 'name') parsed.excludeName = token.value;
        continue;
      }
      positives.push(
        `${FIELD_COLUMN[token.field as 'name' | 'desc' | 'persona' | 'scenario']} : "${ftsQuote(token.value)}"*`,
      );
      continue;
    }
    const rendered = `"${ftsQuote(token.value)}"${token.kind === 'word' ? '*' : ''}`;
    if (token.negated) negatives.push(rendered);
    else positives.push(rendered);
  }

  if (positives.length > 0) {
    parsed.ftsText = [...positives, ...negatives.map((part) => `NOT ${part}`)].join(' ');
  }
  return parsed;
}

/**
 * LIKE pattern for a substring filter: `%value%` with wildcards escaped.
 * Use with `COLLATE NOCASE ESCAPE '\'` for case-insensitive matching.
 */
export function likePattern(value: string): string {
  return `%${escapeLikePattern(value)}%`;
}

/**
 * LIKE pattern for a prefix filter: `value%` with wildcards escaped.
 * Used by `tag:` / `-tag:` so a partial tag name still matches
 * (`tag:sf` finds the tag `sfw`). Use with `COLLATE NOCASE ESCAPE '\'`.
 */
export function prefixPattern(value: string): string {
  return `${escapeLikePattern(value)}%`;
}
