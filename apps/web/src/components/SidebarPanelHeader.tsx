import { X } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './SidebarPanelHeader.module.css';

export interface SidebarPanelHeaderProps {
  title: string;
  eyebrow?: string;
  /** Optional leading avatar/emblem rendered before the title block. */
  avatar?: ReactNode;
  /** Optional actions rendered between the title and the close button. */
  actions?: ReactNode;
  /** Legacy data-part alias kept for backwards compatibility. */
  part?: string;
  onClose: () => void;
}

/**
 * Shared chrome for every navigation-rail panel (settings, AI settings,
 * personas, characters, ...). Single styling contract for themes; plugins
 * targeting the panel slot are unaffected because this only restyles the
 * host chrome, never the mounted content.
 */
export function SidebarPanelHeader({
  title,
  eyebrow,
  avatar,
  actions,
  part = 'header',
  onClose,
}: SidebarPanelHeaderProps) {
  const { t } = useTranslation();
  return (
    <header className={styles.header} data-component="sidebar-panel-header" data-part={part}>
      <div className={styles.identity} data-part="identity">
        {avatar ? (
          <span className={styles.avatar} data-part="avatar">
            {avatar}
          </span>
        ) : null}
        <div className={styles.copy} data-part="title-group">
          {eyebrow ? (
            <span className={styles.eyebrow} data-part="eyebrow">
              {eyebrow}
            </span>
          ) : null}
          <h2 className={styles.title} data-part="title">
            {title}
          </h2>
        </div>
      </div>
      {actions ? (
        <div className={styles.actions} data-part="actions">
          {actions}
        </div>
      ) : null}
      <button
        type="button"
        className={styles.close}
        data-part="close"
        onClick={onClose}
        aria-label={t('accessibility:closeMenu')}
      >
        <X size={20} aria-hidden="true" />
      </button>
    </header>
  );
}
