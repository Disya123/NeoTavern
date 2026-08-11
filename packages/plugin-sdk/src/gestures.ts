/**
 * Framework-agnostic row gestures for plugin UI: right-click / long-press
 * context menu and mouse/touch drag-and-drop reorder recognition. Re-exported
 * from `@neotavern/gestures` with no React or other framework dependency — plugins
 * wire the returned handlers onto their own DOM/React elements.
 *
 * ```ts
 * import { createRowGestures } from '@neotavern/plugin-sdk/gestures';
 *
 * const rowGestures = createRowGestures({
 *   indexAttribute: 'data-tag-index',
 *   onOpenMenu: (tagId, at) => openTagMenu(tagId),
 *   onDragMove: (tagId, to) => previewTagMove(tagId, to),
 *   onDragEnd: () => saveTagOrder(),
 *   canDrag: (tagId) => pinnedTags.has(tagId) === false,
 * });
 *
 * element.addEventListener('mousedown', (event) =>
 *   rowGestures.onMouseDown(event, tag.id, index),
 * );
 * element.addEventListener('touchstart', (event) =>
 *   rowGestures.onTouchStart(event, tag.id, index),
 * );
 * element.addEventListener('contextmenu', (event) =>
 *   rowGestures.onContextMenu(event, tag.id),
 * );
 * // … call rowGestures.destroy() on cleanup.
 * ```
 */
export * from '@neotavern/gestures';
