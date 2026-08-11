import {
  ArrowDown,
  ArrowUp,
  Asterisk,
  Copy,
  DotsSixVertical,
  DownloadSimple,
  FloppyDisk,
  LinkBreak,
  LockSimple,
  NoteBlank,
  PencilSimple,
  Plus,
  PushPin,
  ToggleLeft,
  ToggleRight,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_PROMPT_TEMPLATE,
  PromptTemplateSchema,
  PromptTriggerIds,
  hasCompletePromptBlockOrder,
  isCorePromptBlockId,
  isTerminalPromptBlockId,
  normalizePromptBlockOrder,
  validateSchema,
  type Preset,
  type PromptBlockSettings,
  type PromptContextAudit,
  type PromptTemplate,
} from '@neotavern/contracts';
import { Button, useRowGestures } from '@neotavern/ui';
import {
  useCreatePreset,
  useDeletePreset,
  usePresets,
  usePromptContextAudit,
  useSettings,
  useUpdatePreset,
  useUpdateSettings,
} from '../../api/hooks.js';
import { useErrorText } from '../../lib/useErrorText.js';
import { ConfirmActionDialog } from '../ConfirmActionDialog.js';
import { PromptBlockEditorDialog } from './PromptBlockEditorDialog.js';
import styles from './AiSettings.module.css';

type NameMode = 'create' | 'rename' | 'duplicate' | null;

export function PromptTemplateEditor() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const presets = usePresets('prompt-template');
  const createPreset = useCreatePreset();
  const updatePreset = useUpdatePreset();
  const deletePreset = useDeletePreset();
  const [draft, setDraft] = useState<PromptTemplate>(() => cloneDefaultTemplate());
  const draftBlocksRef = useRef<PromptBlockSettings[]>(draft.blocks);
  const [nameMode, setNameMode] = useState<NameMode>(null);
  const [presetName, setPresetName] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const draggedBlockIdRef = useRef<string | null>(null);
  const draggedNameRef = useRef('');
  const hydratingDraftRef = useRef(false);
  const persistedDraftRef = useRef<string | null>(null);
  const lastHydratedSettingsRef = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const activePreset = presets.data?.items.find(
    (preset) => preset.id === settings.data?.activePromptTemplatePresetId,
  );
  const promptAudit = usePromptContextAudit(currentChatId());
  const busy =
    updateSettings.isPending ||
    createPreset.isPending ||
    updatePreset.isPending ||
    deletePreset.isPending;
  const editingBlock = draft.blocks.find((block) => block.id === editingBlockId) ?? null;
  const tokenSummary = useMemo(
    () => summarizeTokens(draft, promptAudit.data?.audit ?? null),
    [draft, promptAudit.data?.audit],
  );

  useEffect(() => {
    // Never hydrate while a block editor dialog is open: the in-flight
    // settings refetch (e.g. from the mode switch) would swap `template`
    // mid-edit and wipe the dialog draft. Also skip refetches that only echo
    // a save we already sent (applying stale server state would clobber newer
    // local edits) and snapshots that are not newer than the last hydration
    // (e.g. a failed refetch left an outdated snapshot behind).
    if (!settings.data || editingBlockId !== null || draggedBlockIdRef.current !== null) {
      return;
    }
    const next = normalizeTemplate({ ...settings.data.promptTemplate, mode: 'text' });
    const nextSerialized = JSON.stringify(next);
    if (
      lastHydratedSettingsRef.current === nextSerialized ||
      (persistedDraftRef.current !== null && persistedDraftRef.current === nextSerialized)
    ) {
      return;
    }
    lastHydratedSettingsRef.current = nextSerialized;
    hydratingDraftRef.current = true;
    persistedDraftRef.current = nextSerialized;
    setDraft(next);
  }, [settings.data, editingBlockId]);

  useEffect(() => {
    draftBlocksRef.current = draft.blocks;
  }, [draft.blocks]);

  // --- Shared row gestures --------------------------------
  // Dragging is immediate (no travel threshold) from the dedicated handle.
  // The core recognition (@neotavern/gestures) prevents native drag/scroll and
  // resolves the drop row through `data-prompt-index`; the editor only maps
  // the events onto its optimistic reorder + screen-reader announcement.

  const { draggedIndex, setDraggedIndex, handlers } = useRowGestures({
    indexAttribute: 'data-prompt-index',
    mouseDragThresholdPx: 0,
    touchDragThresholdPx: 0,
    longPressMs: null,
    canDrag: (blockId) => !isTerminalPromptBlockId(blockId),
    onDragStart: (blockId) => {
      draggedBlockIdRef.current = blockId;
      const block = draftBlocksRef.current.find((candidate) => candidate.id === blockId);
      draggedNameRef.current = block ? blockName(block) : blockId;
    },
    onDragMove: (_blockId, toIndex) => previewBlockAtIndex(toIndex),
    onDragEnd: (blockId, committed) => {
      if (committed) {
        const position = draftBlocksRef.current.findIndex((block) => block.id === blockId) + 1;
        if (position > 0) {
          setAnnouncement(
            t('settings:promptBlockMoved', {
              block: draggedNameRef.current,
              position,
            }),
          );
        }
      }
      draggedBlockIdRef.current = null;
      draggedNameRef.current = '';
    },
  });

  useEffect(() => {
    if (hydratingDraftRef.current) {
      hydratingDraftRef.current = false;
      return;
    }
    const serialized = JSON.stringify(draft);
    if (
      persistedDraftRef.current === null ||
      persistedDraftRef.current === serialized ||
      draggedIndex !== null
    ) {
      return;
    }
    const timeout = window.setTimeout(() => {
      updateSettings.mutate(
        { promptTemplate: draft },
        {
          onSuccess: () => {
            persistedDraftRef.current = serialized;
            setFormError(null);
          },
          onError: (error) => setFormError(errorText(error)),
        },
      );
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [draft, draggedIndex, errorText, updateSettings.mutate]);

  const blockName = (block: PromptBlockSettings): string =>
    block.name ??
    (isCorePromptBlockId(block.id)
      ? t(`settings:promptBlock_${block.id}`)
      : t('settings:customPrompt'));

  const moveBlock = (from: number, to: number): void => {
    setDraft((current) => {
      if (from === to || to < 0 || to >= current.blocks.length) return current;
      const moved = current.blocks[from];
      if (!moved) return current;
      const blocks = reorderBlocks(current.blocks, from, to);
      const actualPosition = blocks.findIndex((block) => block.id === moved.id);
      if (actualPosition === from) return current;
      draftBlocksRef.current = blocks;
      setAnnouncement(
        t('settings:promptBlockMoved', {
          block: blockName(moved),
          position: actualPosition + 1,
        }),
      );
      return { ...current, blocks };
    });
  };

  const previewBlockAtIndex = (to: number): void => {
    const draggedBlockId = draggedBlockIdRef.current;
    if (!draggedBlockId) return;
    const currentBlocks = draftBlocksRef.current;
    const from = currentBlocks.findIndex((block) => block.id === draggedBlockId);
    if (from < 0 || from === to) return;
    const moved = currentBlocks[from];
    if (!moved || isTerminalPromptBlockId(moved.id)) return;
    const blocks = reorderBlocks(currentBlocks, from, to);
    const actualPosition = blocks.findIndex((block) => block.id === draggedBlockId);
    if (actualPosition === from) return;
    draftBlocksRef.current = blocks;
    setDraft((current) => ({ ...current, blocks }));
    setDraggedIndex(actualPosition);
  };

  const applyDraft = async (
    activePromptTemplatePresetId = settings.data?.activePromptTemplatePresetId ?? null,
  ): Promise<boolean> => {
    try {
      await updateSettings.mutateAsync({
        promptTemplate: draft,
        activePromptTemplatePresetId,
      });
      persistedDraftRef.current = JSON.stringify(draft);
      setFormError(null);
      return true;
    } catch (error) {
      setFormError(errorText(error));
      return false;
    }
  };

  const selectPreset = async (preset: Preset | undefined): Promise<void> => {
    if (!preset) {
      await updateSettings.mutateAsync({ activePromptTemplatePresetId: null });
      return;
    }
    const parsed = validateSchema(PromptTemplateSchema, preset.data);
    if (!parsed.ok) {
      setFormError(t('settings:invalidPromptTemplatePreset'));
      return;
    }
    const next = normalizeTemplate({ ...parsed.value, mode: 'text' });
    if (!hasCompletePromptBlockOrder(next)) {
      setFormError(t('settings:invalidPromptTemplatePreset'));
      return;
    }
    setDraft(next);
    try {
      await updateSettings.mutateAsync({
        promptTemplate: next,
        activePromptTemplatePresetId: preset.id,
      });
      setFormError(null);
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  const savePreset = async (): Promise<void> => {
    if (!activePreset) {
      setNameMode('create');
      setPresetName('');
      return;
    }
    try {
      await updatePreset.mutateAsync({ id: activePreset.id, update: { data: draft } });
      await applyDraft(activePreset.id);
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  const submitNameAction = async (): Promise<void> => {
    const name = presetName.trim();
    if (!name || !nameMode) {
      setFormError(t('validation:required'));
      return;
    }
    try {
      if (nameMode === 'rename' && activePreset) {
        await updatePreset.mutateAsync({ id: activePreset.id, update: { name } });
      } else {
        const created = await createPreset.mutateAsync({
          kind: 'prompt-template',
          name,
          data: draft,
        });
        await applyDraft(created.id);
      }
      setNameMode(null);
      setPresetName('');
      setFormError(null);
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!activePreset) return;
    try {
      await deletePreset.mutateAsync({ id: activePreset.id, kind: 'prompt-template' });
      await updateSettings.mutateAsync({ activePromptTemplatePresetId: null });
      setDeleteOpen(false);
      setFormError(null);
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  const exportPreset = (): void => {
    const payload = JSON.stringify(
      { version: 1, kind: 'prompt-template', name: activePreset?.name ?? 'prompt', data: draft },
      null,
      2,
    );
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${activePreset?.name ?? 'prompt-template'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importPreset = async (file: File): Promise<void> => {
    try {
      const raw: unknown = JSON.parse(await file.text());
      let candidate: unknown = raw;
      if (typeof raw === 'object' && raw !== null && 'data' in raw) candidate = raw.data;
      const parsed = validateSchema(PromptTemplateSchema, candidate);
      if (!parsed.ok) {
        setFormError(t('settings:invalidPromptTemplatePreset'));
        return;
      }
      const importedName =
        typeof raw === 'object' && raw !== null && 'name' in raw && typeof raw.name === 'string'
          ? raw.name
          : file.name.replace(/\.json$/i, '');
      const next = normalizeTemplate({ ...parsed.value, mode: 'text' });
      if (!hasCompletePromptBlockOrder(next)) {
        setFormError(t('settings:invalidPromptTemplatePreset'));
        return;
      }
      const created = await createPreset.mutateAsync({
        kind: 'prompt-template',
        name: importedName,
        data: next,
      });
      setDraft(next);
      await updateSettings.mutateAsync({
        promptTemplate: next,
        activePromptTemplatePresetId: created.id,
      });
      setFormError(null);
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      if (importInput.current) importInput.current.value = '';
    }
  };

  const toggleBlock = (blockId: string): void => {
    setDraft((current) => ({
      ...current,
      blocks: current.blocks.map((block) =>
        block.id === blockId ? { ...block, enabled: !block.enabled } : block,
      ),
    }));
  };

  const addPrompt = (): void => {
    const id = `custom-${crypto.randomUUID()}` as const;
    const prompt: PromptBlockSettings = {
      id,
      enabled: true,
      name: t('settings:newPrompt'),
      role: 'system',
      content: '',
      injectionPosition: 'relative',
      injectionDepth: 4,
      injectionOrder: 100,
      triggers: [...PromptTriggerIds],
      forbidOverrides: false,
    };
    setDraft((current) => ({
      ...current,
      blocks: normalizePromptBlockOrder([...current.blocks, prompt]),
    }));
    setEditingBlockId(id);
  };

  const removePrompt = (blockId: string): void => {
    if (isCorePromptBlockId(blockId)) return;
    setDraft((current) => ({
      ...current,
      blocks: current.blocks.filter((block) => block.id !== blockId),
    }));
    setEditingBlockId((current) => (current === blockId ? null : current));
  };

  const saveBlock = (nextBlock: PromptBlockSettings): void => {
    setDraft((current) => ({
      ...current,
      postHistoryInstructions:
        nextBlock.id === 'post-history-instructions'
          ? (nextBlock.content ?? '')
          : current.postHistoryInstructions,
      blocks: current.blocks.map((block) => (block.id === nextBlock.id ? nextBlock : block)),
    }));
    setEditingBlockId(null);
  };

  return (
    <section className={styles.templateEditor} data-component="prompt-template-editor">
      <div className={styles.sectionHeading}>
        <strong>{t('settings:promptTemplate')}</strong>
        <span>{t('settings:promptTemplateHint')}</span>
      </div>

      <div className={styles.presetToolbar}>
        <label className={styles.field}>
          <span>{t('settings:promptTemplatePreset')}</span>
          <select
            value={activePreset?.id ?? ''}
            disabled={busy || presets.isLoading}
            onChange={(event) =>
              void selectPreset(
                presets.data?.items.find((preset) => preset.id === event.target.value),
              )
            }
          >
            <option value="">{t('settings:unsavedPromptTemplate')}</option>
            {(presets.data?.items ?? []).map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.iconActions} data-part="prompt-preset-actions">
          <button type="button" onClick={() => void savePreset()} title={t('common:save')}>
            <FloppyDisk aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={!activePreset}
            onClick={() => {
              setNameMode('rename');
              setPresetName(activePreset?.name ?? '');
            }}
            title={t('common:rename')}
          >
            <PencilSimple aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => {
              setNameMode('duplicate');
              setPresetName(
                `${activePreset?.name ?? t('settings:promptTemplatePreset')} ${t('providers:copySuffix')}`,
              );
            }}
            title={t('common:duplicate')}
          >
            <Copy aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={!activePreset}
            onClick={() => setDeleteOpen(true)}
            title={t('common:delete')}
          >
            <Trash aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => importInput.current?.click()}
            title={t('common:import')}
          >
            <UploadSimple aria-hidden="true" />
          </button>
          <button type="button" onClick={exportPreset} title={t('common:export')}>
            <DownloadSimple aria-hidden="true" />
          </button>
        </div>
      </div>

      <input
        ref={importInput}
        type="file"
        accept="application/json,.json"
        hidden
        aria-label={t('settings:importPromptTemplate')}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importPreset(file);
        }}
      />

      {nameMode ? (
        <div className={styles.nameEditor} data-part="preset-name-editor">
          <label className={styles.field}>
            <span>{t(`settings:presetName_${nameMode}`)}</span>
            <input
              value={presetName}
              maxLength={500}
              autoFocus
              onChange={(event) => setPresetName(event.target.value)}
            />
          </label>
          <Button variant="primary" onClick={() => void submitNameAction()} disabled={busy}>
            <FloppyDisk aria-hidden="true" />
            {t('common:save')}
          </Button>
          <Button onClick={() => setNameMode(null)}>{t('common:cancel')}</Button>
        </div>
      ) : null}

      <div className={styles.promptManagerHeader} data-part="prompt-manager-header">
        <strong>{t('settings:prompts')}</strong>
        <output
          data-state={tokenSummary.approximate ? 'estimated' : 'exact'}
          title={
            tokenSummary.approximate
              ? t('settings:estimatedTokenCount')
              : t('settings:exactTokenCount')
          }
        >
          {t('settings:totalTokens')}: {tokenSummary.knownTotal}
          {tokenSummary.hasDynamic ? '+' : ''}
        </output>
      </div>

      <div className={styles.promptTable} data-part="prompt-block-list">
        <div className={styles.promptTableHead} aria-hidden="true">
          <span>{t('common:name')}</span>
          <span />
          <span>{t('settings:tokens')}</span>
        </div>
        <ol className={styles.promptBlockList}>
          {draft.blocks.map((block, index) => {
            const name = blockName(block);
            const tokenCount = tokenSummary.counts.get(block.id) ?? null;
            const isCustom = !isCorePromptBlockId(block.id);
            const hasFixedPosition = isTerminalPromptBlockId(block.id);
            const canMoveDown =
              !hasFixedPosition &&
              index < draft.blocks.length - 1 &&
              !isTerminalPromptBlockId(draft.blocks[index + 1]?.id ?? '');
            return (
              <li
                key={block.id}
                className={styles.promptBlock}
                data-state={block.enabled ? 'enabled' : 'disabled'}
                data-kind={isCustom ? 'custom' : 'marker'}
                data-dragging={draggedIndex === index ? 'true' : 'false'}
                data-fixed={hasFixedPosition ? 'true' : 'false'}
                data-prompt-index={index}
              >
                <button
                  type="button"
                  className={styles.dragHandle}
                  disabled={hasFixedPosition}
                  tabIndex={-1}
                  aria-label={
                    hasFixedPosition
                      ? t('settings:fixedPromptPosition', { name })
                      : t('settings:dragPrompt', { name })
                  }
                  title={
                    hasFixedPosition
                      ? t('settings:fixedPromptPosition', { name })
                      : t('settings:dragPrompt', { name })
                  }
                  {...handlers(block.id, index)}
                >
                  {hasFixedPosition ? (
                    <LockSimple aria-hidden="true" />
                  ) : (
                    <DotsSixVertical aria-hidden="true" />
                  )}
                </button>
                <button
                  type="button"
                  className={styles.promptToggle}
                  aria-pressed={block.enabled}
                  onClick={() => toggleBlock(block.id)}
                  title={
                    block.enabled
                      ? t('settings:disablePrompt', { name })
                      : t('settings:enablePrompt', { name })
                  }
                >
                  {block.enabled ? (
                    <ToggleRight aria-hidden="true" />
                  ) : (
                    <ToggleLeft aria-hidden="true" />
                  )}
                </button>
                <span className={styles.promptName}>
                  {isCustom ? (
                    <Asterisk className={styles.promptKindIcon} aria-hidden="true" />
                  ) : block.id === 'main-prompt' || block.id === 'post-history-instructions' ? (
                    <NoteBlank className={styles.promptKindIcon} aria-hidden="true" />
                  ) : (
                    <PushPin className={styles.promptKindIcon} aria-hidden="true" />
                  )}
                  <button type="button" onClick={() => setEditingBlockId(block.id)} title={name}>
                    <strong>{name}</strong>
                  </button>
                  {block.injectionPosition === 'in-chat' ? (
                    <small>@ {block.injectionDepth ?? 4}</small>
                  ) : null}
                </span>
                <span className={styles.promptRowControls}>
                  {isCustom ? (
                    <button
                      type="button"
                      onClick={() => removePrompt(block.id)}
                      title={t('settings:removePrompt', { name })}
                    >
                      <LinkBreak aria-hidden="true" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setEditingBlockId(block.id)}
                    title={t('settings:editPrompt', { name })}
                  >
                    <PencilSimple aria-hidden="true" />
                  </button>
                </span>
                <output
                  className={styles.promptTokens}
                  data-state={tokenCount === null ? 'dynamic' : 'known'}
                  aria-label={t('settings:promptTokenCount')}
                  title={
                    tokenCount === null
                      ? t('settings:dynamicTokenCount')
                      : tokenSummary.approximate
                        ? t('settings:estimatedTokenCount')
                        : t('settings:exactTokenCount')
                  }
                >
                  {tokenCount ?? '—'}
                </output>
                <span className={styles.keyboardMoveActions}>
                  <button
                    type="button"
                    disabled={hasFixedPosition || index === 0}
                    onClick={() => moveBlock(index, index - 1)}
                    title={t('settings:movePromptBlockUp', { block: name })}
                  >
                    <ArrowUp aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={!canMoveDown}
                    onClick={() => moveBlock(index, index + 1)}
                    title={t('settings:movePromptBlockDown', { block: name })}
                  >
                    <ArrowDown aria-hidden="true" />
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      <p className={styles.visuallyHidden} aria-live="polite">
        {announcement}
      </p>

      <div className={styles.promptManagerFooter}>
        <Button size="sm" onClick={addPrompt}>
          <Plus aria-hidden="true" />
          {t('settings:addPrompt')}
        </Button>
      </div>

      {formError ? (
        <p className={styles.inlineError} role="alert">
          {formError}
        </p>
      ) : null}

      <PromptBlockEditorDialog
        block={editingBlock}
        template={draft}
        open={editingBlock !== null}
        onOpenChange={(open) => {
          if (!open) setEditingBlockId(null);
        }}
        onSave={saveBlock}
      />

      <ConfirmActionDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('settings:deletePromptTemplateTitle')}
        description={t('settings:deletePromptTemplateDescription', {
          name: activePreset?.name ?? '',
        })}
        confirmLabel={t('common:delete')}
        busy={deletePreset.isPending}
        danger
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}

function knownBlockTokenCount(template: PromptTemplate, block: PromptBlockSettings): number | null {
  const content =
    block.id === 'post-history-instructions' ? template.postHistoryInstructions : block.content;
  if (content === undefined) return null;
  const trimmed = content.trim();
  return trimmed.length === 0 ? 0 : Math.max(1, Math.ceil(trimmed.length / 4));
}

function summarizeTokens(
  template: PromptTemplate,
  audit: PromptContextAudit | null,
): {
  knownTotal: number;
  hasDynamic: boolean;
  approximate: boolean;
  counts: Map<string, number>;
} {
  const auditedCounts = audit ? auditTokenCounts(template, audit) : new Map<string, number>();
  const counts = new Map<string, number>();
  let knownTotal = 0;
  let hasDynamic = false;
  for (const block of template.blocks) {
    const tokens = auditedCounts.get(block.id) ?? knownBlockTokenCount(template, block);
    if (tokens !== null) counts.set(block.id, tokens);
    if (!block.enabled) continue;
    if (tokens === null) hasDynamic = true;
    else knownTotal += tokens;
  }
  return {
    knownTotal,
    hasDynamic,
    approximate: audit === null || audit.tokenizer.approximate,
    counts,
  };
}

function auditTokenCounts(
  template: PromptTemplate,
  audit: PromptContextAudit,
): Map<string, number> {
  const blockIds = new Set<string>(template.blocks.map((block) => block.id));
  const counts = new Map<string, number>();
  for (const entry of audit.entries) {
    const identifierBlockId =
      entry.identifier.startsWith('template.') || entry.identifier.startsWith('block.')
        ? entry.identifier.slice(entry.identifier.indexOf('.') + 1)
        : null;
    const blockId =
      identifierBlockId && blockIds.has(identifierBlockId)
        ? identifierBlockId
        : entry.name && blockIds.has(entry.name)
          ? entry.name
          : null;
    if (!blockId) continue;
    counts.set(blockId, (counts.get(blockId) ?? 0) + entry.tokens);
  }
  return counts;
}

function normalizeTemplate(template: PromptTemplate): PromptTemplate {
  const defaults = new Map<string, PromptBlockSettings>(
    DEFAULT_PROMPT_TEMPLATE.blocks.map((block) => [block.id, block]),
  );
  const blocks = template.blocks.map((block) => {
    const fallback = defaults.get(block.id);
    const normalized = { ...fallback, ...block };
    return {
      ...normalized,
      ...(normalized.triggers ? { triggers: [...normalized.triggers] } : {}),
    };
  });
  return {
    ...template,
    blocks: normalizePromptBlockOrder(blocks),
  };
}

function cloneDefaultTemplate(): PromptTemplate {
  return normalizeTemplate({ ...DEFAULT_PROMPT_TEMPLATE, mode: 'text' });
}

function reorderBlocks(
  blocks: readonly PromptBlockSettings[],
  from: number,
  to: number,
): PromptBlockSettings[] {
  const normalized = normalizePromptBlockOrder(blocks);
  const moved = normalized[from];
  if (!moved || isTerminalPromptBlockId(moved.id)) return normalized;

  const target = normalized[to];
  const movable = normalized.filter((block) => !isTerminalPromptBlockId(block.id));
  const fromMovable = movable.findIndex((block) => block.id === moved.id);
  const targetMovable = target
    ? isTerminalPromptBlockId(target.id)
      ? movable.length - 1
      : movable.findIndex((block) => block.id === target.id)
    : fromMovable;
  const [removed] = movable.splice(fromMovable, 1);
  if (!removed || targetMovable < 0) return normalized;
  movable.splice(targetMovable, 0, removed);
  return normalizePromptBlockOrder([...movable, ...normalized.filter(isTerminalBlock)]);
}

function isTerminalBlock(block: PromptBlockSettings): boolean {
  return isTerminalPromptBlockId(block.id);
}

function currentChatId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return /^\/chats\/([^/]+)$/.exec(window.location.pathname)?.[1];
}
