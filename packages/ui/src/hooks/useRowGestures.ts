/**
 * React wrapper over `createRowGestures` (@neotavern/gestures) for list rows that
 * need a context menu (right-click / long-press) and/or drag-and-drop
 * reordering. The underlying controller is framework-agnostic; this hook only
 * adds React state for `data-dragging` and auto-cleanup on unmount.
 */
import { useEffect, useRef, useState } from 'react';
import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  TouchEvent as ReactTouchEvent,
} from 'react';
import { createRowGestures, type RowGestureOptions } from '@neotavern/gestures';

export interface RowGestureHandlers {
  onMouseDown(event: ReactMouseEvent): void;
  onTouchStart(event: ReactTouchEvent): void;
  onContextMenu(event: ReactMouseEvent): void;
  onDragStart(event: ReactDragEvent): void;
}

export interface UseRowGesturesResult {
  /** Index of the row being dragged (drives `data-dragging`); `null` when idle. */
  draggedIndex: number | null;
  /** Sync the dragged index after applying a preview reorder. */
  setDraggedIndex(index: number | null): void;
  /**
   * Returns `true` when the next click should be suppressed (a drag just
   * finished or a long-press menu just opened) and clears the flag. Call
   * from the row's click handler before performing the default action.
   */
  consumeClick(): boolean;
  /** True while a drag session is active (drives autosave guards etc.). */
  isDragging(): boolean;
  /** React event handlers for a specific row, to spread onto its element. */
  handlers(itemId: string, index: number): RowGestureHandlers;
  /** Remove document listeners and pending timers (also automatic on unmount). */
  destroy(): void;
}

/**
 * Reusable row interactions: right-click / long-press context menu and
 * mouse/touch drag-and-drop reordering. See `RowGestureOptions` in
 * `@neotavern/gestures` for the option contract. `indexAttribute`, the thresholds
 * and `longPressMs` are captured on first render and must stay stable.
 */
export function useRowGestures(options: RowGestureOptions): UseRowGesturesResult {
  // Callbacks are read through a ref so the controller never goes stale.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const [draggedIndex, setDraggedIndexState] = useState<number | null>(null);

  const [controller] = useState(() => {
    const coreOptions: RowGestureOptions = {
      indexAttribute: options.indexAttribute,
      canDrag: (itemId) => optionsRef.current.canDrag?.(itemId) ?? true,
      onDragStart: (itemId, index) => {
        setDraggedIndexState(index);
        optionsRef.current.onDragStart?.(itemId, index);
      },
      onDragMove: (itemId, toIndex, point) => {
        optionsRef.current.onDragMove?.(itemId, toIndex, point);
      },
      onDragEnd: (itemId, committed) => {
        setDraggedIndexState(null);
        optionsRef.current.onDragEnd?.(itemId, committed);
      },
      onOpenMenu: (itemId, at) => {
        optionsRef.current.onOpenMenu?.(itemId, at);
      },
      // Relay only the scalar options the caller actually provided, so the
      // controller's defaults apply when omitted (and `longPressMs: null`
      // reaches it as an explicit "disabled").
      ...(options.mouseDragThresholdPx !== undefined && {
        mouseDragThresholdPx: options.mouseDragThresholdPx,
      }),
      ...(options.touchDragThresholdPx !== undefined && {
        touchDragThresholdPx: options.touchDragThresholdPx,
      }),
      ...(options.longPressMs !== undefined && {
        longPressMs: options.longPressMs,
      }),
    };
    return createRowGestures(coreOptions);
  });

  useEffect(
    () => () => {
      controller.destroy();
    },
    [controller],
  );

  const setDraggedIndex = (index: number | null): void => {
    controller.setDraggedIndex(index);
    setDraggedIndexState(index);
  };

  return {
    draggedIndex,
    setDraggedIndex,
    consumeClick: controller.consumeClick,
    isDragging: controller.isDragging,
    handlers: (itemId, index) => ({
      onMouseDown: (event) => controller.onMouseDown(event.nativeEvent, itemId, index),
      onTouchStart: (event) => controller.onTouchStart(event.nativeEvent, itemId, index),
      onContextMenu: (event) => controller.onContextMenu(event.nativeEvent, itemId),
      onDragStart: (event) => controller.onDragStart(event.nativeEvent),
    }),
    destroy: controller.destroy,
  };
}
