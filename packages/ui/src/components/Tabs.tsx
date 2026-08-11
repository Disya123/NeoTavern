import { useState, type CSSProperties, type ReactNode } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { ScrollArea } from './ScrollArea.js';
import { cx } from '../lib/cx.js';

export interface TabDefinition {
  value: string;
  label: ReactNode;
  content: ReactNode;
  /** Rendered as a disabled trigger (unselectable, but still focusable). */
  disabled?: boolean;
  /** Native title tooltip on the trigger. */
  title?: string;
}

export type TabsVariant = 'underline' | 'segment' | 'chip';
export type TabsLayout = 'content' | 'equal';
export type TabsOverflow = 'wrap' | 'scroll';
export type TabsScrollMode = 'content' | 'root';

export interface TabsProps {
  tabs: TabDefinition[];
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  /** Extra class for the content region (layout overrides like scrolling). */
  contentClassName?: string;
  /** Overlay scrollbar via Radix ScrollArea (visible, does not consume layout width). */
  scrollable?: boolean;
  /** Put the list and active content in one ScrollArea when set to `root`. */
  scrollMode?: TabsScrollMode;
  /** Visual style: underline (default) or a boxed segmented control. */
  variant?: TabsVariant;
  /** Trigger sizing strategy. `equal` gives each trigger the same track width
   *  (underline variant). `segment` always uses equal tracks regardless. */
  layout?: TabsLayout;
  /** Reflow strategy used when translated labels exceed the tab-list width. */
  overflow?: TabsOverflow;
  ariaLabel?: string;
}

function getActiveIndex(tabs: TabDefinition[], activeValue: string): number {
  const index = tabs.findIndex((tab) => tab.value === activeValue);
  return index >= 0 ? index : 0;
}

function segmentListStyle(tabCount: number): CSSProperties {
  return {
    '--tabs-segment-count': tabCount,
  } as CSSProperties;
}

function segmentIndicatorStyle(activeIndex: number): CSSProperties {
  return {
    transform: `translateX(calc(${activeIndex} * 100%))`,
  };
}

/** Accessible tabs built on Radix, styled via data hooks. */
export function Tabs({
  tabs,
  defaultValue,
  value,
  onValueChange,
  className,
  contentClassName,
  scrollable = false,
  scrollMode = 'content',
  variant = 'underline',
  layout = 'content',
  overflow = 'wrap',
  ariaLabel = 'Tabs',
}: TabsProps) {
  const initial = defaultValue ?? tabs[0]?.value ?? '';
  const isControlled = value !== undefined;
  const [uncontrolledValue, setUncontrolledValue] = useState(initial);
  const activeValue = isControlled ? value : uncontrolledValue;
  const isSegment = variant === 'segment';
  const activeIndex = getActiveIndex(tabs, activeValue);

  const handleValueChange = (next: string): void => {
    if (!isControlled) {
      setUncontrolledValue(next);
    }
    onValueChange?.(next);
  };

  const tabList = (
    <TabsPrimitive.List
      data-component="tabs-list"
      data-part="list"
      data-variant={variant}
      data-layout={layout}
      data-overflow={overflow}
      aria-label={ariaLabel}
      style={isSegment ? segmentListStyle(tabs.length) : undefined}
    >
      {isSegment ? (
        <span
          data-component="tabs-indicator"
          data-part="indicator"
          aria-hidden="true"
          style={segmentIndicatorStyle(activeIndex)}
        />
      ) : null}
      {tabs.map((tab) => (
        <TabsPrimitive.Trigger
          key={tab.value}
          value={tab.value}
          data-component="tabs-trigger"
          data-part="trigger"
          disabled={tab.disabled}
          title={tab.title}
        >
          {tab.label}
        </TabsPrimitive.Trigger>
      ))}
    </TabsPrimitive.List>
  );

  const renderPanelBody = (content: ReactNode): ReactNode => {
    if (scrollable && scrollMode === 'content') {
      return <ScrollArea className="st-scroll-fill">{content}</ScrollArea>;
    }
    return content;
  };

  const tabContents = tabs.map((tab) => (
    <TabsPrimitive.Content
      key={tab.value}
      value={tab.value}
      data-component="tabs-content"
      data-part="content"
      className={contentClassName}
    >
      {renderPanelBody(tab.content)}
    </TabsPrimitive.Content>
  ));

  return (
    <TabsPrimitive.Root
      data-component="tabs"
      data-variant={variant}
      data-scroll-mode={scrollable ? scrollMode : undefined}
      className={cx('st-tabs', className)}
      defaultValue={value === undefined ? initial : undefined}
      value={value}
      onValueChange={handleValueChange}
    >
      {scrollable && scrollMode === 'root' ? (
        <ScrollArea className="st-tabs-scroll-root">
          <div data-component="tabs-scroll-content" data-part="scroll-content">
            {tabList}
            {tabContents}
          </div>
        </ScrollArea>
      ) : (
        <>
          {tabList}
          {tabContents}
        </>
      )}
    </TabsPrimitive.Root>
  );
}
