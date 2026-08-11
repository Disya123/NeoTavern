import { useEffect, useRef, type ReactNode } from 'react';
import { X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogClose, DialogContent, cx } from '@neotavern/ui';
import styles from './SystemSurface.module.css';

export interface SurfaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible dialog name (visually hidden; pages draw their own header). */
  title: string;
  children: ReactNode;
  /** Optional `data-surface` marker for theming / diagnostics. */
  surface?: string;
  className?: string;
}

/**
 * Reusable glass manager shell shared by route `SystemSurface` pages and
 * nested editors (prompt block, etc.). Chat stays mounted behind the portal.
 */
export function SurfaceDialog({
  open,
  onOpenChange,
  title,
  children,
  surface,
  className,
}: SurfaceDialogProps) {
  const { t } = useTranslation();
  const restoreFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = restoreFocusRef.current;
    return () => {
      requestAnimationFrame(() => {
        if (element?.isConnected) element.focus();
      });
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cx(styles.surface, className)}
        title={<span className={styles.srOnly}>{title}</span>}
      >
        <DialogClose asChild>
          <button
            type="button"
            className={styles.closeButton}
            aria-label={t('accessibility:closeSurface', { title })}
            title={t('accessibility:closeSurface', { title })}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </DialogClose>
        <div
          className={styles.content}
          data-component="system-surface"
          data-surface={surface}
          data-slot="modal.layer"
        >
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
