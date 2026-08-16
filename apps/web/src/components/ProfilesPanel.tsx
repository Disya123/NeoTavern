/**
 * Configuration profiles panel (ТЗ §8.1 Configuration, Этап 4 slice 5
 * remainder, M5). Rendered as the Profiles tab inside the Settings panel.
 *
 * Server state (profile list) lives in TanStack Query; every mutation goes
 * through the NeoBackend facade (ТЗ §13.1). The panel offers:
 *   - list/create/rename/delete of named profiles;
 *   - the SEC-02 logical profile export (ADR-0047 waiver 4): a scoped
 *     container carries only the selected profile's characters and their
 *     chats/messages (lorebooks and presets are the shared library and are
 *     always included); the manifest echoes the scope. An unknown profile id
 *     is PROFILE_NOT_FOUND. Secrets never enter the container.
 */
import { DownloadSimple, PencilSimple, Plus, Trash, UploadSimple } from '@phosphor-icons/react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, SelectField, TextField } from '@neotavern/ui';
import type { ProfileDto, ProfileImportPolicy } from '@neotavern/contracts';
import {
  useCreateProfile,
  useDeleteProfile,
  useProfileExport,
  useProfileImport,
  useProfiles,
  useRenameProfile,
} from '../api/profilesHooks.js';
import { useErrorText } from '../lib/useErrorText.js';
import { ConfirmActionDialog } from './ConfirmActionDialog.js';
import styles from './SettingsPanel.module.css';

export function ProfilesPanel() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const profiles = useProfiles();
  const createProfile = useCreateProfile();
  const renameProfile = useRenameProfile();
  const deleteProfile = useDeleteProfile();
  const profileExport = useProfileExport();
  const profileImport = useProfileImport();

  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState('');
  const [deleting, setDeleting] = useState<ProfileDto | null>(null);
  const [exporting, setExporting] = useState<ProfileDto | null>(null);
  const [importPath, setImportPath] = useState('');
  const [importPolicy, setImportPolicy] = useState<ProfileImportPolicy>('reject');
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const busy =
    createProfile.isPending ||
    renameProfile.isPending ||
    deleteProfile.isPending ||
    profileExport.isPending ||
    profileImport.isPending;

  const submitCreate = (event: FormEvent): void => {
    event.preventDefault();
    const name = newName.trim();
    if (!name || busy) return;
    setNotice(null);
    setActionError(null);
    createProfile
      .mutateAsync({ name })
      .then(() => {
        setNewName('');
        setNotice(t('profiles:createdNotice', { name }));
      })
      .catch((cause) => setActionError(errorText(cause)));
  };

  const submitRename = (event: FormEvent, profile: ProfileDto): void => {
    event.preventDefault();
    const name = renameName.trim();
    if (!name || busy) return;
    setNotice(null);
    setActionError(null);
    renameProfile
      .mutateAsync({ id: profile.id, name })
      .then(() => {
        setRenamingId(null);
        setNotice(t('profiles:renamedNotice', { name }));
      })
      .catch((cause) => setActionError(errorText(cause)));
  };

  const startRename = (profile: ProfileDto): void => {
    setRenamingId(profile.id);
    setRenameName(profile.name);
    setActionError(null);
  };

  const runDelete = (): void => {
    if (!deleting) return;
    const profile = deleting;
    setNotice(null);
    setActionError(null);
    deleteProfile
      .mutateAsync(profile.id)
      .then(() => {
        setDeleting(null);
        setNotice(t('profiles:deletedNotice', { name: profile.name }));
      })
      .catch((cause) => setActionError(errorText(cause)));
  };

  const runExport = (profile: ProfileDto): void => {
    setNotice(null);
    setActionError(null);
    setExporting(profile);
    profileExport
      .mutateAsync({ profileId: profile.id })
      .then((result) => {
        setNotice(
          t('profiles:exportedNotice', {
            name: profile.name,
            characters: result.records.characters,
            chats: result.records.chats,
            messages: result.records.messages,
          }),
        );
      })
      .catch((cause) => setActionError(errorText(cause)))
      .finally(() => setExporting(null));
  };

  const runImport = (event: FormEvent): void => {
    event.preventDefault();
    const containerPath = importPath.trim();
    if (!containerPath || busy) return;
    setNotice(null);
    setActionError(null);
    profileImport
      .mutateAsync({ containerPath, policy: importPolicy })
      .then((result) => {
        setImportPath('');
        const orphansNote =
          result.orphans.length > 0
            ? ` ${t('profiles:importOrphans', { count: result.orphans.length })}`
            : '';
        setNotice(`${t('profiles:importedNotice', result)}${orphansNote}`);
      })
      .catch((cause) => setActionError(errorText(cause)));
  };

  const items = profiles.data?.items ?? [];

  return (
    <div className={styles.body} data-part="profiles-settings">
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

      <section className={styles.section}>
        <header className={styles.sectionHeader}>
          <h2>{t('profiles:title')}</h2>
          <p>{t('profiles:titleHint')}</p>
        </header>
        <form className={styles.field} onSubmit={(event) => void submitCreate(event)}>
          <span className={styles.fieldLabel}>{t('profiles:createName')}</span>
          <div className={styles.createRow}>
            <TextField
              data-component="input"
              data-part="profile-name-input"
              aria-label={t('profiles:createName')}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              disabled={busy}
              placeholder={t('profiles:createPlaceholder')}
            />
            <Button
              type="submit"
              variant="primary"
              startIcon={<Plus />}
              disabled={busy || newName.trim().length === 0}
            >
              {t('profiles:create')}
            </Button>
          </div>
        </form>
      </section>

      <section className={styles.section}>
        <header className={styles.sectionHeader}>
          <h2>{t('profiles:import')}</h2>
          <p>{t('profiles:importHint')}</p>
        </header>
        <form className={styles.field} onSubmit={(event) => void runImport(event)}>
          <span className={styles.fieldLabel}>{t('profiles:importPathLabel')}</span>
          <TextField
            data-component="input"
            data-part="profile-import-path"
            aria-label={t('profiles:importPathLabel')}
            value={importPath}
            onChange={(event) => setImportPath(event.target.value)}
            disabled={busy}
            placeholder={t('profiles:importPathPlaceholder')}
          />
          <span className={styles.fieldLabel}>{t('profiles:importPolicyLabel')}</span>
          <SelectField
            label={t('profiles:importPolicyLabel')}
            data-part="profile-import-policy"
            value={importPolicy}
            onChange={(event) => setImportPolicy(event.target.value as ProfileImportPolicy)}
            disabled={busy}
          >
            <option value="reject">{t('profiles:importPolicyReject')}</option>
            <option value="replace">{t('profiles:importPolicyReplace')}</option>
            <option value="remap">{t('profiles:importPolicyRemap')}</option>
          </SelectField>
          <div className={styles.createRow}>
            <Button
              type="submit"
              variant="primary"
              startIcon={<UploadSimple />}
              disabled={busy || importPath.trim().length === 0}
            >
              {profileImport.isPending ? t('profiles:importing') : t('profiles:import')}
            </Button>
          </div>
        </form>
      </section>

      <section className={styles.section}>
        <header className={styles.sectionHeader}>
          <h2>{t('profiles:listTitle')}</h2>
          <p>{t('profiles:listHint')}</p>
        </header>
        {profiles.isError ? (
          <p className={styles.error} role="alert">
            {errorText(profiles.error)}
          </p>
        ) : items.length === 0 ? (
          <p className={styles.noBackups}>{t('profiles:empty')}</p>
        ) : (
          <ul className={styles.backups}>
            {items.map((profile) => (
              <li key={profile.id} className={styles.backupItem}>
                {renamingId === profile.id ? (
                  <form
                    className={styles.renameRow}
                    onSubmit={(event) => void submitRename(event, profile)}
                  >
                    <TextField
                      data-component="input"
                      data-part="profile-rename-input"
                      aria-label={t('profiles:rename')}
                      value={renameName}
                      onChange={(event) => setRenameName(event.target.value)}
                      disabled={busy}
                      autoFocus
                    />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={busy || renameName.trim().length === 0}
                    >
                      {t('profiles:rename')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setRenamingId(null)}
                    >
                      {t('profiles:cancel')}
                    </Button>
                  </form>
                ) : (
                  <>
                    <span className={styles.backupIcon}>
                      <span className={styles.profileInitial} aria-hidden="true">
                        {profile.name.slice(0, 1).toUpperCase()}
                      </span>
                    </span>
                    <span className={styles.backupCopy}>
                      <strong>{profile.name}</strong>
                      <small>
                        {t('profiles:createdAt', {
                          date: new Intl.DateTimeFormat(undefined, {
                            dateStyle: 'medium',
                          }).format(new Date(profile.createdAt)),
                        })}
                      </small>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      startIcon={<DownloadSimple />}
                      disabled={busy || exporting?.id === profile.id}
                      onClick={() => void runExport(profile)}
                      aria-label={t('profiles:exportAction', { name: profile.name })}
                    >
                      {exporting?.id === profile.id
                        ? t('profiles:exporting')
                        : t('profiles:exportAction', { name: profile.name })}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      startIcon={<PencilSimple />}
                      disabled={busy}
                      onClick={() => startRename(profile)}
                      aria-label={t('profiles:rename')}
                    >
                      {t('profiles:rename')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      startIcon={<Trash />}
                      disabled={busy}
                      onClick={() => setDeleting(profile)}
                      aria-label={t('profiles:delete')}
                    >
                      {t('profiles:delete')}
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmActionDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!deleteProfile.isPending) setDeleting(open ? deleting : null);
        }}
        title={t('profiles:deleteConfirmTitle')}
        description={t('profiles:deleteConfirmDescription', {
          name: deleting?.name ?? '',
        })}
        confirmLabel={t('profiles:delete')}
        busy={deleteProfile.isPending}
        danger
        onConfirm={() => void runDelete()}
      />
    </div>
  );
}
