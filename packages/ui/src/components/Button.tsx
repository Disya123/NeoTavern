import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cx } from '../lib/cx.js';

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Decorative icon rendered before the accessible button label. */
  startIcon?: ReactNode;
  /** Decorative icon rendered after the accessible button label. */
  endIcon?: ReactNode;
  /** Render the child element instead of a <button> (keeps styling). */
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'default',
    size = 'md',
    startIcon,
    endIcon,
    asChild = false,
    className,
    type = 'button',
    children,
    ...props
  },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  const hasStructuredContent = !asChild && (startIcon !== undefined || endIcon !== undefined);
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : type}
      data-component="button"
      data-variant={variant}
      data-size={size}
      data-has-icon={
        hasStructuredContent && startIcon !== undefined && endIcon !== undefined
          ? 'both'
          : hasStructuredContent && startIcon !== undefined
            ? 'start'
            : hasStructuredContent && endIcon !== undefined
              ? 'end'
              : undefined
      }
      className={cx('st-button', className)}
      {...props}
    >
      {hasStructuredContent ? (
        <>
          {startIcon !== undefined ? (
            <span data-part="icon" data-position="start" aria-hidden="true">
              {startIcon}
            </span>
          ) : null}
          <span data-part="label">{children}</span>
          {endIcon !== undefined ? (
            <span data-part="icon" data-position="end" aria-hidden="true">
              {endIcon}
            </span>
          ) : null}
        </>
      ) : (
        children
      )}
    </Comp>
  );
});

export interface IconButtonProps extends ButtonProps {
  'aria-label': string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'ghost', className, ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      variant={variant}
      data-icon=""
      className={cx('st-icon-button', className)}
      {...props}
    />
  );
});
