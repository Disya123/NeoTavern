import type { ReactNode } from 'react';
import { cx } from '@neotavern/ui';
import { SidebarPanelHeader } from './SidebarPanelHeader.js';
import styles from './FloatingTabPanel.module.css';

export interface FloatingTabPanelProps {
  /** data-component value identifying this panel to themes. */
  component: string;
  /** SidebarPanelHeader part alias (default 'header'). */
  headerPart?: string;
  title: string;
  eyebrow?: string;
  avatar?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  className?: string;
  /** Optional migration-only metadata for renderer-neutral UI capture. */
  uiCapture?: {
    node: string;
    component: string;
    root?: string;
    version?: string;
    action?: string;
  };
  children: ReactNode;
}

/**
 * Shared shell for every navigation-rail floating tab panel: the flex column
 * wrapper (inline-size containment for container queries) plus the
 * SidebarPanelHeader chrome. Panels mount their tab content as children.
 */
export function FloatingTabPanel({
  component,
  headerPart = 'header',
  title,
  eyebrow,
  avatar,
  actions,
  onClose,
  className,
  uiCapture,
  children,
}: FloatingTabPanelProps) {
  return (
    <div
      className={cx(styles.root, className)}
      data-component={component}
      data-role="floating-tab-panel"
      data-ui-node={uiCapture?.node}
      data-ui-component={uiCapture?.component}
      data-ui-root={uiCapture?.root}
      data-ui-version={uiCapture?.version}
      data-ui-action={uiCapture?.action}
    >
      <SidebarPanelHeader
        part={headerPart}
        title={title}
        eyebrow={eyebrow}
        avatar={avatar}
        actions={actions}
        onClose={onClose}
      />
      {children}
    </div>
  );
}
