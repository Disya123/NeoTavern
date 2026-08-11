import type { ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cx } from '../lib/cx.js';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps {
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Custom portal target (e.g. the app's `modal.layer` slot). */
  container?: HTMLElement | null;
  /** Called before focus moves into the open dialog. */
  onOpenAutoFocus?: (event: Event) => void;
  /** Called before Radix restores focus after the dialog closes. */
  onCloseAutoFocus?: (event: Event) => void;
}

export function DialogContent({
  title,
  description,
  children,
  className,
  container,
  onOpenAutoFocus,
  onCloseAutoFocus,
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal container={container}>
      <DialogPrimitive.Overlay data-component="dialog-overlay" />
      <DialogPrimitive.Content
        data-component="dialog-content"
        className={cx('st-dialog', className)}
        onOpenAutoFocus={onOpenAutoFocus}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {title ? (
          <DialogPrimitive.Title data-component="dialog-title">{title}</DialogPrimitive.Title>
        ) : null}
        {description ? (
          <DialogPrimitive.Description data-component="dialog-description">
            {description}
          </DialogPrimitive.Description>
        ) : null}
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
