import type { HTMLAttributes } from 'react';
import { cx } from '../lib/cx.js';

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /** Convenience: fixed block size (size/width via style still wins). */
  width?: string | number;
  height?: string | number;
}

/**
 * Loading placeholder with the shared shimmer animation (DUP-24): pages used
 * to carry five byte-near copies of the keyframes. Duration comes from the
 * motion tokens, so prefers-reduced-motion is respected automatically.
 */
export function Skeleton({ className, width, height, style, ...props }: SkeletonProps) {
  return (
    <div
      data-component="skeleton"
      aria-hidden="true"
      className={cx('st-skeleton', className)}
      style={width !== undefined || height !== undefined ? { width, height, ...style } : style}
      {...props}
    />
  );
}
