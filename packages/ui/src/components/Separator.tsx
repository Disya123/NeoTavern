import * as SeparatorPrimitive from '@radix-ui/react-separator';
import { cx } from '../lib/cx.js';

export function Separator({
  orientation = 'horizontal',
  className,
}: {
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}) {
  return (
    <SeparatorPrimitive.Root
      data-component="separator"
      data-orientation={orientation}
      orientation={orientation}
      decorative
      className={cx('st-separator', className)}
    />
  );
}
