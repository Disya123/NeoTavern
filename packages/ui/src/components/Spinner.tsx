import { cx } from '../lib/cx.js';

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      data-component="spinner"
      role="status"
      aria-label={label}
      className={cx('st-spinner', className)}
    />
  );
}
