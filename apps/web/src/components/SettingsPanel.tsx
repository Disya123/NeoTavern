import { ArrowClockwise, Database, DownloadSimple, SlidersHorizontal } from '@phosphor-icons/react';
import { useState, type ChangeEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ActionBar, ActionBarGroup, Button, Segmented, Tabs } from '@neotavern/ui';
import { SUPPORTED_LANGUAGES } from '@neotavern/i18n';
import type { AuthSession } from '@neotavern/contracts';
import {
  useActivateTheme,
  useBackups,
  useCreateBackup,
  useInstallTheme,
  useLogout,
  useResetTheme,
  useRestoreBackup,
  useThemes,
  useUpdateSettings,
} from '../api/hooks.js';
import {
  useUiStore,
  type CharacterMessagePosition,
  type ChatAvatarStyle,
  type ChatStyle,
  type UiContrast,
  type UiFontProfile,
  type UiMotion,
  type UiScale,
  type UserMessagePosition,
} from '../state/ui.js';
import { useErrorText } from '../lib/useErrorText.js';
import { DataMigrationPanel } from './DataMigrationPanel.js';
import { DiagnosticsPanel } from './DiagnosticsPanel.js';
import { FloatingTabContent } from './FloatingTabContent.js';
import { FloatingTabPanel } from './FloatingTabPanel.js';
import { PluginSettingsPanels } from './PluginPanels.js';
import { SystemSurfaceLink } from './SystemSurfaceLink.js';
import styles from './SettingsPanel.module.css';

const MAX_THEME_BYTES = 25 * 1024 * 1024;

export interface SettingsPanelProps {
  onClose: () => void;
}

/** Settings menu: tabbed General / Themes / Data panel (role="tablist"). */
export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { t } = useTranslation();
  return (
    <FloatingTabPanel
      component="settings-panel"
      headerPart="settings-header"
      avatar={
        <span className={styles.headerAvatar} aria-hidden="true">
          <SlidersHorizontal size={20} />
        </span>
      }
      title={t('settings:title')}
      onClose={onClose}
    >
      <Tabs
        variant="segment"
        ariaLabel={t('settings:title')}
        defaultValue="general"
        className={styles.tabs}
        contentClassName={styles.tabPanel}
        scrollable
        scrollMode="root"
        tabs={[
          {
            value: 'general',
            label: t('settings:general'),
            content: (
              <FloatingTabContent>
                <GeneralTab />
              </FloatingTabContent>
            ),
          },
          {
            value: 'themes',
            label: t('navigation:themes'),
            content: (
              <FloatingTabContent>
                <ThemesTab />
              </FloatingTabContent>
            ),
          },
          {
            value: 'data',
            label: t('settings:data'),
            content: (
              <FloatingTabContent>
                <DataTab />
              </FloatingTabContent>
            ),
          },
        ]}
      />
    </FloatingTabPanel>
  );
}

function GeneralTab() {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const updateSettings = useUpdateSettings();
  // Read-only session peek: subscribing to the auth-session query here would
  // mount a second observer inside the AuthGate, which refetches the query on
  // mount — flipping the gate to pending, unmounting this panel, and looping
  // endlessly whenever the backend is unreachable. The gate already populated
  // the cache before rendering its children.
  const queryClient = useQueryClient();
  const authSession = queryClient.getQueryData<AuthSession>(['auth-session']);
  const logout = useLogout();
  const language = useUiStore((state) => state.language);
  const setLanguage = useUiStore((state) => state.setLanguage);
  const openHomeOnLoad = useUiStore((state) => state.openHomeOnLoad);
  const setOpenHomeOnLoad = useUiStore((state) => state.setOpenHomeOnLoad);
  const scale = useUiStore((state) => state.scale);
  const setScale = useUiStore((state) => state.setScale);
  const contrast = useUiStore((state) => state.contrast);
  const setContrast = useUiStore((state) => state.setContrast);
  const fontProfile = useUiStore((state) => state.fontProfile);
  const setFontProfile = useUiStore((state) => state.setFontProfile);
  const motion = useUiStore((state) => state.motion);
  const setMotion = useUiStore((state) => state.setMotion);
  const uiOpacity = useUiStore((state) => state.uiOpacity);
  const setUiOpacity = useUiStore((state) => state.setUiOpacity);
  const uiGlassBlur = useUiStore((state) => state.uiGlassBlur);
  const setUiGlassBlur = useUiStore((state) => state.setUiGlassBlur);
  const chatStyle = useUiStore((state) => state.chatStyle);
  const setChatStyle = useUiStore((state) => state.setChatStyle);
  const chatAvatarStyle = useUiStore((state) => state.chatAvatarStyle);
  const setChatAvatarStyle = useUiStore((state) => state.setChatAvatarStyle);
  const userMessagePosition = useUiStore((state) => state.userMessagePosition);
  const setUserMessagePosition = useUiStore((state) => state.setUserMessagePosition);
  const characterMessagePosition = useUiStore((state) => state.characterMessagePosition);
  const setCharacterMessagePosition = useUiStore((state) => state.setCharacterMessagePosition);

  const changeLanguage = async (code: string): Promise<void> => {
    setLanguage(code);
    await i18n.changeLanguage(code);
    void updateSettings.mutateAsync({ language: code }).catch(() => undefined);
  };

  return (
    <div className={styles.body} data-part="general-settings">
      <Section title={t('settings:startup')} hint={t('settings:startupHint')}>
        <Field label={t('settings:openHomeOnLoad')} hint={t('settings:openHomeOnLoadHint')}>
          <Segmented<'home' | 'current'>
            value={openHomeOnLoad ? 'home' : 'current'}
            ariaLabel={t('settings:openHomeOnLoad')}
            onChange={(value) => setOpenHomeOnLoad(value === 'home')}
            options={[
              { value: 'home', label: t('settings:openHomeOnLoadHome') },
              { value: 'current', label: t('settings:openHomeOnLoadCurrent') },
            ]}
          />
        </Field>
      </Section>

      <Section title={t('settings:appearance')} hint={t('settings:appearanceHint')}>
        <Field label={t('settings:language')}>
          <select
            data-component="input"
            aria-label={t('settings:language')}
            value={language}
            onChange={(event) => void changeLanguage(event.target.value)}
          >
            {SUPPORTED_LANGUAGES.map((item) => (
              <option key={item.code} value={item.code}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('settings:interfaceScale')}>
          <Segmented<UiScale>
            value={scale}
            ariaLabel={t('settings:interfaceScale')}
            onChange={setScale}
            options={[
              { value: 'small', label: t('settings:scaleSmall') },
              { value: 'medium', label: t('settings:scaleMedium') },
              { value: 'large', label: t('settings:scaleLarge') },
            ]}
          />
        </Field>
        <Field label={t('settings:fontProfile')}>
          <Segmented<UiFontProfile>
            value={fontProfile}
            ariaLabel={t('settings:fontProfile')}
            onChange={setFontProfile}
            options={[
              { value: 'default', label: t('settings:fontProfileDefault') },
              { value: 'dyslexia', label: t('settings:fontProfileDyslexia') },
            ]}
          />
        </Field>
        <Field label={t('settings:contrast')}>
          <Segmented<UiContrast>
            value={contrast}
            ariaLabel={t('settings:contrast')}
            onChange={setContrast}
            options={[
              { value: 'normal', label: t('settings:contrastNormal') },
              { value: 'high', label: t('settings:contrastHigh') },
            ]}
          />
        </Field>
        <Field label={t('settings:motion')}>
          <Segmented<UiMotion>
            value={motion}
            ariaLabel={t('settings:motion')}
            onChange={setMotion}
            options={[
              { value: 'system', label: t('settings:motionSystem') },
              { value: 'reduced', label: t('settings:motionReduced') },
            ]}
          />
        </Field>
        <div className={styles.field}>
          <div className={styles.rangeHeader}>
            <span>{t('settings:uiOpacity')}</span>
            <span className={styles.rangeValue}>{uiOpacity}%</span>
          </div>
          <input
            className={styles.rangeInput}
            type="range"
            min={0}
            max={100}
            step={5}
            value={uiOpacity}
            aria-label={t('settings:uiOpacity')}
            onChange={(e) => setUiOpacity(Number(e.target.value))}
          />
        </div>
        <div className={styles.field}>
          <div className={styles.rangeHeader}>
            <span>{t('settings:uiGlassBlur')}</span>
            <span className={styles.rangeValue}>{uiGlassBlur}px</span>
          </div>
          <input
            className={styles.rangeInput}
            type="range"
            min={0}
            max={40}
            step={1}
            value={uiGlassBlur}
            aria-label={t('settings:uiGlassBlur')}
            onChange={(e) => setUiGlassBlur(Number(e.target.value))}
          />
        </div>
        <Field label={t('settings:userMessagePosition')}>
          <Segmented<UserMessagePosition>
            value={userMessagePosition}
            ariaLabel={t('settings:userMessagePosition')}
            onChange={setUserMessagePosition}
            options={[
              { value: 'left', label: t('settings:userPositionLeft') },
              { value: 'right', label: t('settings:userPositionRight') },
            ]}
          />
        </Field>
        <Field label={t('settings:characterMessagePosition')}>
          <Segmented<CharacterMessagePosition>
            value={characterMessagePosition}
            ariaLabel={t('settings:characterMessagePosition')}
            onChange={setCharacterMessagePosition}
            options={[
              { value: 'left', label: t('settings:characterPositionLeft') },
              { value: 'right', label: t('settings:characterPositionRight') },
            ]}
          />
        </Field>
        <Field label={t('settings:chatStyle')}>
          <select
            data-component="input"
            aria-label={t('settings:chatStyle')}
            value={chatStyle}
            onChange={(event) => setChatStyle(event.target.value as ChatStyle)}
          >
            <option value="clean">{t('settings:chatStyleClean')}</option>
            <option value="classic">{t('settings:chatStyleClassic')}</option>
            <option value="bubbles">{t('settings:chatStyleBubbles')}</option>
            <option value="document">{t('settings:chatStyleDocument')}</option>
            <option value="cards">{t('settings:chatStyleCards')}</option>
            <option value="paragraphs">{t('settings:chatStyleParagraphs')}</option>
          </select>
        </Field>
        <Field label={t('settings:chatAvatarStyle')}>
          <select
            data-component="input"
            aria-label={t('settings:chatAvatarStyle')}
            value={chatAvatarStyle}
            onChange={(event) => setChatAvatarStyle(event.target.value as ChatAvatarStyle)}
          >
            <option value="round">{t('settings:chatAvatarRound')}</option>
            <option value="square">{t('settings:chatAvatarSquare')}</option>
            <option value="portrait">{t('settings:chatAvatarPortrait')}</option>
            <option value="banner">{t('settings:chatAvatarBanner')}</option>
            <option value="hidden">{t('settings:chatAvatarHidden')}</option>
          </select>
        </Field>
      </Section>

      <Section title={t('settings:diagnostics')} hint={t('settings:diagnosticsHint')}>
        <DiagnosticsPanel />
      </Section>

      <PluginSettingsPanels />

      {authSession?.required ? (
        <Section title={t('auth:remoteMode')} hint={t('auth:signOutHint')}>
          <div className={styles.signOutRow}>
            <span>{t('auth:signOut')}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              {t('auth:signOut')}
            </Button>
          </div>
          {logout.error ? (
            <p className={styles.error} role="alert">
              {errorText(logout.error)}
            </p>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}

function ThemesTab() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const themes = useThemes();
  const activate = useActivateTheme();
  const reset = useResetTheme();
  const install = useInstallTheme();
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const busy = activate.isPending || reset.isPending || install.isPending;

  const choosePackage = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setNotice(null);
    setActionError(null);
    if (file.size > MAX_THEME_BYTES) {
      setActionError(t('themes:fileTooLarge'));
      return;
    }
    try {
      const result = await install.mutateAsync(file);
      setNotice(
        t(result.replaced ? 'themes:updatedNotice' : 'themes:installedNotice', {
          name: result.theme.name,
        }),
      );
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const activateTheme = async (id: string): Promise<void> => {
    setNotice(null);
    setActionError(null);
    try {
      await activate.mutateAsync(id);
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const resetTheme = async (): Promise<void> => {
    setNotice(null);
    setActionError(null);
    try {
      await reset.mutateAsync();
      setNotice(t('themes:resetNotice'));
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const selectTheme = (id: string): void => {
    if (!id) {
      void resetTheme();
      return;
    }
    const theme = themes.data?.items.find((item) => item.id === id);
    if (theme) void activateTheme(theme.id);
  };

  return (
    <div className={styles.body} data-part="theme-settings">
      {notice ? (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      ) : null}
      {actionError ? (
        <p className={styles.error} role="alert">
          {actionError}
        </p>
      ) : null}

      <Field label={t('themes:selectTheme')}>
        <select
          data-component="input"
          data-part="theme-select"
          aria-label={t('themes:selectTheme')}
          value={themes.data?.activeThemeId ?? ''}
          disabled={busy}
          onChange={(event) => selectTheme(event.target.value)}
        >
          <option value="">{t('themes:builtInTitle')}</option>
          {(themes.data?.items ?? []).map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.name} · v{theme.version}
            </option>
          ))}
        </select>
      </Field>

      <Button asChild variant="primary" className={styles.installButton}>
        <label>
          <DownloadSimple aria-hidden="true" />
          {install.isPending ? t('themes:installing') : t('themes:install')}
          <input
            className={styles.fileInput}
            type="file"
            accept=".zip,.sttheme,application/zip"
            disabled={busy}
            onChange={(event) => void choosePackage(event)}
          />
        </label>
      </Button>

      <SystemSurfaceLink to="/themes" className={styles.managerLink}>
        {t('themes:openManager')}
      </SystemSurfaceLink>
    </div>
  );
}

function DataTab() {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const backupsQuery = useBackups();
  const createBackupMutation = useCreateBackup();
  const restoreBackupMutation = useRestoreBackup();
  const backups = backupsQuery.data ?? null;
  const busy = createBackupMutation.isPending || restoreBackupMutation.isPending;
  const lastBackupError = createBackupMutation.error ?? restoreBackupMutation.error;
  const backupError = lastBackupError ? errorText(lastBackupError) : null;
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const dateFormatter = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const numberFormatter = new Intl.NumberFormat(i18n.language, {
    maximumFractionDigits: 1,
  });

  const refreshBackups = (): void => {
    void backupsQuery.refetch();
  };

  const createBackup = (): void => {
    void createBackupMutation.mutateAsync().catch(() => undefined);
  };

  const restoreBackup = (id: string): void => {
    setBackupMessage(null);
    void restoreBackupMutation
      .mutateAsync(id)
      .then((result) => {
        if (result.restartRequired) setBackupMessage(t('settings:restoredReload'));
      })
      .catch(() => undefined);
  };

  return (
    <div className={styles.body} data-part="data-settings">
      <DataMigrationPanel />

      <section className={styles.section}>
        <header className={styles.sectionHeader}>
          <h2>{t('settings:data')}</h2>
          <p>{t('settings:dataHint')}</p>
        </header>
        <ActionBar collapse="stack" className={styles.backupActions} data-part="backup-actions">
          <ActionBarGroup placement="primary">
            <Button
              variant="primary"
              startIcon={<Database />}
              onClick={() => void createBackup()}
              disabled={busy}
            >
              {t('settings:createBackup')}
            </Button>
            <Button
              variant="ghost"
              startIcon={<ArrowClockwise />}
              onClick={() => void refreshBackups()}
              disabled={busy}
            >
              {t('settings:refreshBackups')}
            </Button>
          </ActionBarGroup>
        </ActionBar>
        {backupError ? (
          <p className={styles.error} role="alert">
            {backupError}
          </p>
        ) : null}
        {backupMessage ? (
          <p className={styles.notice} role="status">
            {backupMessage}
          </p>
        ) : null}
        {backups ? (
          backups.length > 0 ? (
            <ul className={styles.backups}>
              {backups.map((backup) => (
                <li key={backup.id} className={styles.backupItem}>
                  <span className={styles.backupIcon}>
                    <Database aria-hidden="true" />
                  </span>
                  <span className={styles.backupCopy}>
                    <strong>{dateFormatter.format(backup.createdAt)}</strong>
                    <small>
                      {t(
                        backup.kind === 'auto'
                          ? 'settings:backupKindAuto'
                          : 'settings:backupKindManual',
                      )}
                      {' · '}
                      {t('settings:backupSize', {
                        size: numberFormatter.format(backup.sizeBytes / 1024 / 1024),
                      })}
                    </small>
                  </span>
                  <Button size="sm" onClick={() => void restoreBackup(backup.id)} disabled={busy}>
                    {t('settings:restoreBackup')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.noBackups}>{t('settings:noBackups')}</p>
          )
        ) : null}
      </section>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <h2>{title}</h2>
        {hint ? <p>{hint}</p> : null}
      </header>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      {label ? <span className={styles.fieldLabel}>{label}</span> : null}
      {hint ? <small className={styles.fieldHint}>{hint}</small> : null}
      {children}
    </div>
  );
}
