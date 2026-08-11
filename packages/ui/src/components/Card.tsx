import type { HTMLAttributes } from 'react';
import { cx } from '../lib/cx.js';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Standard inner padding. Bare cards (`padded={false}`) compose their own
   * flush layout — list/grid surfaces that used to re-declare the card skin
   * (DUP-24) adopt the base skin via this component or the `st-card` class.
   */
  padded?: boolean;
}

export function Card({ className, padded = true, ...props }: CardProps) {
  return (
    <div
      data-component="card"
      data-padded={padded ? 'true' : undefined}
      className={cx('st-card', className)}
      {...props}
    />
  );
}
