/**
 * Variant picker for one message: a popover listing every stored swipe
 * variant (positions 0..variantCount-1) plus the active content row, with
 * the active position marked. Fetches lazily — the variants query stays
 * disabled until the popover opens.
 */
import { ListMagnifyingGlass } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Message } from '@neotavern/contracts';
import { useMessageVariants } from '../api/hooks.js';
import styles from './MessageVariantPicker.module.css';

const PREVIEW_MAX_LENGTH = 140;

export function MessageVariantPicker({
  message,
  onPick,
}: {
  message: Message;
  onPick: (position: number) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const variants = useMessageVariants(message.chatId, message.id, open);

  // Close on outside pointer press or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const activePosition = message.activeVariantPosition;
  const stored = variants.data ?? [];
  const contentIndex = stored.findIndex((variant) => variant.content === message.content);
  // Kernel mode messages carry no permutation fields (translateMessage
  // reports 0/null): the active content matches one of the stored variants
  // (after activation) or is a fresh text appended as the last row. Legacy
  // mode keeps the permutation semantics (active text not in the table).
  const rows =
    activePosition !== null
      ? [
          ...stored
            .filter((variant) => variant.position !== activePosition)
            .map((variant) => ({
              id: variant.id,
              position: variant.position,
              content: variant.content,
              active: false,
            })),
          {
            id: `active-${message.id}`,
            position: activePosition,
            content: message.content,
            active: true,
          },
        ].sort((left, right) => left.position - right.position)
      : [
          ...stored.map((variant, index) => ({
            id: variant.id,
            position: variant.position,
            content: variant.content,
            active: index === contentIndex,
          })),
          ...(contentIndex < 0
            ? [
                {
                  id: `active-${message.id}`,
                  position: stored.length,
                  content: message.content,
                  active: true,
                },
              ]
            : []),
        ].sort((left, right) => left.position - right.position);
  const total = activePosition !== null ? message.variantCount : stored.length + 1;

  return (
    <div ref={rootRef} className={styles.root} data-component="message-variant-picker">
      <button
        type="button"
        className={styles.trigger}
        data-action="swipe-picker"
        onClick={() => setOpen((current) => !current)}
        aria-label={t('chat:swipePicker')}
        title={t('chat:swipePicker')}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <ListMagnifyingGlass size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className={styles.popover}
          data-part="swipe-picker-popover"
          role="listbox"
          aria-label={t('chat:swipePicker')}
        >
          {rows.length > 0 ? (
            rows.map((row) => (
              <button
                key={row.id}
                type="button"
                role="option"
                data-action="swipe-pick"
                data-state={row.active ? 'active' : 'idle'}
                aria-selected={row.active}
                onClick={() => {
                  if (!row.active) onPick(row.position);
                  setOpen(false);
                }}
              >
                <span className={styles.index}>
                  {row.position + 1}/{total}
                </span>
                <span className={styles.preview}>
                  {row.content.slice(0, PREVIEW_MAX_LENGTH) || ' '}
                </span>
              </button>
            ))
          ) : (
            <div className={styles.empty} data-part="swipe-picker-empty">
              {variants.isLoading ? t('common:loading') : t('chat:swipePickerEmpty')}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
