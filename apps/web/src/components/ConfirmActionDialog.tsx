import { useTranslation } from 'react-i18next';
import {
  ActionBar,
  ActionBarGroup,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
} from '@neotavern/ui';
import styles from './ConfirmActionDialog.module.css';

export interface ConfirmActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
  onConfirm: () => void;
}

/** Accessible replacement for native confirm dialogs. */
export function ConfirmActionDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  busy = false,
  danger = false,
  onConfirm,
}: ConfirmActionDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        <ActionBar
          align="end"
          collapse="stack"
          className={styles.actions}
          data-part="dialog-actions"
        >
          <ActionBarGroup placement="primary">
            <DialogClose asChild>
              <Button disabled={busy}>{t('common:cancel')}</Button>
            </DialogClose>
            <Button variant={danger ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </ActionBarGroup>
        </ActionBar>
      </DialogContent>
    </Dialog>
  );
}
