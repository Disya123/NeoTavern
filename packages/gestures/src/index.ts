/**
 * @neotavern/gestures — framework-agnostic row gesture recognition.
 *
 * Recognizes the pointer interactions shared by reorderable list rows across
 * the app: a context menu on right-click, a context menu on a stationary
 * touch hold (long-press), and mouse/touch drag-and-drop reordering.
 * Activation thresholds, the long-press delay and per-item drag permission
 * are configurable, so the same controller powers the chat manager
 * (whole-row drag with thresholds), the prompt template editor (immediate
 * drag from a handle) and the backgrounds panel (context menu only).
 *
 * The package is deliberately framework-agnostic: it deals in native DOM
 * events and plain callbacks and imports nothing at runtime. React components
 * wrap it through `useRowGestures` from `@neotavern/ui`; plugins can use it directly
 * via `@neotavern/plugin-sdk/gestures`.
 */

export interface DragPoint {
  /** Client X of the initiating or current pointer position. */
  readonly x: number;
  /** Client Y of the initiating or current pointer position. */
  readonly y: number;
}

export interface RowGestureOptions {
  /**
   * Attribute that marks a row as a drag target and carries its index,
   * e.g. `data-chat-index`. Its value is parsed as the target index for
   * `onDragMove`. Must stay stable for the lifetime of the controller.
   */
  readonly indexAttribute: string;
  /**
   * Pointer travel (px) before a mouse drag activates. Default 4.
   * `0` activates immediately on the left mousedown.
   */
  readonly mouseDragThresholdPx?: number;
  /**
   * Pointer travel (px) before a touch drag activates. Default 10.
   * `0` activates immediately on touchstart.
   */
  readonly touchDragThresholdPx?: number;
  /**
   * Stationary touch hold (ms) after which the context menu opens.
   * Default 700. Pass `null` to disable long-press.
   */
  readonly longPressMs?: number | null;
  /**
   * Return `false` to refuse dragging for the given item. The context menu
   * still opens for it. Default: every item is draggable.
   */
  readonly canDrag?: (itemId: string) => boolean;
  /** A drag session started. Close any open menus here. */
  readonly onDragStart?: (itemId: string, index: number) => void;
  /**
   * Pointer moved during an active drag. `toIndex` is the parsed
   * `indexAttribute` of the row under the pointer. Apply the optimistic
   * reorder here and sync {@link RowGestureController.setDraggedIndex} when
   * the dragged row changed position.
   */
  readonly onDragMove?: (itemId: string, toIndex: number, point: DragPoint) => void;
  /**
   * The drag session ended. `committed` is `false` when the session ended
   * without any move (e.g. an immediate-activation drag released in place),
   * so consumers can skip persisting an unchanged order.
   */
  readonly onDragEnd?: (itemId: string, committed: boolean) => void;
  /** The row's context menu should open (right-click or long-press). */
  readonly onOpenMenu?: (itemId: string, at: DragPoint) => void;
}

export interface RowGestureController {
  /** Row/handle `mousedown`; only the left button starts a drag. */
  onMouseDown(event: MouseEvent, itemId: string, index: number): void;
  /** Row/handle `touchstart`. */
  onTouchStart(event: TouchEvent, itemId: string, index: number): void;
  /** Row `contextmenu`; `preventDefault` is handled inside. */
  onContextMenu(event: MouseEvent, itemId: string): void;
  /** Row `dragstart`; disables the native drag-and-drop of links/images. */
  onDragStart(event: DragEvent): void;
  /**
   * Returns `true` when the next click should be suppressed (a drag just
   * finished or a long-press menu just opened) and clears the flag. Call
   * from the row's click handler before performing the default action.
   */
  consumeClick(): boolean;
  /** Index of the dragged row, or `null` when no drag is active. */
  getDraggedIndex(): number | null;
  /** Sync the dragged index after the consumer applied a preview reorder. */
  setDraggedIndex(index: number | null): void;
  /** True while a drag session is active (drives autosave guards etc.). */
  isDragging(): boolean;
  /** Remove document listeners and pending timers. Idempotent. */
  destroy(): void;
}

const DEFAULT_MOUSE_DRAG_THRESHOLD_PX = 4;
const DEFAULT_TOUCH_DRAG_THRESHOLD_PX = 10;
const DEFAULT_LONG_PRESS_MS = 700;

interface ActiveSession {
  readonly itemId: string;
  index: number;
  moved: boolean;
}

export function createRowGestures(options: RowGestureOptions): RowGestureController {
  const indexAttribute = options.indexAttribute;
  const mouseThreshold = options.mouseDragThresholdPx ?? DEFAULT_MOUSE_DRAG_THRESHOLD_PX;
  const touchThreshold = options.touchDragThresholdPx ?? DEFAULT_TOUCH_DRAG_THRESHOLD_PX;
  // Long-press is disabled with `null`; the default applies when the option
  // is absent, so the React hook can just relay explicit `null`s.
  const longPressMs = 'longPressMs' in options ? options.longPressMs : DEFAULT_LONG_PRESS_MS;
  const longPressEnabled = longPressMs !== null && longPressMs !== undefined && longPressMs > 0;
  const canDrag = options.canDrag ?? ((): boolean => true);

  let session: ActiveSession | null = null;
  let suppressClick = false;
  let removeListeners: (() => void) | null = null;
  let longPressTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const clearLongPressTimer = (): void => {
    if (longPressTimer !== null) {
      globalThis.clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };

  const beginDragging = (itemId: string, index: number): void => {
    session = { itemId, index, moved: false };
    options.onDragStart?.(itemId, index);
  };

  const stopCurrentDrag = (): void => {
    removeListeners?.();
    removeListeners = null;
    clearLongPressTimer();
  };

  const finishDragging = (): void => {
    removeListeners?.();
    removeListeners = null;
    const finished = session;
    session = null;
    if (!finished) return;
    suppressClick = true;
    globalThis.setTimeout(() => {
      suppressClick = false;
    }, 0);
    options.onDragEnd?.(finished.itemId, finished.moved);
  };

  const resolveRowIndex = (point: DragPoint, eventTarget: EventTarget | null): number | null => {
    const element =
      eventTarget instanceof Element
        ? eventTarget
        : typeof document.elementFromPoint === 'function'
          ? document.elementFromPoint(point.x, point.y)
          : null;
    const row = element?.closest<HTMLElement>(`[${indexAttribute}]`) ?? null;
    const value = Number(row?.getAttribute(indexAttribute));
    return Number.isInteger(value) ? value : null;
  };

  const previewAt = (point: DragPoint, eventTarget: EventTarget | null): void => {
    const current = session;
    if (!current) return;
    const toIndex = resolveRowIndex(point, eventTarget);
    if (toIndex === null) return;
    current.moved = true;
    options.onDragMove?.(current.itemId, toIndex, point);
  };

  const startMouseDragging = (event: MouseEvent, itemId: string, index: number): void => {
    if (event.button !== 0 || !canDrag(itemId)) return;
    stopCurrentDrag();
    const startX = event.clientX;
    const startY = event.clientY;
    let active = mouseThreshold === 0;
    if (active) {
      event.preventDefault();
      beginDragging(itemId, index);
    }
    const onMouseMove = (nativeEvent: MouseEvent): void => {
      if (
        !active &&
        Math.hypot(nativeEvent.clientX - startX, nativeEvent.clientY - startY) < mouseThreshold
      ) {
        return;
      }
      if (!active) {
        active = true;
        beginDragging(itemId, index);
      }
      nativeEvent.preventDefault();
      previewAt({ x: nativeEvent.clientX, y: nativeEvent.clientY }, nativeEvent.target);
    };
    const onMouseUp = (): void => {
      if (active) finishDragging();
      else {
        removeListeners?.();
        removeListeners = null;
      }
    };
    removeListeners = (): void => {
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('mouseup', onMouseUp, true);
    };
    document.addEventListener('mousemove', onMouseMove, { capture: true });
    document.addEventListener('mouseup', onMouseUp, { capture: true, once: true });
  };

  const startTouchDragging = (event: TouchEvent, itemId: string, index: number): void => {
    const touch = event.changedTouches[0];
    if (!touch) return;
    stopCurrentDrag();
    const startX = touch.clientX;
    const startY = touch.clientY;
    const touchId = touch.identifier;
    const draggable = canDrag(itemId);
    let active = touchThreshold === 0 && draggable;
    let longPressOpened = false;

    if (active) {
      event.preventDefault();
      beginDragging(itemId, index);
    } else if (touchThreshold > 0 && longPressEnabled) {
      // A stationary hold opens the context menu; movement cancels it (and
      // starts a drag when the item is draggable).
      longPressTimer = globalThis.setTimeout(() => {
        longPressTimer = null;
        longPressOpened = true;
        suppressClick = true;
        options.onOpenMenu?.(itemId, { x: startX, y: startY });
      }, options.longPressMs ?? DEFAULT_LONG_PRESS_MS);
    }

    const onTouchMove = (nativeEvent: TouchEvent): void => {
      if (longPressOpened) return;
      const current = Array.from(nativeEvent.touches).find(
        (candidate) => candidate.identifier === touchId,
      );
      if (!current) return;
      if (active) {
        nativeEvent.preventDefault();
        previewAt({ x: current.clientX, y: current.clientY }, nativeEvent.target);
        return;
      }
      if (Math.hypot(current.clientX - startX, current.clientY - startY) < touchThreshold) {
        return;
      }
      clearLongPressTimer();
      if (!draggable) return; // scrolling intent: just cancel the menu
      active = true;
      beginDragging(itemId, index);
      nativeEvent.preventDefault();
      previewAt({ x: current.clientX, y: current.clientY }, nativeEvent.target);
    };

    const onTouchEnd = (nativeEvent: TouchEvent): void => {
      if (
        !Array.from(nativeEvent.changedTouches).some(
          (candidate) => candidate.identifier === touchId,
        )
      ) {
        return;
      }
      if (active) {
        finishDragging();
      } else {
        stopCurrentDrag();
        if (longPressOpened) {
          globalThis.setTimeout(() => {
            suppressClick = false;
          }, 0);
        }
      }
    };

    removeListeners = (): void => {
      document.removeEventListener('touchmove', onTouchMove, true);
      document.removeEventListener('touchend', onTouchEnd, true);
      document.removeEventListener('touchcancel', onTouchEnd, true);
    };
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    document.addEventListener('touchend', onTouchEnd, { capture: true });
    document.addEventListener('touchcancel', onTouchEnd, { capture: true });
  };

  return {
    onMouseDown: startMouseDragging,
    onTouchStart: startTouchDragging,
    onContextMenu: (event: MouseEvent, itemId: string): void => {
      event.preventDefault();
      options.onOpenMenu?.(itemId, { x: event.clientX, y: event.clientY });
    },
    onDragStart: (event: DragEvent): void => {
      event.preventDefault();
    },
    consumeClick: (): boolean => {
      const suppressed = suppressClick;
      suppressClick = false;
      return suppressed;
    },
    getDraggedIndex: (): number | null => session?.index ?? null,
    setDraggedIndex: (index: number | null): void => {
      if (session !== null && index !== null) session.index = index;
    },
    isDragging: (): boolean => session !== null,
    destroy: (): void => {
      stopCurrentDrag();
      session = null;
      suppressClick = false;
    },
  };
}
