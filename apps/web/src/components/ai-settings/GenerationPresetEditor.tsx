import {
  Copy,
  DownloadSimple,
  FloppyDisk,
  Pencil,
  Plus,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CONTEXT_TOKEN_DEFAULT,
  CONTEXT_TOKEN_DEFAULT_MAX,
  CONTEXT_TOKEN_MIN,
  CONTEXT_TOKEN_UNLOCKED_MAX,
  GENERATION_PARAMETER_BOUNDS,
  GenerationParameterIds,
  GenerationPresetDataSchema,
  ReasoningEfforts,
  validateSchema,
  type GenerationDefaults,
  type GenerationParameterId,
  type GenerationPresetData,
  type Preset,
  type ProviderConfig,
  type ProviderCatalogEntry,
} from '@neotavern/contracts';
import { Button, Switch } from '@neotavern/ui';
import {
  useCreatePreset,
  useDeletePreset,
  usePresets,
  useProviderCatalog,
  useProviders,
  useSettings,
  useUpdatePreset,
  useUpdateSettings,
} from '../../api/hooks.js';
import { useErrorText } from '../../lib/useErrorText.js';
import { ConfirmActionDialog } from '../ConfirmActionDialog.js';
import styles from './AiSettings.module.css';

const DEFAULT_GENERATION_DATA: GenerationPresetData = {
  maxContextTokens: CONTEXT_TOKEN_DEFAULT,
  generationDefaults: {
    maxTokens: 2048,
    temperature: 0.8,
    topP: 1,
    topK: 0,
    minP: 0,
    topA: 0,
    repetitionPenalty: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    seed: -1,
    reasoning: false,
    stream: true,
  },
};

type NumericGenerationKey =
  'maxTokens' | Exclude<GenerationParameterId, 'reasoning' | 'reasoningEffort'>;

// Bounds come from the contracts table shared with the server schema (DUP-21);
// the id literals in GENERATION_PARAMETER_BOUNDS are exactly NumericGenerationKey.
const NUMERIC_PARAMETERS: ReadonlyArray<{
  id: NumericGenerationKey;
  label: string;
  min: number;
  max: number;
  step: number;
}> = GENERATION_PARAMETER_BOUNDS.map((bound) => ({ ...bound, label: bound.id }));

type NameMode = 'create' | 'rename' | 'duplicate' | null;

export function GenerationPresetEditor() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const reasoningEffortHintId = useId();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const providers = useProviders();
  const catalog = useProviderCatalog();
  const presets = usePresets('generation');
  const createPreset = useCreatePreset();
  const updatePreset = useUpdatePreset();
  const deletePreset = useDeletePreset();
  const [draft, setDraft] = useState<GenerationPresetData>(DEFAULT_GENERATION_DATA);
  const [nameMode, setNameMode] = useState<NameMode>(null);
  const [presetName, setPresetName] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [unlockedContext, setUnlockedContext] = useState(
    () => draft.maxContextTokens > CONTEXT_TOKEN_DEFAULT_MAX,
  );
  const importInput = useRef<HTMLInputElement>(null);
  const contextMax = unlockedContext ? CONTEXT_TOKEN_UNLOCKED_MAX : CONTEXT_TOKEN_DEFAULT_MAX;
  const activePreset = presets.data?.items.find(
    (preset) => preset.id === settings.data?.activeGenerationPresetId,
  );
  const activeProvider = providers.data?.items.find(
    (provider) => provider.id === settings.data?.activeProviderConfigId,
  );
  const activeCatalog = resolveCatalogEntry(activeProvider, catalog.data?.items ?? []);
  const supportedParameters = useMemo(
    () => resolveSamplerSupport(activeProvider, activeCatalog),
    [activeCatalog, activeProvider],
  );
  const reasoningEfforts = resolveReasoningEfforts(activeCatalog);
  const busy =
    updateSettings.isPending ||
    createPreset.isPending ||
    updatePreset.isPending ||
    deletePreset.isPending;

  useEffect(() => {
    if (!settings.data) return;
    const loadedContextTokens = settings.data.maxContextTokens;
    setDraft({
      maxContextTokens: loadedContextTokens,
      generationDefaults: {
        ...DEFAULT_GENERATION_DATA.generationDefaults,
        ...settings.data.generationDefaults,
      },
    });
    setUnlockedContext(loadedContextTokens > CONTEXT_TOKEN_DEFAULT_MAX);
  }, [settings.data]);

  const setGenerationValue = <Key extends keyof GenerationDefaults>(
    key: Key,
    value: GenerationDefaults[Key],
  ): void => {
    setDraft((current) => ({
      ...current,
      generationDefaults: { ...current.generationDefaults, [key]: value },
    }));
  };

  const toggleUnlockedContext = (next: boolean): void => {
    setUnlockedContext(next);
    if (!next) {
      setDraft((current) => ({
        ...current,
        maxContextTokens: Math.min(current.maxContextTokens, CONTEXT_TOKEN_DEFAULT_MAX),
      }));
    }
  };

  const applyDraft = async (
    activeGenerationPresetId = settings.data?.activeGenerationPresetId ?? null,
  ): Promise<boolean> => {
    try {
      await updateSettings.mutateAsync({
        maxContextTokens: draft.maxContextTokens,
        generationDefaults: draft.generationDefaults,
        activeGenerationPresetId,
      });
      setFormError(null);
      return true;
    } catch (error) {
      setFormError(errorText(error));
      return false;
    }
  };

  const selectPreset = async (preset: Preset | undefined): Promise<void> => {
    if (!preset) {
      await updateSettings.mutateAsync({ activeGenerationPresetId: null });
      return;
    }
    const parsed = validateSchema(GenerationPresetDataSchema, preset.data);
    if (!parsed.ok) {
      setFormError(t('settings:invalidGenerationPreset'));
      return;
    }
    setDraft(parsed.value);
    try {
      await updateSettings.mutateAsync({
        maxContextTokens: parsed.value.maxContextTokens,
        generationDefaults: parsed.value.generationDefaults,
        activeGenerationPresetId: preset.id,
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
          kind: 'generation',
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
      await deletePreset.mutateAsync({ id: activePreset.id, kind: 'generation' });
      await updateSettings.mutateAsync({ activeGenerationPresetId: null });
      setDeleteOpen(false);
      setFormError(null);
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  const exportPreset = (): void => {
    const payload = JSON.stringify(
      { version: 1, kind: 'generation', name: activePreset?.name ?? 'generation', data: draft },
      null,
      2,
    );
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${activePreset?.name ?? 'generation'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importPreset = async (file: File): Promise<void> => {
    try {
      const raw: unknown = JSON.parse(await file.text());
      let candidate: unknown = raw;
      if (typeof raw === 'object' && raw !== null && 'data' in raw) {
        candidate = raw.data;
      }
      const parsed = validateSchema(GenerationPresetDataSchema, candidate);
      if (!parsed.ok) {
        setFormError(t('settings:invalidGenerationPreset'));
        return;
      }
      const importedName =
        typeof raw === 'object' && raw !== null && 'name' in raw && typeof raw.name === 'string'
          ? raw.name
          : file.name.replace(/\.json$/i, '');
      const created = await createPreset.mutateAsync({
        kind: 'generation',
        name: importedName,
        data: parsed.value,
      });
      setDraft(parsed.value);
      await updateSettings.mutateAsync({
        maxContextTokens: parsed.value.maxContextTokens,
        generationDefaults: parsed.value.generationDefaults,
        activeGenerationPresetId: created.id,
      });
      setFormError(null);
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      if (importInput.current) importInput.current.value = '';
    }
  };

  return (
    <section className={styles.generationEditor} data-component="generation-preset-editor">
      <div className={styles.sectionHeading}>
        <strong>{t('settings:generationPresets')}</strong>
        <span>{t('settings:generationPresetsHint')}</span>
      </div>

      <div className={styles.presetToolbar}>
        <label className={styles.field}>
          <span>{t('settings:generationPreset')}</span>
          <select
            value={activePreset?.id ?? ''}
            disabled={busy || presets.isLoading}
            onChange={(event) =>
              void selectPreset(
                presets.data?.items.find((preset) => preset.id === event.target.value),
              )
            }
          >
            <option value="">{t('settings:unsavedGenerationSettings')}</option>
            {(presets.data?.items ?? []).map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.iconActions}>
          <button type="button" onClick={() => void savePreset()} title={t('common:save')}>
            <FloppyDisk size={18} aria-hidden="true" />
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
            <Pencil size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => {
              setNameMode('duplicate');
              setPresetName(
                `${activePreset?.name ?? t('settings:generationPreset')} ${t('providers:copySuffix')}`,
              );
            }}
            title={t('common:duplicate')}
          >
            <Copy size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={!activePreset}
            onClick={() => setDeleteOpen(true)}
            title={t('common:delete')}
          >
            <Trash size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => importInput.current?.click()}
            title={t('common:import')}
          >
            <UploadSimple size={18} aria-hidden="true" />
          </button>
          <button type="button" onClick={exportPreset} title={t('common:export')}>
            <DownloadSimple size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      <input
        ref={importInput}
        type="file"
        accept="application/json,.json"
        hidden
        aria-label={t('settings:importGenerationPreset')}
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
            <Plus aria-hidden="true" />
            {t('common:save')}
          </Button>
          <Button onClick={() => setNameMode(null)}>{t('common:cancel')}</Button>
        </div>
      ) : null}

      <div className={styles.unlockRow} data-part="unlock-context">
        <label className={styles.checkboxField}>
          <Switch checked={unlockedContext} onCheckedChange={toggleUnlockedContext} />
          <span>{t('settings:unlockedContextSize')}</span>
        </label>
        <small className={styles.unlockHint}>{t('settings:unlockedContextSizeHint')}</small>
      </div>

      <div className={styles.controlGrid} data-part="generation-controls">
        <RangeField
          label={t('settings:contextSize')}
          value={draft.maxContextTokens}
          min={CONTEXT_TOKEN_MIN}
          max={contextMax}
          step={1}
          onChange={(value) => setDraft((current) => ({ ...current, maxContextTokens: value }))}
        />
        {NUMERIC_PARAMETERS.map((parameter) => {
          const samplerParameter = parameter.id === 'maxTokens' ? null : parameter.id;
          const supported =
            samplerParameter === null || supportedParameters.includes(samplerParameter);
          const value =
            draft.generationDefaults[parameter.id] ??
            DEFAULT_GENERATION_DATA.generationDefaults[parameter.id] ??
            0;
          return (
            <RangeField
              key={parameter.id}
              label={t(`settings:${parameter.label}`)}
              value={typeof value === 'number' ? value : 0}
              min={parameter.min}
              max={parameter.max}
              step={parameter.step}
              disabled={!supported}
              unsupportedHint={!supported ? t('settings:unsupportedSampler') : undefined}
              onChange={(next) => setGenerationValue(parameter.id, next)}
            />
          );
        })}

        {supportedParameters.includes('reasoning') ? (
          <label className={styles.checkboxField} data-state="supported">
            <Switch
              checked={draft.generationDefaults.reasoning ?? false}
              onCheckedChange={(checked) => setGenerationValue('reasoning', checked)}
            />
            <span>{t('settings:requestReasoning')}</span>
          </label>
        ) : null}

        {supportedParameters.includes('reasoningEffort') ? (
          <label className={styles.field}>
            <span>{t('settings:reasoningEffort')}</span>
            <select
              aria-label={t('settings:reasoningEffort')}
              aria-describedby={reasoningEffortHintId}
              value={draft.generationDefaults.reasoningEffort ?? ''}
              onChange={(event) =>
                setGenerationValue(
                  'reasoningEffort',
                  event.target.value === ''
                    ? undefined
                    : (event.target.value as NonNullable<GenerationDefaults['reasoningEffort']>),
                )
              }
            >
              <option value="">{t('settings:reasoningEffort_default')}</option>
              {reasoningEfforts.map((effort) => (
                <option key={effort} value={effort}>
                  {t(`settings:reasoningEffort_${effort}`)}
                </option>
              ))}
            </select>
            <small id={reasoningEffortHintId}>{t('settings:reasoningEffortHint')}</small>
          </label>
        ) : null}

        <label className={styles.checkboxField}>
          <Switch
            checked={draft.generationDefaults.stream ?? true}
            onCheckedChange={(checked) => setGenerationValue('stream', checked)}
          />
          <span>{t('settings:streaming')}</span>
        </label>
      </div>

      {formError ? (
        <p className={styles.inlineError} role="alert">
          {formError}
        </p>
      ) : null}

      <div className={styles.actionRow}>
        <Button variant="primary" onClick={() => void applyDraft()} disabled={busy}>
          {t('settings:applyGenerationSettings')}
        </Button>
      </div>

      <ConfirmActionDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('settings:deleteGenerationPresetTitle')}
        description={t('settings:deleteGenerationPresetDescription', {
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

interface RangeFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  unsupportedHint?: string;
  onChange: (value: number) => void;
}

function RangeField({
  label,
  value,
  min,
  max,
  step,
  disabled = false,
  unsupportedHint,
  onChange,
}: RangeFieldProps) {
  const isInteger = Number.isInteger(step);
  const [text, setText] = useState(() => (isInteger ? String(value) : value.toFixed(2)));

  useEffect(() => {
    setText(isInteger ? String(value) : value.toFixed(2));
  }, [value, isInteger]);

  const clamp = (next: number): number => {
    if (Number.isNaN(next)) return value;
    const stepped = Math.round((next - min) / step) * step + min;
    return Math.min(max, Math.max(min, Number(stepped.toFixed(10))));
  };

  const commit = (): void => {
    const next = clamp(Number(text));
    setText(isInteger ? String(next) : next.toFixed(2));
    if (next !== value) onChange(next);
  };

  return (
    <label className={styles.rangeField} data-state={disabled ? 'unsupported' : 'supported'}>
      <span className={styles.rangeHeader}>
        <span>{label}</span>
        <input
          className={styles.rangeValue}
          type="number"
          inputMode={isInteger ? 'numeric' : 'decimal'}
          value={text}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          aria-label={label}
          onChange={(event) => {
            setText(event.target.value);
            const parsed = Number(event.target.value);
            if (Number.isFinite(parsed)) onChange(clamp(parsed));
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
              event.currentTarget.blur();
            }
          }}
        />
      </span>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {unsupportedHint ? <small className={styles.unsupportedHint}>{unsupportedHint}</small> : null}
    </label>
  );
}

function resolveCatalogEntry(
  provider: ProviderConfig | undefined,
  catalog: readonly ProviderCatalogEntry[],
): ProviderCatalogEntry | undefined {
  if (!provider) return undefined;
  const source = provider.settings['source'];
  if (typeof source === 'string') return catalog.find((entry) => entry.id === source);
  if (provider.kind === 'openai-compatible') {
    return catalog.find((entry) => entry.id === 'openai-compatible');
  }
  if (provider.kind === 'anthropic') return catalog.find((entry) => entry.id === 'anthropic');
  return undefined;
}

function resolveSamplerSupport(
  provider: ProviderConfig | undefined,
  catalogEntry: ProviderCatalogEntry | undefined,
): readonly GenerationParameterId[] {
  if (!provider || !catalogEntry) return GenerationParameterIds;
  if (
    catalogEntry.id === 'openai-compatible' &&
    provider.settings['source'] !== undefined &&
    provider.settings['samplerCompatibility'] !== 'extended'
  ) {
    return ['temperature', 'topP'];
  }
  return catalogEntry.samplerSupport;
}

function resolveReasoningEfforts(
  catalogEntry: ProviderCatalogEntry | undefined,
): readonly NonNullable<GenerationDefaults['reasoningEffort']>[] {
  return catalogEntry?.reasoningEfforts ?? ReasoningEfforts;
}
