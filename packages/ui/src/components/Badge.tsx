import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../lib/cx.js';

export type BadgeTone = 'default' | 'accent' | 'success' | 'danger';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Decorative leading icon. */
  icon?: ReactNode;
}

export function Badge({ tone = 'default', icon, children, className, ...props }: BadgeProps) {
  return (
    <span
      data-component="badge"
      data-tone={tone}
      data-has-icon={icon ? '' : undefined}
      className={cx('st-badge', className)}
      {...props}
    >
      {icon ? (
        <span data-part="icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}
