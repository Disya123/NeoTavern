/**
 * Opaque cursor encoding for keyset pagination. A cursor carries the sort
 * position (e.g. timestamp + id) of the last item of a page. Cursors are
 * base64url-encoded JSON so they are URL-safe and stable; clients treat them as
 * opaque strings.
 */

export function encodeCursor(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined | null): Record<string, unknown> | null {
  if (!cursor) return null;
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
