import type { ReactNode, Ref } from 'react';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import { cx } from '../lib/cx.js';
import { useScrollbarHideDelay } from '../lib/useScrollbarHideDelay.js';

export function ScrollArea({
  children,
  className,
  viewportRef,
}: {
  children: ReactNode;
  className?: string;
  /** Radix scroll viewport — attach when the parent needs `scrollTop` / virtualization. */
  viewportRef?: Ref<HTMLDivElement>;
}) {
  const scrollHideDelay = useScrollbarHideDelay();

  return (
    <ScrollAreaPrimitive.Root
      className={cx('st-scroll-root', className)}
      type="scroll"
      scrollHideDelay={scrollHideDelay}
    >
      <ScrollAreaPrimitive.Viewport ref={viewportRef} data-component="scroll-viewport">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        forceMount
        data-component="scroll-scrollbar"
        orientation="vertical"
      >
        <ScrollAreaPrimitive.Thumb forceMount data-component="scroll-thumb" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}
