import { Check, Copy, Pencil, Plus, Trash } from '@phosphor-icons/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderSecret } from '@neotavern/contracts';
import {
  ActionBar,
  ActionBarGroup,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  IconButton,
} from '@neotavern/ui';
import {
  useCreateSecret,
  useDeleteSecret,
  useProviderSecrets,
  useRevealSecret,
  useSecretsExposure,
  useUpdateSecret,
} from '../api/hooks.js';
import { useErrorText } from '../lib/useErrorText.js';
import { ConfirmActionDialog } from './ConfirmActionDialog.js';
import styles from './ApiKeysModal.module.css';

export interface ApiKeysModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Provider whose secrets are managed; null disables data fetching. */
  providerId: string | null;
  providerName: string;
}

/**
 * Multi-key secrets manager (SillyTavern-style). Secret values are write-only:
 * the list shows masked previews, and copying/viewing a plaintext value requires
 * server-side secrets exposure to be enabled (AGENTS.md §4, §11).
 */
export function ApiKeysModal({ open, onOpenChange, providerId, providerName }: ApiKeysModalProps) {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const secrets = useProviderSecrets(providerId ?? undefined);
  const exposure = useSecretsExposure();
  const createSecret = useCreateSecret();
  const updateSecret = useUpdateSecret();
  const deleteSecret = useDeleteSecret();
  const revealSecret = useRevealSecret();

  const [isAdding, setIsAdding] = useState(false);
  const [newValue, setNewValue] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ProviderSecret | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const canReveal = exposure.data?.allowSecretsExposure ?? false;
  const items = secrets.data?.items ?? [];
  const activeId = items.find((secret) => secret.active)?.id ?? '';
  const busy = createSecret.isPending || updateSecret.isPending || deleteSecret.isPending;
  const dateFormatter = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  const fail = (error: unknown): void => setFormError(errorText(error));

  const addSecret = async (): Promise<void> => {
    if (!providerId) return;
    try {
      await createSecret.mutateAsync({
        providerId,
        input: { value: newValue, ...(newLabel.trim() ? { label: newLabel.trim() } : {}) },
      });
      setFormError(null);
      setNewValue('');
      setNewLabel('');
      setIsAdding(false);
    } catch (error) {
      fail(error);
    }
  };

  const makeActive = async (secretId: string): Promise<void> => {
    if (!providerId) return;
    try {
      await updateSecret.mutateAsync({ providerId, secretId, update: { active: true } });
      setFormError(null);
    } catch (error) {
      fail(error);
    }
  };

  const saveLabel = async (secretId: string): Promise<void> => {
    if (!providerId) return;
    try {
      await updateSecret.mutateAsync({
        providerId,
        secretId,
        update: { label: editLabel.trim() ? editLabel.trim() : null },
      });
      setEditingId(null);
      setFormError(null);
    } catch (error) {
      fail(error);
    }
  };

  const copySecret = async (secretId: string): Promise<void> => {
    if (!providerId) return;
    try {
      const revealed = await revealSecret.mutateAsync({ providerId, secretId });
      await navigator.clipboard.writeText(revealed.value);
      setCopiedId(secretId);
      setTimeout(() => setCopiedId((current) => (current === secretId ? null : current)), 2000);
      setFormError(null);
    } catch (error) {
      fail(error);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!providerId || !deleteTarget) return;
    try {
      await deleteSecret.mutateAsync({ providerId, secretId: deleteTarget.id });
      setDeleteTarget(null);
      setFormError(null);
    } catch (error) {
      fail(error);
    }
  };

  const startEdit = (secret: ProviderSecret): void => {
    setEditingId(secret.id);
    setEditLabel(secret.label ?? '');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={styles.modalContent}
        title={t('providers:secretsTitle', { name: providerName })}
      >
        <div data-component="api-keys-modal">
          <ActionBar
            align="split"
            collapse="stack"
            className={styles.header}
            data-part="secret-toolbar"
          >
            <ActionBarGroup placement="primary">
              {items.length > 0 ? (
                <label className={styles.quickActive} data-part="active-key-select">
                  <span>{t('providers:activeKeySelect')}</span>
                  <select
                    className={styles.input}
                    value={activeId}
                    disabled={busy}
                    onChange={(event) => void makeActive(event.target.value)}
                  >
                    {items.map((secret) => (
                      <option key={secret.id} value={secret.id}>
                        {secret.label ? `${secret.label} · ${secret.masked}` : secret.masked}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </ActionBarGroup>
            <ActionBarGroup placement="secondary">
              <Button
                size="sm"
                startIcon={<Plus />}
                onClick={() => setIsAdding((value) => !value)}
                disabled={busy}
              >
                {t('providers:addSecret')}
              </Button>
            </ActionBarGroup>
          </ActionBar>

          {isAdding ? (
            <div className={styles.addSecretForm} data-part="add-secret-form">
              <label className={styles.field}>
                <span>{t('providers:secretValue')}</span>
                <input
                  type="password"
                  className={styles.input}
                  value={newValue}
                  autoComplete="new-password"
                  onChange={(event) => setNewValue(event.target.value)}
                />
              </label>
              <label className={styles.field}>
                <span>{t('providers:secretLabel')}</span>
                <input
                  type="text"
                  className={styles.input}
                  value={newLabel}
                  onChange={(event) => setNewLabel(event.target.value)}
                />
              </label>
              <ActionBar
                align="end"
                collapse="stack"
                className={styles.formActions}
                data-part="form-actions"
              >
                <ActionBarGroup placement="primary">
                  <Button
                    variant="primary"
                    onClick={() => void addSecret()}
                    disabled={createSecret.isPending}
                  >
                    {t('common:save')}
                  </Button>
                  <Button onClick={() => setIsAdding(false)} disabled={createSecret.isPending}>
                    {t('common:cancel')}
                  </Button>
                </ActionBarGroup>
              </ActionBar>
            </div>
          ) : null}

          {!canReveal ? (
            <p className={styles.exposureHint} data-part="exposure-hint">
              {t('providers:secretsExposureDisabled')}
            </p>
          ) : null}

          {formError ? (
            <p className={styles.inlineError} role="alert">
              {formError}
            </p>
          ) : null}

          {items.length === 0 ? (
            <p className={styles.empty}>{t('providers:secretsEmpty')}</p>
          ) : (
            <ul className={styles.keysList} data-part="secrets-list">
              {items.map((secret) => (
                <li
                  key={secret.id}
                  className={styles.keyCard}
                  data-state={secret.active ? 'active' : 'inactive'}
                >
                  <div className={styles.cardHeader}>
                    <div className={styles.cardInfo}>
                      <div className={styles.dateRow}>
                        <span className={styles.date}>
                          {dateFormatter.format(secret.createdAt)}
                        </span>
                        {secret.label ? (
                          <span className={styles.labelTag}>{secret.label}</span>
                        ) : null}
                      </div>
                      {editingId === secret.id ? (
                        <span className={styles.labelEdit}>
                          <input
                            className={styles.input}
                            value={editLabel}
                            aria-label={t('providers:secretLabel')}
                            onChange={(event) => setEditLabel(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void saveLabel(secret.id);
                              if (event.key === 'Escape') setEditingId(null);
                            }}
                          />
                          <IconButton
                            aria-label={t('common:save')}
                            onClick={() => void saveLabel(secret.id)}
                          >
                            <Check aria-hidden="true" />
                          </IconButton>
                        </span>
                      ) : (
                        <span className={styles.keyMasked}>{secret.masked}</span>
                      )}
                    </div>
                    <div className={styles.cardActions}>
                      {secret.active ? (
                        <span className={styles.activeBadge} title={t('providers:secretActive')}>
                          <Check aria-hidden="true" />
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void makeActive(secret.id)}
                          disabled={busy}
                        >
                          {t('providers:secretMakeActive')}
                        </Button>
                      )}
                      <IconButton
                        aria-label={t('providers:secretCopy')}
                        title={t('providers:secretCopy')}
                        disabled={!canReveal || revealSecret.isPending}
                        onClick={() => void copySecret(secret.id)}
                      >
                        {copiedId === secret.id ? (
                          <Check aria-hidden="true" />
                        ) : (
                          <Copy aria-hidden="true" />
                        )}
                      </IconButton>
                      <IconButton
                        aria-label={t('providers:secretEditLabel')}
                        title={t('providers:secretEditLabel')}
                        disabled={busy}
                        onClick={() => startEdit(secret)}
                      >
                        <Pencil aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        aria-label={t('providers:secretDelete')}
                        title={t('providers:secretDelete')}
                        disabled={busy}
                        onClick={() => setDeleteTarget(secret)}
                      >
                        <Trash aria-hidden="true" />
                      </IconButton>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <ActionBar
            align="end"
            collapse="stack"
            className={styles.footer}
            data-part="dialog-actions"
          >
            <ActionBarGroup placement="primary">
              <DialogClose asChild>
                <Button variant="primary">{t('common:close')}</Button>
              </DialogClose>
            </ActionBarGroup>
          </ActionBar>
        </div>

        <ConfirmActionDialog
          open={deleteTarget !== null}
          onOpenChange={(next) => {
            if (!next) setDeleteTarget(null);
          }}
          title={t('providers:secretDeleteTitle')}
          description={t('providers:secretDeleteDescription')}
          confirmLabel={t('common:delete')}
          busy={deleteSecret.isPending}
          danger
          onConfirm={() => void confirmDelete()}
        />
      </DialogContent>
    </Dialog>
  );
}
