import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import * as Popover from '@radix-ui/react-popover';
import { cx } from '../lib/cx.js';

/** A single selectable entry in a {@link Combobox}. */
export interface ComboboxOption {
  /** Stable value committed via {@link ComboboxProps.onValueChange}. */
  value: string;
  /** Human-readable text shown in the list and matched by the search filter. */
  label: string;
}

export interface ComboboxProps {
  /** Available options (the parent owns loading/filtering source data). */
  options: readonly ComboboxOption[];
  /** Currently committed value (a free-text value is allowed and echoed as-is). */
  value: string;
  /** Fires when the user picks an option or commits typed text (Enter / blur). */
  onValueChange: (value: string) => void;
  placeholder?: string;
  /** Shown when `options` is empty (e.g. models not loaded yet). */
  emptyText?: string;
  /** Shown when the search filter matches nothing. */
  noResultsText?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

function optionMatches(option: ComboboxOption, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  return option.label.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle);
}

/**
 * Accessible, searchable single-select combobox (WAI-ARIA `combobox` + `listbox`),
 * used wherever SillyTavern shows a "pick from a loaded list, or type your own"
 * control — primarily the model picker fed by `/v1/models`.
 *
 * Built on Radix Popover for the floating panel, outside-click dismissal and
 * Escape handling; the combobox semantics and keyboard navigation (Arrow keys,
 * Enter, Home/End) are implemented here because Radix ships no combobox
 * primitive. The single input is both the value field and the search box, so the
 * list can be filtered without a second control. Styled purely through tokens
 * and stable `data-component`/`data-part`/`data-state` hooks (ТЗ §6.4).
 */
export function Combobox({
  options,
  value,
  onValueChange,
  placeholder,
  emptyText,
  noResultsText,
  disabled = false,
  id,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: ComboboxProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const listboxId = `${inputId}-listbox`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set on an option's pointerdown so the input's blur handler does not commit
  // before the option's click selects it.
  const openOnPointerDownRef = useRef(false);
  // When a close returns focus to the input, Radix fires our onFocus which would
  // immediately reopen the list. This flag suppresses that one bounce.
  const suppressOpenRef = useRef(false);

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );
  const filtered = useMemo(
    () => options.filter((option) => optionMatches(option, query)),
    [options, query],
  );

  // When closed, the input mirrors the committed value (label if known).
  const inputValue = open ? query : (selected?.label ?? value);

  /**
   * Open the list, optionally seeding the search box with the committed value
   * (a raw model id or preset name) so the user can edit it directly — for
   * label/value pairs like the model picker, editing the label would corrupt
   * the committed id. Opening is the only thing we drive directly; closing is
   * left to Radix (Escape / outside-click) except for an inside-click
   * selection, where Radix does not dismiss on its own.
   */
  const requestOpen = useCallback(
    (seedQuery: string) => {
      if (disabled) return;
      setQuery(seedQuery);
      setActiveIndex(0);
      setOpen(true);
    },
    [disabled],
  );

  const commit = useCallback(
    (next: string) => {
      onValueChange(next);
      suppressOpenRef.current = true;
      setOpen(false);
    },
    [onValueChange],
  );

  const selectActive = useCallback(() => {
    const option = filtered[activeIndex];
    if (option) {
      onValueChange(option.value);
      suppressOpenRef.current = true;
      setOpen(false);
    }
  }, [filtered, activeIndex, onValueChange]);

  // Keep the highlight within bounds as the filtered list shrinks/grows.
  useEffect(() => {
    if (activeIndex > filtered.length - 1) {
      setActiveIndex(Math.max(filtered.length - 1, 0));
    }
  }, [filtered.length, activeIndex]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') {
        requestOpen('');
        event.preventDefault();
      }
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 1, 0));
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(Math.max(filtered.length - 1, 0));
        break;
      case 'Enter':
        event.preventDefault();
        if (filtered[activeIndex]) selectActive();
        else commit(query);
        break;
      // Escape is handled by Radix (DismissableLayer) via onOpenChange.
    }
  };

  const activeDescendant =
    open && filtered[activeIndex] ? `${inputId}-option-${activeIndex}` : undefined;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (disabled) return;
        if (!next && openOnPointerDownRef.current) return;
        if (!next) suppressOpenRef.current = true;
        setOpen(next);
      }}
    >
      <Popover.Anchor asChild>
        <input
          ref={inputRef}
          id={inputId}
          data-component="combobox-input"
          className={cx('st-combobox-input', className)}
          role="combobox"
          type="text"
          value={inputValue}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={activeDescendant}
          onFocus={() => {
            if (suppressOpenRef.current) {
              suppressOpenRef.current = false;
              return;
            }
            requestOpen(value);
          }}
          onClick={() => {
            if (!open) requestOpen(value);
          }}
          onChange={(event) => {
            const text = event.target.value;
            setQuery(text);
            setActiveIndex(0);
            if (!open) requestOpen(text);
          }}
          onBlur={() => {
            if (openOnPointerDownRef.current) return;
            // Commit whatever is typed (free-text allowed); revert to the known
            // label when the field is emptied without a real change.
            const typed = query.trim();
            onValueChange(typed.length > 0 ? typed : (selected?.value ?? value));
          }}
          onKeyDown={onKeyDown}
        />
      </Popover.Anchor>

      <Popover.Portal>
        <Popover.Content
          data-component="combobox-content"
          className="st-combobox-content"
          sideOffset={4}
          align="start"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
          // The combobox's own input is the popover anchor; without a
          // Popover.Trigger, Radix would treat a focus/pointerdown on it as an
          // outside interaction and dismiss the list right after opening.
          // Keep it open while the anchor (or anything inside it) is the target.
          onInteractOutside={(event) => {
            const target = event.target;
            if (target instanceof Node && inputRef.current?.contains(target)) {
              event.preventDefault();
            }
          }}
        >
          <div
            id={listboxId}
            data-component="combobox-listbox"
            data-part="listbox"
            role="listbox"
            aria-label={ariaLabel}
          >
            {options.length === 0 ? (
              <div data-component="combobox-empty" data-part="empty" role="presentation">
                {emptyText}
              </div>
            ) : filtered.length === 0 ? (
              <div data-component="combobox-empty" data-part="no-results" role="presentation">
                {noResultsText}
              </div>
            ) : (
              filtered.map((option, index) => {
                const isActive = index === activeIndex;
                const isSelected = option.value === value;
                return (
                  <div
                    key={option.value}
                    id={`${inputId}-option-${index}`}
                    data-component="combobox-option"
                    data-part="option"
                    data-state={isSelected ? 'selected' : 'idle'}
                    data-highlighted={isActive ? '' : undefined}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseDown={(event) => {
                      // Keep the input focused; selection happens on click.
                      event.preventDefault();
                      openOnPointerDownRef.current = true;
                    }}
                    onClick={() => {
                      onValueChange(option.value);
                      openOnPointerDownRef.current = false;
                      suppressOpenRef.current = true;
                      setOpen(false);
                    }}
                  >
                    {option.label}
                  </div>
                );
              })
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
