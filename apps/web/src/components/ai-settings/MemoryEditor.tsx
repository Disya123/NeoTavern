import { FloppyDisk, Plus, Trash } from '@phosphor-icons/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Memory, MemoryScope } from '@neotavern/contracts';
import { Button, Switch } from '@neotavern/ui';
import {
  useCharacters,
  useCreateMemory,
  useDeleteMemory,
  useMemories,
  useUpdateMemory,
} from '../../api/hooks.js';
import { useErrorText } from '../../lib/useErrorText.js';
import { ConfirmActionDialog } from '../ConfirmActionDialog.js';
import styles from './AiSettings.module.css';

interface MemoryDraft {
  scope: MemoryScope;
  characterId: string;
  keys: string;
  content: string;
  enabled: boolean;
}

const EMPTY_DRAFT: MemoryDraft = {
  scope: 'global',
  characterId: '',
  keys: '',
  content: '',
  enabled: true,
};

const parseKeys = (raw: string): string[] =>
  raw
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

/**
 * Memory settings editor (ТЗ §4.4, Этап 4 slice 3): CRUD over the wire
 * `memories.*` ops through the facade. Scope `character` requires an existing
 * character (the kernel validates `CHARACTER_NOT_FOUND`); keys are stored as
 * the activation keywords the prompt pipeline matches (`memory-keyword-v1`).
 */
export function MemoryEditor() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const memories = useMemories();
  const characters = useCharacters();
  const createMemory = useCreateMemory();
  const updateMemory = useUpdateMemory();
  const deleteMemory = useDeleteMemory();
  const [draft, setDraft] = useState<MemoryDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const busy = createMemory.isPending || updateMemory.isPending || deleteMemory.isPending;

  const rows = memories.data?.items ?? [];
  const characterRows = characters.data?.pages.flatMap((page) => page.items) ?? [];

  const resetDraft = (): void => {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
    setFormError(null);
  };

  const submitCreate = async (): Promise<void> => {
    const content = draft.content.trim();
    if (!content) {
      setFormError(t('settings:memoryContentRequired'));
      return;
    }
    if (draft.scope === 'character' && !draft.characterId) {
      setFormError(t('settings:memoryCharacterRequired'));
      return;
    }
    try {
      await createMemory.mutateAsync({
        scope: draft.scope,
        ...(draft.scope === 'character' ? { characterId: draft.characterId } : {}),
        keys: parseKeys(draft.keys),
        content,
        enabled: draft.enabled,
      });
      resetDraft();
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  const submitUpdate = async (memory: Memory): Promise<void> => {
    const content = draft.content.trim();
    if (!content) {
      setFormError(t('settings:memoryContentRequired'));
      return;
    }
    if (draft.scope === 'character' && !draft.characterId) {
      setFormError(t('settings:memoryCharacterRequired'));
      return;
    }
    try {
      await updateMemory.mutateAsync({
        id: memory.id,
        update: {
          scope: draft.scope,
          ...(draft.scope === 'character' ? { characterId: draft.characterId } : {}),
          keys: parseKeys(draft.keys),
          content,
          enabled: draft.enabled,
        },
      });
      resetDraft();
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  const beginEdit = (memory: Memory): void => {
    setEditingId(memory.id);
    setDraft({
      scope: memory.scope,
      characterId: memory.characterId ?? '',
      keys: memory.keys.join(', '),
      content: memory.content,
      enabled: memory.enabled,
    });
    setFormError(null);
  };

  const requestDelete = (memory: Memory): void => {
    setPendingDeleteId(memory.id);
    setDeleteOpen(true);
  };

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDeleteId) return;
    try {
      await deleteMemory.mutateAsync(pendingDeleteId);
      setDeleteOpen(false);
      setPendingDeleteId(null);
      if (editingId === pendingDeleteId) resetDraft();
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  const characterName = (characterId: string | null): string => {
    if (!characterId) return '';
    return characterRows.find((character) => character.id === characterId)?.name ?? characterId;
  };

  return (
    <section className={styles.generationEditor} data-component="memory-editor">
      <div className={styles.sectionHeading}>
        <strong>{t('settings:memoriesEditor')}</strong>
        <span>{t('settings:memoriesEditorHint')}</span>
      </div>

      {rows.length === 0 ? (
        <p className={styles.inlineHint}>{t('settings:memoryEmpty')}</p>
      ) : (
        <ul className={styles.memoryList} data-part="memory-list">
          {rows.map((memory) => {
            const editing = editingId === memory.id;
            return (
              <li
                key={memory.id}
                className={styles.memoryCard}
                data-state={memory.enabled ? 'enabled' : 'disabled'}
              >
                {editing ? (
                  <MemoryFormFields
                    draft={draft}
                    characters={characterRows}
                    disabled={busy}
                    onChange={setDraft}
                  />
                ) : (
                  <div className={styles.memoryCardHeader}>
                    <span className={styles.memoryMeta}>
                      {memory.scope === 'character'
                        ? characterName(memory.characterId)
                        : t('settings:memoryScope_global')}
                      {memory.keys.length > 0 ? ` — ${memory.keys.join(', ')}` : ''}
                    </span>
                    <label className={styles.checkboxField} data-part="memory-enabled">
                      <Switch
                        checked={memory.enabled}
                        disabled={busy}
                        onCheckedChange={(checked) =>
                          void updateMemory
                            .mutateAsync({ id: memory.id, update: { enabled: checked } })
                            .catch((error) => setFormError(errorText(error)))
                        }
                      />
                      <span>{t('settings:memoryEnabled')}</span>
                    </label>
                  </div>
                )}
                <p className={styles.memoryContent}>{memory.content}</p>
                <div className={styles.actionRow}>
                  <Button
                    variant={editing ? 'primary' : 'default'}
                    onClick={() => (editing ? void submitUpdate(memory) : beginEdit(memory))}
                    disabled={busy}
                  >
                    {editing ? <FloppyDisk aria-hidden="true" /> : null}
                    {editing ? t('common:save') : t('common:edit')}
                  </Button>
                  {editing ? (
                    <Button onClick={resetDraft} disabled={busy}>
                      {t('common:cancel')}
                    </Button>
                  ) : null}
                  <Button variant="danger" onClick={() => requestDelete(memory)} disabled={busy}>
                    <Trash aria-hidden="true" />
                    {t('common:delete')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editingId === null ? (
        <div className={styles.memoryCreate} data-part="memory-create">
          <MemoryFormFields
            draft={draft}
            characters={characterRows}
            disabled={busy}
            onChange={setDraft}
          />
          <div className={styles.actionRow}>
            <Button variant="primary" onClick={() => void submitCreate()} disabled={busy}>
              <Plus aria-hidden="true" />
              {t('settings:addMemory')}
            </Button>
          </div>
        </div>
      ) : null}

      {formError ? (
        <p className={styles.inlineError} role="alert">
          {formError}
        </p>
      ) : null}

      <ConfirmActionDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('settings:deleteMemoryTitle')}
        description={t('settings:deleteMemoryDescription')}
        confirmLabel={t('common:delete')}
        busy={deleteMemory.isPending}
        danger
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}

interface MemoryFormFieldsProps {
  draft: MemoryDraft;
  characters: ReadonlyArray<{ id: string; name: string }>;
  disabled: boolean;
  onChange: (draft: MemoryDraft) => void;
}

function MemoryFormFields({ draft, characters, disabled, onChange }: MemoryFormFieldsProps) {
  const { t } = useTranslation();
  return (
    <>
      <label className={styles.field}>
        <span>{t('settings:memoryContent')}</span>
        <textarea
          className={styles.memoryTextarea}
          value={draft.content}
          maxLength={100000}
          placeholder={t('settings:memoryPlaceholder')}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, content: event.target.value })}
        />
      </label>
      <label className={styles.field}>
        <span>{t('settings:memoryKeys')}</span>
        <input
          value={draft.keys}
          maxLength={2000}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, keys: event.target.value })}
        />
      </label>
      <div className={styles.controlGrid} data-part="memory-scope">
        <label className={styles.field}>
          <span>{t('settings:memoryScope')}</span>
          <select
            value={draft.scope}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...draft,
                scope: event.target.value as MemoryScope,
                characterId: event.target.value === 'global' ? '' : draft.characterId,
              })
            }
          >
            <option value="global">{t('settings:memoryScope_global')}</option>
            <option value="character">{t('settings:memoryScope_character')}</option>
          </select>
        </label>
        {draft.scope === 'character' ? (
          <label className={styles.field}>
            <span>{t('settings:memoryCharacter')}</span>
            <select
              value={draft.characterId}
              disabled={disabled}
              onChange={(event) => onChange({ ...draft, characterId: event.target.value })}
            >
              <option value="">{t('settings:memoryCharacterRequired')}</option>
              {characters.map((character) => (
                <option key={character.id} value={character.id}>
                  {character.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className={styles.checkboxField}>
          <Switch
            checked={draft.enabled}
            disabled={disabled}
            onCheckedChange={(checked) => onChange({ ...draft, enabled: checked })}
          />
          <span>{t('settings:memoryEnabled')}</span>
        </label>
      </div>
    </>
  );
}
