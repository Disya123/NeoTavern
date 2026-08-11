import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from '../lib/cx.js';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  /** Supporting copy announced with the control. */
  description?: ReactNode;
  /** Validation or submission error announced with the control. */
  error?: ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  {
    label,
    description,
    error,
    className,
    id,
    'aria-describedby': describedBy,
    'aria-invalid': invalid,
    ...props
  },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const descriptionId = `${inputId}-description`;
  const errorId = `${inputId}-error`;
  const accessibleDescription =
    [describedBy, description ? descriptionId : undefined, error ? errorId : undefined]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div data-component="field" className="st-field">
      {label ? (
        <label data-component="field-label" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <input
        ref={ref}
        id={inputId}
        data-component="input"
        className={cx('st-input', className)}
        aria-describedby={accessibleDescription}
        aria-invalid={error ? true : invalid}
        {...props}
      />
      {description ? (
        <span id={descriptionId} data-component="field-description">
          {description}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} data-component="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
});

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  /** Supporting copy announced with the control. */
  description?: ReactNode;
  /** Validation or submission error announced with the control. */
  error?: ReactNode;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  {
    label,
    description,
    error,
    className,
    id,
    'aria-describedby': describedBy,
    'aria-invalid': invalid,
    ...props
  },
  ref,
) {
  const autoId = useId();
  const areaId = id ?? autoId;
  const descriptionId = `${areaId}-description`;
  const errorId = `${areaId}-error`;
  const accessibleDescription =
    [describedBy, description ? descriptionId : undefined, error ? errorId : undefined]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div data-component="field" className="st-field">
      {label ? (
        <label data-component="field-label" htmlFor={areaId}>
          {label}
        </label>
      ) : null}
      <textarea
        ref={ref}
        id={areaId}
        data-component="textarea"
        className={cx('st-textarea', className)}
        aria-describedby={accessibleDescription}
        aria-invalid={error ? true : invalid}
        {...props}
      />
      {description ? (
        <span id={descriptionId} data-component="field-description">
          {description}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} data-component="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
});
