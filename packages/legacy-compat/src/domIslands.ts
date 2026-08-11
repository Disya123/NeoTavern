/**
 * Unmanaged DOM islands (AGENTS.md §18 / ТЗ §8.2). React renders an empty
 * container for each island but never manages children a legacy extension
 * appends into it — so old DOM-manipulating extensions keep a stable insertion
 * point.
 */

export const LEGACY_ISLANDS = [
  'legacy.extensions.settings',
  'legacy.chat.actions',
  'legacy.character.actions',
  'legacy.toolbar',
  'legacy.drawer',
  'legacy.modal',
] as const;

export type LegacyIslandName = (typeof LEGACY_ISLANDS)[number];

/** Stable DOM id for an island (dots → dashes). */
export function islandElementId(name: LegacyIslandName): string {
  return name.replaceAll('.', '-');
}
