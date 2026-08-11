import { useMemo } from 'react';
import { Button } from './Button.js';
import { Combobox, type ComboboxOption } from './Combobox.js';

/** A selectable model entry fed to {@link ModelMenu}. */
export interface ModelMenuOption {
  /** Stable model id committed via {@link ModelMenuProps.onValueChange}. */
  value: string;
  /** Human-readable model name shown in the list and matched by search. */
  label: string;
  /** Context window in tokens, appended to the option label when present. */
  contextLimit?: number;
}

export interface ModelMenuProps {
  /** Models to pick from (the parent owns loading and discovery state). */
  options: readonly ModelMenuOption[];
  /** Currently committed model id (a free-text id is allowed and echoed as-is). */
  value: string;
  /** Fires when the user picks a model or commits typed text (Enter / blur). */
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  /** Present → render a "Load models" button that triggers discovery. */
  onLoadModels?: () => void;
  /** Disables the input and the load button while discovery is in flight. */
  loading?: boolean;
  /** Label of the load button (default `Load models`). */
  loadLabel?: string;
  /** Status line rendered under the control. */
  hint?: string;
  hintTone?: 'default' | 'error';
  /** Shown when `options` is empty (e.g. models not discovered yet). */
  emptyText?: string;
  /** Shown when the search filter matches nothing. */
  noResultsText?: string;
}

function optionLabel(option: ModelMenuOption): string {
  return option.contextLimit != null
    ? `${option.label} (${option.contextLimit.toLocaleString()})`
    : option.label;
}

/**
 * Reusable model picker: a searchable combobox (free text or a pick from a
 * loaded list) with an optional "Load models" discovery action and a status
 * line. Used by the provider editors and mirrored by the plugin-sandbox
 * `api.ui.modelMenu` widget (same interaction contract, vanilla implementation
 * inside the opaque iframe — see docs/plugin-sdk/rev4-api.md).
 */
export function ModelMenu({
  options,
  value,
  onValueChange,
  placeholder,
  disabled = false,
  id,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  onLoadModels,
  loading = false,
  loadLabel = 'Load models',
  hint,
  hintTone = 'default',
  emptyText,
  noResultsText,
}: ModelMenuProps) {
  const comboboxOptions = useMemo<readonly ComboboxOption[]>(
    () => options.map((option) => ({ value: option.value, label: optionLabel(option) })),
    [options],
  );

  return (
    <div data-component="model-menu">
      <div data-part="control-row">
        <Combobox
          options={comboboxOptions}
          value={value}
          onValueChange={onValueChange}
          placeholder={placeholder}
          disabled={disabled || loading}
          id={id}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          emptyText={emptyText}
          noResultsText={noResultsText}
        />
        {onLoadModels !== undefined ? (
          <Button size="sm" disabled={disabled || loading} onClick={onLoadModels}>
            {loadLabel}
          </Button>
        ) : null}
      </div>
      {hint ? (
        <small data-part="status" data-tone={hintTone}>
          {hint}
        </small>
      ) : null}
    </div>
  );
}
