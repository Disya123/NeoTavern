/**
 * Settings as a window over the chat (desktop) or the whole screen (phone).
 *
 * The settings used to open as a sidebar panel, which made the most important surface in
 * the product share space with the chat and read like a drawer. They are a system surface
 * now: the same modal layer that Characters and Providers use, centred over the
 * conversation, with the chat still mounted behind it so nothing in progress is lost.
 *
 * The section list comes from `useSettingsSections`, so the window and the old panel can
 * never disagree about which settings exist.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SurfaceDialog } from './SurfaceDialog.js';
import { useSettingsSections, type SettingsSectionId } from './SettingsPanel.js';
import styles from './SettingsPanel.module.css';

export interface SettingsWindowProps {
  onClose: () => void;
}

export function SettingsWindow({ onClose }: SettingsWindowProps) {
  const { t } = useTranslation();
  const sections = useSettingsSections(onClose);
  const [section, setSection] = useState<SettingsSectionId>('general');

  return (
    <SurfaceDialog
      open
      surface="settings"
      title={t('settings:title')}
      className={styles.settingsWindow}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className={styles.window}>
        {/* The dialog's close control lives in this band, so the band is reserved here
            instead of moving the control: settings content starts below it and can never
            collide with the X. */}
        <header className={styles.windowHeader}>
          <h2>{sections.find((entry) => entry.value === section)?.label}</h2>
        </header>
        <nav className={styles.sectionNav} aria-label={t('settings:title')}>
          {sections.map((entry) => {
            const EntryIcon = entry.icon;
            const active = entry.value === section;
            return (
              <button
                key={entry.value}
                type="button"
                className={styles.sectionButton}
                data-active={active || undefined}
                aria-current={active ? 'page' : undefined}
                onClick={() => setSection(entry.value)}
              >
                <EntryIcon size={18} aria-hidden="true" />
                <span>{entry.label}</span>
              </button>
            );
          })}
        </nav>
        <div className={styles.windowBody}>
          {sections.find((entry) => entry.value === section)?.content}
        </div>
      </div>
    </SurfaceDialog>
  );
}
