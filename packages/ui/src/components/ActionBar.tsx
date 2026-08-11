import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { cx } from '../lib/cx.js';

export type ActionBarAlignment = 'start' | 'end' | 'split';
export type ActionBarCollapse = 'wrap' | 'compact' | 'stack' | 'scroll';
export type ActionBarGroupPlacement = 'primary' | 'secondary';

export interface ActionBarProps extends HTMLAttributes<HTMLDivElement> {
  /** Alignment used while the action bar has enough inline space. */
  align?: ActionBarAlignment;
  /** Reflow strategy used when the action bar's own container becomes narrow. */
  collapse?: ActionBarCollapse;
  children: ReactNode;
}

/**
 * Themeable, self-responsive host for related actions and controls.
 * Layout is exposed through stable data hooks; compact toolbars compare their
 * natural content width with their own available inline size, never viewport.
 */
export function ActionBar({
  align = 'start',
  collapse = 'wrap',
  className,
  children,
  ...props
}: ActionBarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const inner = innerRef.current;
    if (!root || !inner) return;
    if (collapse !== 'compact') {
      setCompact(false);
      return;
    }

    let disposed = false;
    const measure = (): void => {
      if (disposed) return;
      const wasCompact = root.dataset['compact'] === 'true';
      root.dataset['compact'] = 'false';

      const groups = Array.from(inner.children).filter(
        (element): element is HTMLElement => element instanceof HTMLElement,
      );
      const gap = Number.parseFloat(getComputedStyle(inner).columnGap) || 0;
      const naturalWidth =
        groups.reduce(
          (width, group) =>
            width + Math.max(group.scrollWidth, group.getBoundingClientRect().width),
          0,
        ) +
        Math.max(0, groups.length - 1) * gap;
      const availableWidth = root.clientWidth;
      const hysteresis =
        Number.parseFloat(getComputedStyle(root).getPropertyValue('--st-space-sm')) || 0;
      const nextCompact = wasCompact
        ? availableWidth < naturalWidth + hysteresis
        : availableWidth < naturalWidth;

      root.dataset['compact'] = String(nextCompact);
      setCompact((current) => (current === nextCompact ? current : nextCompact));
    };

    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(root);
    void document.fonts?.ready.then(measure);
    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, [children, collapse]);

  return (
    <div
      {...props}
      ref={rootRef}
      data-component="action-bar"
      data-align={align}
      data-collapse={collapse}
      data-compact={collapse === 'compact' ? String(compact) : undefined}
      className={cx('st-action-bar', className)}
    >
      <div ref={innerRef} data-part="inner">
        {children}
      </div>
    </div>
  );
}

export interface ActionBarGroupProps extends HTMLAttributes<HTMLDivElement> {
  /** Semantic placement used by themes without depending on DOM order. */
  placement?: ActionBarGroupPlacement;
  children: ReactNode;
}

/** A stable primary or secondary slot inside an {@link ActionBar}. */
export function ActionBarGroup({
  placement = 'primary',
  className,
  children,
  ...props
}: ActionBarGroupProps) {
  return (
    <div
      {...props}
      data-part="group"
      data-role={placement}
      className={cx('st-action-bar-group', className)}
    >
      {children}
    </div>
  );
}
