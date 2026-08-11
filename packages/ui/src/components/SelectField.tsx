import { forwardRef, useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cx } from '../lib/cx.js';

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  /** Supporting copy announced with the control. */
  description?: ReactNode;
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, description, id, className, children, ...props },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const descriptionId = `${selectId}-description`;

  return (
    <div data-component="field" className="st-field">
      <label data-component="field-label" htmlFor={selectId}>
        {label}
      </label>
      <select
        ref={ref}
        id={selectId}
        data-component="select"
        className={cx('st-select', className)}
        aria-describedby={description ? descriptionId : undefined}
        {...props}
      >
        {children}
      </select>
      {description ? (
        <span id={descriptionId} data-component="field-description">
          {description}
        </span>
      ) : null}
    </div>
  );
});
