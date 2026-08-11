import type { ReactNode } from 'react';

export interface FloatingTabContentProps {
  children: ReactNode;
}

/** Scrollable content marker paired with the shell's floating tab cloud. */
export function FloatingTabContent({ children }: FloatingTabContentProps) {
  return <div data-part="floating-tab-content">{children}</div>;
}
