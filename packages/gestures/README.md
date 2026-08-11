# @neotavern/gestures

Framework-agnostic gesture recognition for list rows: context menu on right
click, context menu on stationary long-press, and drag-and-drop reordering
with mouse/touch. The package works with native DOM events and callbacks,
imports nothing at runtime and does not depend on React.

One controller covers three different profiles:

- **Chats panel** — whole-row drag with 4/10 px thresholds and 700 ms long-press;
- **Prompt template editor** — instant drag (0 threshold) by the dedicated
  handle, long-press disabled;
- **Backgrounds panel** — context menu only (drag disabled via
  `canDrag: () => false`), 700 ms long-press.

## Public API

- `createRowGestures(options): RowGestureController` — the gesture controller.
- `RowGestureOptions` — options:

  | Option                               | Default       | Description                                                            |
  | ------------------------------------ | ------------- | ---------------------------------------------------------------------- |
  | `indexAttribute`                     | —             | row attribute holding its index, e.g. `data-chat-index` (required)     |
  | `mouseDragThresholdPx`               | `4`           | mouse movement (px) before drag activates; `0` — instantly on mousedown |
  | `touchDragThresholdPx`               | `10`          | finger movement (px) before drag activates; `0` — instantly on touchstart |
  | `longPressMs`                        | `700`         | hold (ms) before the menu opens; `null` disables long-press            |
  | `canDrag(itemId)`                    | always true   | `false` disables drag for the item (the menu still works)              |
  | `onDragStart(itemId, index)`         | —             | drag session started (close open menus)                                |
  | `onDragMove(itemId, toIndex, point)` | —             | cursor over row `toIndex` — apply optimistic reorder                   |
  | `onDragEnd(itemId, committed)`       | —             | drag finished; `committed=false` — no movement happened                |
  | `onOpenMenu(itemId, at)`             | —             | open the row context menu (right click or long-press)                  |

- `RowGestureController`:
  - `onMouseDown(event, itemId, index)` / `onTouchStart(event, itemId, index)`
    — attach to the row or handle (synthetic React events are wrapped via
    `useRowGestures` from `@neotavern/ui`);
  - `onContextMenu(event, itemId)` — calls `preventDefault` internally;
  - `onDragStart(event)` — suppress native dragging of links/images;
  - `consumeClick(): boolean` — true if the next click must be suppressed
    (a drag just ended or a long-press menu opened); the flag is reset by the
    call;
  - `getDraggedIndex()` / `setDraggedIndex(index)` / `isDragging()`;
  - `destroy()` — remove document listeners and timers (idempotent).

## Behavior

- Hit-testing in `onDragMove` — via `closest([indexAttribute])` from the
  element under the cursor with a fallback to `document.elementFromPoint`; the
  attribute value is parsed as an integer index.
- Long-press is cancelled by finger movement beyond `touchDragThresholdPx`;
  the same movement activates drag if `canDrag` permits it.
- The context menu opens for items with `canDrag=false` too.
- Click suppression: after a completed drag and after a long-press
  `consumeClick()` returns true (reset via a macrotask).
- The controller attaches document listeners for `mousemove/mouseup` and
  `touchmove/touchend/touchcancel` itself; `destroy()` is required on unmount.

## Dependencies

None (runtime). `devDependencies`: `typescript` (catalog).

## Commands

```bash
pnpm --filter @neotavern/gestures typecheck
pnpm --filter @neotavern/gestures build
```

## Constraints

- Configuration is captured at controller creation and must stay stable
  (`indexAttribute`, thresholds, `longPressMs`). Callbacks can be swapped via
  the ref pattern (as `useRowGestures` does).
- The package knows nothing about i18n, themes or virtualization; rendering
  and animations are up to the consumer.
