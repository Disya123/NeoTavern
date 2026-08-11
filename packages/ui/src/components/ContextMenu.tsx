import type { ReactNode } from 'react';
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import { cx } from '../lib/cx.js';

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

export function ContextMenuContent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-component="menu-content"
        className={cx('st-menu', className)}
      >
        {children}
      </ContextMenuPrimitive.Content>
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuItem({
  children,
  onSelect,
  disabled,
  className,
  asChild = false,
}: {
  children: ReactNode;
  onSelect?: (event: Event) => void;
  disabled?: boolean;
  className?: string;
  /** Merge the item semantics into a child element (e.g. a real link). */
  asChild?: boolean;
}) {
  return (
    <ContextMenuPrimitive.Item
      asChild={asChild}
      data-component="menu-item"
      className={cx('st-menu-item', className)}
      onSelect={onSelect}
      disabled={disabled}
    >
      {children}
    </ContextMenuPrimitive.Item>
  );
}

export function ContextMenuSeparator({ className }: { className?: string }) {
  return <ContextMenuPrimitive.Separator data-component="menu-separator" className={className} />;
}
