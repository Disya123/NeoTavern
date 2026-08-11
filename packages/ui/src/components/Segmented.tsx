export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  value: T;
  options: readonly SegmentedOption<T>[];
  /** Accessible name for the option group (e.g. the setting it controls). */
  ariaLabel: string;
  onChange: (value: T) => void;
}

export function Segmented<T extends string>({
  value,
  options,
  ariaLabel,
  onChange,
}: SegmentedProps<T>) {
  return (
    <div data-component="segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          data-state={value === option.value ? 'active' : 'inactive'}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
