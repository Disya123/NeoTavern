import type { ReactNode } from 'react';
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import { cx } from '../lib/cx.js';

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;

export function DropdownMenuContent({
  children,
  className,
  align = 'start',
}: {
  children: ReactNode;
  className?: string;
  align?: 'start' | 'center' | 'end';
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        data-component="menu-content"
        className={cx('st-menu', className)}
        sideOffset={6}
        align={align}
      >
        {children}
      </MenuPrimitive.Content>
    </MenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  children,
  onSelect,
  disabled,
  className,
  asChild = false,
}: {
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  className?: string;
  /** Merge the item semantics into a child element (e.g. a real link). */
  asChild?: boolean;
}) {
  return (
    <MenuPrimitive.Item
      asChild={asChild}
      data-component="menu-item"
      className={cx('st-menu-item', className)}
      onSelect={onSelect}
      disabled={disabled}
    >
      {children}
    </MenuPrimitive.Item>
  );
}

export function DropdownMenuSeparator({ className }: { className?: string }) {
  return <MenuPrimitive.Separator data-component="menu-separator" className={className} />;
}
