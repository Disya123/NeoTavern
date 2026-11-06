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
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { prefersReducedMotion } from '../motion/spring.js';
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
  const [query, setQuery] = useState('');
  const sectionBodyRef = useRef<HTMLDivElement | null>(null);
  const previousIndex = useRef(sections.findIndex((entry) => entry.value === section));
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return sections;
    return sections.filter((entry) => entry.label.toLowerCase().includes(needle));
  }, [query, sections]);
  const current = sections.find((entry) => entry.value === section);

  useEffect(() => {
    const index = sections.findIndex((entry) => entry.value === section);
    const direction = index >= previousIndex.current ? 1 : -1;
    previousIndex.current = index;
    const body = sectionBodyRef.current;
    if (body === null || prefersReducedMotion()) return;
    // Direction is the meaning: moving down the list pushes the old section up and brings
    // the new one from below, so the eye keeps its place. One curve for every section would
    // say nothing about where you went.
    body.animate(
      [
        { opacity: 0, transform: `translateY(${direction * 14}px)` },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }, [section, sections]);
  const CurrentIcon = current?.icon;

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
          <span className={styles.windowIcon} aria-hidden="true">
            {CurrentIcon ? <CurrentIcon size={18} /> : null}
          </span>
          <h2>{current?.label}</h2>
          <p className={styles.windowHint}>{current?.hint}</p>
          <input
            type="search"
            className={styles.windowSearch}
            placeholder={t('settings:searchSettings')}
            aria-label={t('settings:searchSettings')}
            value={query}
            onChange={(event) => {
              const next = event.target.value;
              setQuery(next);
              const needle = next.trim().toLowerCase();
              if (needle.length === 0) return;
              const matches = sections.filter((entry) =>
                entry.label.toLowerCase().includes(needle),
              );
              // Typing jumps to the first section that matches, so the search is a way in
              // rather than a filter you have to interpret.
              if (matches.length > 0 && !matches.some((entry) => entry.value === section)) {
                setSection(matches[0]!.value);
              }
            }}
          />
        </header>
        <nav className={styles.sectionNav} aria-label={t('settings:title')}>
          {visible.map((entry) => {
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
        <div className={styles.windowBody} ref={sectionBodyRef}>
          {visible.length === 0 ? (
            <p className={styles.emptySearch}>{t('settings:noMatches')}</p>
          ) : (
            current?.content
          )}
        </div>
      </div>
    </SurfaceDialog>
  );
}
