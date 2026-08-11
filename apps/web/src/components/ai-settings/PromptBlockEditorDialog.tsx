import {
  ArrowCounterClockwise,
  FloppyDisk,
  MapPin,
  SlidersHorizontal,
  TextT,
} from '@phosphor-icons/react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_PROMPT_TEMPLATE,
  PromptTriggerIds,
  isCorePromptBlockId,
  type PromptAuthoringRole,
  type PromptBlockSettings,
  type PromptTemplate,
  type PromptTriggerId,
} from '@neotavern/contracts';
import { Button, ModelMenu, SelectField, Switch, TextArea, TextField, cx } from '@neotavern/ui';
import { useDiscoverProviderModels, useSettings } from '../../api/hooks.js';
import { SurfaceDialog } from '../SurfaceDialog.js';
import styles from './PromptBlockEditorDialog.module.css';

export interface PromptBlockEditorDialogProps {
  block: PromptBlockSettings | null;
  template: PromptTemplate;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSave(block: PromptBlockSettings): void;
}

export function PromptBlockEditorDialog({
  block,
  template,
  open,
  onOpenChange,
  onSave,
}: PromptBlockEditorDialogProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<PromptBlockSettings | null>(null);
  const settings = useSettings();
  const discoverModels = useDiscoverProviderModels();
  const activeProviderId = settings.data?.activeProviderConfigId ?? null;
  const discoveredModels = discoverModels.data?.models ?? [];
  const loadModels = (): void => {
    if (activeProviderId === null) return;
    void discoverModels.mutateAsync(activeProviderId).catch(() => undefined);
  };

  useEffect(() => {
    setDraft(block ? toEditorDraft(block, template) : null);
  }, [block, template]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!draft || draft.name?.trim().length === 0) return;
    onSave({ ...draft, name: draft.name?.trim() });
  };

  const resetDraft = (): void => {
    if (!block) return;
    const defaultBlock = DEFAULT_PROMPT_TEMPLATE.blocks.find(
      (candidate) => candidate.id === block.id,
    );
    if (defaultBlock) {
      setDraft(
        toEditorDraft(
          { ...defaultBlock },
          {
            ...template,
            postHistoryInstructions:
              block.id === 'post-history-instructions'
                ? DEFAULT_PROMPT_TEMPLATE.postHistoryInstructions
                : template.postHistoryInstructions,
          },
        ),
      );
      return;
    }
    setDraft(toEditorDraft(block, template));
  };

  const toggleTrigger = (trigger: PromptTriggerId): void => {
    if (!draft) return;
    const current = draft.triggers ?? [...PromptTriggerIds];
    const next = current.includes(trigger)
      ? current.filter((value) => value !== trigger)
      : [...current, trigger];
    setDraft({
      ...draft,
      triggers: next.length > 0 ? next : [...PromptTriggerIds],
    });
  };

  const contentEditable =
    draft !== null &&
    (!isCorePromptBlockId(draft.id) ||
      draft.id === 'main-prompt' ||
      draft.id === 'post-history-instructions');
  const source =
    draft && isCorePromptBlockId(draft.id)
      ? t(`settings:promptSource_${draft.id}`)
      : t('settings:promptSource_template');
  const blockTitle = draft ? draft.name?.trim() || fallbackBlockName(draft, t) : '';
  const selectedTriggers = draft?.triggers ?? [...PromptTriggerIds];
  const inChat = draft?.injectionPosition === 'in-chat';

  return (
    <SurfaceDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('settings:editPromptTitle')}
      surface="prompt-block-editor"
    >
      {draft ? (
        <form className={styles.page} data-component="prompt-block-editor" onSubmit={submit}>
          <header className={styles.header}>
            <div>
              <span>{t('settings:editPromptEyebrow')}</span>
              <h1>{blockTitle || t('settings:editPromptTitle')}</h1>
              <p>{t('settings:editPromptSubtitle')}</p>
            </div>
            <div className={styles.headerActions}>
              <Button type="button" onClick={resetDraft}>
                <ArrowCounterClockwise aria-hidden="true" />
                {t('common:reset')}
              </Button>
              <Button type="submit" variant="primary">
                <FloppyDisk aria-hidden="true" />
                {t('common:save')}
              </Button>
            </div>
          </header>

          <div className={styles.body}>
            <section className={styles.panel} data-part="identity">
              <div className={styles.panelHeading}>
                <SlidersHorizontal weight="duotone" aria-hidden="true" />
                <div>
                  <strong>{t('settings:editPromptIdentityTitle')}</strong>
                  <p>{t('settings:editPromptIdentityHint')}</p>
                </div>
              </div>
              <div className={styles.identityGrid}>
                <TextField
                  label={t('common:name')}
                  description={t('settings:promptNameHint')}
                  required
                  maxLength={500}
                  value={draft.name ?? fallbackBlockName(draft, t)}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
                <SelectField
                  label={t('settings:role')}
                  description={t('settings:promptRoleHint')}
                  value={draft.role ?? 'system'}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      role: event.target.value as PromptAuthoringRole,
                    })
                  }
                >
                  <option value="system">{t('settings:role_system')}</option>
                  <option value="user">{t('settings:role_user')}</option>
                  <option value="assistant">{t('settings:role_assistant')}</option>
                </SelectField>
              </div>
              <div data-component="field" className={styles.triggers}>
                <span data-component="field-label" id="prompt-block-triggers-label">
                  {t('settings:triggers')}
                </span>
                <div
                  className={styles.triggerList}
                  role="group"
                  aria-labelledby="prompt-block-triggers-label"
                >
                  {PromptTriggerIds.map((trigger) => {
                    const pressed = selectedTriggers.includes(trigger);
                    return (
                      <button
                        key={trigger}
                        type="button"
                        className={styles.triggerChip}
                        aria-pressed={pressed}
                        data-state={pressed ? 'on' : 'off'}
                        onClick={() => toggleTrigger(trigger)}
                      >
                        {t(`settings:promptTrigger_${trigger}`)}
                      </button>
                    );
                  })}
                </div>
                <span data-component="field-description">{t('settings:promptTriggersHint')}</span>
              </div>
            </section>

            <section className={styles.panel} data-part="placement">
              <div className={styles.panelHeading}>
                <MapPin weight="duotone" aria-hidden="true" />
                <div>
                  <strong>{t('settings:editPromptPlacementTitle')}</strong>
                  <p>{t('settings:editPromptPlacementHint')}</p>
                </div>
              </div>
              <div className={styles.placementGrid} data-cols={inChat ? '3' : '2'}>
                <SelectField
                  label={t('settings:position')}
                  description={t('settings:promptPositionHint')}
                  value={draft.injectionPosition ?? 'relative'}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      injectionPosition: event.target.value as 'relative' | 'in-chat',
                    })
                  }
                >
                  <option value="relative">{t('settings:position_relative')}</option>
                  <option value="in-chat">{t('settings:position_inChat')}</option>
                </SelectField>

                {inChat ? (
                  <>
                    <TextField
                      label={t('settings:depth')}
                      description={t('settings:promptDepthHint')}
                      type="number"
                      min={0}
                      max={9999}
                      value={draft.injectionDepth ?? 4}
                      onChange={(event) =>
                        setDraft({ ...draft, injectionDepth: Number(event.target.value) })
                      }
                    />
                    <TextField
                      label={t('settings:order')}
                      description={t('settings:promptOrderHint')}
                      type="number"
                      min={0}
                      max={9999}
                      value={draft.injectionOrder ?? 100}
                      onChange={(event) =>
                        setDraft({ ...draft, injectionOrder: Number(event.target.value) })
                      }
                    />
                  </>
                ) : null}

                <div
                  className={styles.modelField}
                  data-part="model-binding"
                  data-span={inChat ? 'full' : 'cell'}
                >
                  <span data-component="field-label">{t('settings:promptModel')}</span>
                  <ModelMenu
                    options={discoveredModels.map((model) => ({
                      value: model.id,
                      label: model.name,
                      contextLimit: model.contextLimit,
                    }))}
                    value={draft.model ?? ''}
                    onValueChange={(model) =>
                      setDraft({
                        ...draft,
                        model: model.trim().length > 0 ? model.trim() : undefined,
                      })
                    }
                    onLoadModels={loadModels}
                    loading={discoverModels.isPending}
                    disabled={activeProviderId === null}
                    aria-label={t('settings:promptModel')}
                    placeholder={t('settings:promptModelPlaceholder')}
                    loadLabel={t('settings:loadModels')}
                    emptyText={t('settings:promptModelEmpty')}
                    noResultsText={t('settings:promptModelNoResults')}
                    hint={
                      activeProviderId === null
                        ? t('settings:promptModelNoProvider')
                        : discoverModels.isError
                          ? t('settings:promptModelDiscoveryUnavailable')
                          : discoveredModels.length > 0
                            ? t('settings:promptModelLoaded', { count: discoveredModels.length })
                            : t('settings:promptModelHint')
                    }
                    hintTone={discoverModels.isError ? 'error' : 'default'}
                  />
                </div>
              </div>
            </section>

            <section className={cx(styles.panel, styles.contentPanel)} data-part="content">
              <div className={styles.contentHeader}>
                <div className={styles.panelHeading}>
                  <TextT weight="duotone" aria-hidden="true" />
                  <div>
                    <strong>{t('settings:editPromptContentTitle')}</strong>
                    <p>{t('settings:editPromptContentHint')}</p>
                  </div>
                </div>
                {contentEditable && (draft.role ?? 'system') === 'system' ? (
                  <label className={styles.forbidOverrides}>
                    <Switch
                      checked={draft.forbidOverrides ?? false}
                      onCheckedChange={(checked) =>
                        setDraft({ ...draft, forbidOverrides: checked })
                      }
                    />
                    <span>{t('settings:forbidOverrides')}</span>
                  </label>
                ) : null}
              </div>

              {contentEditable ? (
                <div className={styles.contentField}>
                  <TextArea
                    id="prompt-block-editor-content"
                    className={styles.textarea}
                    label={t('settings:prompt')}
                    value={draft.content ?? ''}
                    placeholder={t('settings:promptContentPlaceholder')}
                    onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                  />
                </div>
              ) : (
                <div className={styles.externalSource} data-part="external-prompt-source">
                  <TextT weight="duotone" aria-hidden="true" />
                  <strong>{t('settings:externalPromptContent')}</strong>
                  <span>
                    {t('settings:source')}: {source}
                  </span>
                </div>
              )}
            </section>
          </div>
        </form>
      ) : null}
    </SurfaceDialog>
  );
}

function toEditorDraft(block: PromptBlockSettings, template: PromptTemplate): PromptBlockSettings {
  return {
    ...block,
    role: block.role ?? 'system',
    injectionPosition: block.injectionPosition ?? 'relative',
    injectionDepth: block.injectionDepth ?? 4,
    injectionOrder: block.injectionOrder ?? 100,
    triggers: block.triggers ? [...block.triggers] : [...PromptTriggerIds],
    forbidOverrides: block.forbidOverrides ?? false,
    ...(block.id === 'post-history-instructions'
      ? { content: template.postHistoryInstructions }
      : {}),
  };
}

function fallbackBlockName(block: PromptBlockSettings, t: (key: string) => string): string {
  return isCorePromptBlockId(block.id)
    ? t(`settings:promptBlock_${block.id}`)
    : t('settings:customPrompt');
}
