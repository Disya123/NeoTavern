/**
 * Chat background (wallpaper) schemas. A background is a user-managed image
 * file stored under `data/files/backgrounds/`; the filesystem is authoritative
 * and the list endpoint scans the directory, so ST1-imported files appear too.
 * `id` is the stored filename (content hash for uploads, original basename for
 * imports). A chat references a background by that filename.
 */
import { Type, type Static } from '@sinclair/typebox';

export const BackgroundItemSchema = Type.Object({
  /** Stored filename — the stable reference used by `chats.backgroundId`. */
  id: Type.String({ minLength: 1, maxLength: 255 }),
  /** Display name (same as `id`; kept for future renaming). */
  name: Type.String({ minLength: 1, maxLength: 255 }),
  originalUrl: Type.String(),
  thumbnailUrl: Type.String(),
  sizeBytes: Type.Integer({ minimum: 0 }),
  /** File modification time in epoch milliseconds. */
  createdAt: Type.Integer({ minimum: 0 }),
});
export type BackgroundItem = Static<typeof BackgroundItemSchema>;

export const BackgroundListSchema = Type.Object({
  items: Type.Array(BackgroundItemSchema),
});
export type BackgroundList = Static<typeof BackgroundListSchema>;
