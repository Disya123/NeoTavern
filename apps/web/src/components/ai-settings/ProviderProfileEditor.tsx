import { ArrowsClockwise, CheckCircle, Copy, Key, Plus, Trash } from '@phosphor-icons/react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  TextAdapterKinds,
  type LastServer,
  type PromptPostProcessingMode,
  type ProviderCatalogEntry,
  type ProviderConfig,
  type ProviderConfigCreate,
  type ProviderSourceId,
} from '@neotavern/contracts';
import { UnsupportedError } from '@neotavern/neobackend';
import { Button, ModelMenu, Switch } from '@neotavern/ui';
import {
  useCreateProvider,
  useDiscoverProviderModels,
  useDeleteProvider,
  useProviderCatalog,
  useProviderSecrets,
  useProviders,
  useSettings,
  useUpdateSecret,
  useUpdateProvider,
  useUpdateSettings,
} from '../../api/hooks.js';
import {
  parseAdditionalParams,
  serializeAdditionalParams,
  type AdditionalParamsValue,
} from '../../lib/additionalParams.js';
import { useErrorText } from '../../lib/useErrorText.js';
import { ApiKeysModal } from '../ApiKeysModal.js';
import { ConfirmActionDialog } from '../ConfirmActionDialog.js';
import styles from './AiSettings.module.css';

/** Post-processing modes offered in the select, in display order. */
const POST_PROCESSING_OPTIONS: readonly PromptPostProcessingMode[] = [
  '',
  'merge_tools',
  'semi_tools',
  'strict_tools',
  'merge',
  'semi',
  'strict',
  'single',
];

const EMPTY_ADDITIONAL_PARAMS: AdditionalParamsValue = {
  includeBody: '',
  excludeBody: '',
  includeHeaders: '',
};

/**
 * Top-level API selector (classic SillyTavern `main_api`): a backend is either a
 * Chat Completion source or a Text Completion source. Derived from the catalog
 * entry's `adapterKind` — text adapters are {@link TextAdapterKinds}, everything
 * else is a chat adapter. The Source ("API Type") select is filtered by this.
 */
type ApiMode = 'chat' | 'text';
const TEXT_KINDS = new Set<string>(TextAdapterKinds);
function apiModeForKind(adapterKind: string): ApiMode {
  return TEXT_KINDS.has(adapterKind) ? 'text' : 'chat';
}

interface ProviderDraft {
  id: string | null;
  source: ProviderSourceId | null;
  /** Top-level API mode the source belongs to (Chat vs Text Completions). */
  apiMode: ApiMode;
  kind: string;
  name: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  hasStoredApiKey: boolean;
  samplerCompatibility: 'standard' | 'extended';
  promptPostProcessing: PromptPostProcessingMode;
  additionalParams: AdditionalParamsValue;
  publicSettings: Record<string, unknown>;
}

export interface ProviderProfileEditorProps {
  surface?: 'panel' | 'page';
}

/** Shared write-only provider profile editor used by both provider surfaces. */
export function ProviderProfileEditor({ surface = 'panel' }: ProviderProfileEditorProps) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const providers = useProviders();
  const catalog = useProviderCatalog();
  const settings = useSettings();
  const createProvider = useCreateProvider();
  const updateProvider = useUpdateProvider();
  const deleteProvider = useDeleteProvider();
  const updateSettings = useUpdateSettings();
  const discoverModels = useDiscoverProviderModels();
  const updateSecret = useUpdateSecret();
  const [selectedId, setSelectedId] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState<ProviderDraft>(() => emptyDraft());
  const secrets = useProviderSecrets(draft.id ?? undefined);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'saved' | 'discovering' | 'ready' | 'error'>(
    'idle',
  );
  const initialized = useRef(false);
  const baseUrlHintId = useId();
  const catalogItems = catalog.data?.items ?? [];
  const catalogError = catalog.isError ? errorText(catalog.error) : null;
  const discoveredModels = discoverModels.data?.models ?? [];
  const selectedCatalog = draft.source
    ? catalogItems.find((entry) => entry.id === draft.source)
    : undefined;
  const activeSecretId = secrets.data?.items.find((secret) => secret.active)?.id ?? '';
  const hasActiveKey = draft.hasStoredApiKey || activeSecretId.length > 0;

  /**
   * Effective profile name. Like classic SillyTavern, the API tab does not force
   * the user to name a connection — the chosen source *is* the identity. A manual
   * name (page surface) wins when provided; otherwise the source label is used,
   * so pasting a key and saving never stalls on an empty Name field.
   */
  const resolvedName = (): string => {
    const typed = draft.name.trim();
    if (typed.length > 0) return typed;
    return draft.source ? t(`providers:source_${draft.source}`) : '';
  };
  const selectedProvider = providers.data?.items.find((provider) => provider.id === selectedId);
  const busy =
    createProvider.isPending ||
    updateProvider.isPending ||
    deleteProvider.isPending ||
    updateSettings.isPending;

  useEffect(() => {
    if (initialized.current || !providers.data || !catalog.data || !settings.data) return;
    const preferred =
      providers.data.items.find(
        (provider) => provider.id === settings.data.activeProviderConfigId,
      ) ?? providers.data.items[0];
    if (preferred) {
      setSelectedId(preferred.id);
      setDraft(fromProvider(preferred, catalog.data.items));
    } else {
      setSelectedId(null);
      setDraft(emptyDraft(catalog.data.items[0]));
    }
    initialized.current = true;
  }, [catalog.data, providers.data, settings.data]);

  const selectProfile = (id: string): void => {
    setFormError(null);
    if (id.length === 0) {
      setSelectedId(null);
      setDraft(emptyDraft(catalogItems[0]));
      setStatus('idle');
      return;
    }
    const provider = providers.data?.items.find((item) => item.id === id);
    if (!provider) return;
    setSelectedId(provider.id);
    setDraft(fromProvider(provider, catalogItems));
    setStatus('idle');
  };

  const persist = async (
    options: { allowMissingKey?: boolean } = {},
  ): Promise<ProviderConfig | null> => {
    const name = resolvedName();
    if (name.length === 0) {
      setFormError(t('validation:required'));
      return null;
    }
    if (selectedCatalog?.apiKeyRequired && !options.allowMissingKey && !hasActiveKey) {
      setFormError(t('providers:keyRequired'));
      return null;
    }
    if (
      selectedCatalog?.adapterKind === 'openai-compatible' &&
      !selectedCatalog.defaultBaseUrl &&
      draft.baseUrl.trim().length === 0
    ) {
      setFormError(t('providers:baseUrlRequired'));
      return null;
    }

    setFormError(null);
    const additional = parseAdditionalParams(draft.additionalParams);
    if (!additional.ok) {
      const first = additional.error[0];
      setFormError(first ? t(`providers:${first.messageKey}`) : t('validation:required'));
      return null;
    }
    const settingsPayload = draft.source
      ? {
          ...draft.publicSettings,
          source: draft.source,
          promptPostProcessing: draft.promptPostProcessing,
          ...additional.value,
          ...(draft.source === 'openai-compatible'
            ? { samplerCompatibility: draft.samplerCompatibility }
            : {}),
        }
      : draft.publicSettings;
    const common: ProviderConfigCreate = {
      kind: draft.kind,
      name,
      baseUrl: draft.baseUrl.trim() || null,
      model: draft.model.trim() || null,
      enabled: draft.enabled,
      settings: settingsPayload,
    };
    try {
      const saved = draft.id
        ? await updateProvider.mutateAsync({
            id: draft.id,
            update: common,
          })
        : await createProvider.mutateAsync(common);
      setSelectedId(saved.id);
      setDraft(fromProvider(saved, catalogItems));
      setStatus('saved');
      return saved;
    } catch (error) {
      setFormError(errorText(error));
      setStatus('error');
      return null;
    }
  };

  const connect = async (): Promise<void> => {
    const saved = await persist();
    if (!saved) return;
    try {
      const model = draft.model.trim();
      const lastServer: LastServer = {
        providerConfigId: saved.id,
        ...(draft.source ? { source: draft.source } : {}),
        ...(model ? { model } : {}),
      };
      await updateSettings.mutateAsync({ activeProviderConfigId: saved.id, lastServer });
      setStatus('discovering');
      await discoverModels.mutateAsync(saved.id);
      setStatus('ready');
    } catch (error) {
      if (error instanceof UnsupportedError) {
        // Model discovery has no wire operation yet — a kernel-side
        // capability (same honest boundary as the AutoConnectSync warm-up).
        // The connection itself already persisted above; keep 'saved' so the
        // panel does not report a failed connection for an optional warm-up.
        setStatus('saved');
        return;
      }
      setFormError(errorText(error));
      setStatus('error');
    }
  };

  /**
   * Persist the key (if any) and fetch `/v1/models` so the Model field becomes a
   * populated dropdown — SillyTavern's "available models" affordance, placed next
   * to the field instead of behind the far-away Connect button. Discovery needs a
   * saved credential for key-required sources, so this saves first.
   */
  const loadModels = async (): Promise<void> => {
    const saved = await persist();
    if (!saved) return;
    try {
      setStatus('discovering');
      await discoverModels.mutateAsync(saved.id);
      setStatus('saved');
    } catch (error) {
      if (error instanceof UnsupportedError) {
        // Optional warm-up, not part of the connection (see connect()).
        setStatus('saved');
        return;
      }
      setFormError(errorText(error));
      setStatus('error');
    }
  };

  /**
   * The key icon is the only keys control. For a new profile it first stores
   * the non-secret connection metadata, then opens the multi-key manager.
   * This avoids the old dead button and lets required-key sources be set up
   * through the manager instead of forcing a duplicate inline entry.
   */
  const openKeys = async (): Promise<void> => {
    if (draft.id) {
      setKeysOpen(true);
      return;
    }
    const saved = await persist({ allowMissingKey: true });
    if (saved) setKeysOpen(true);
  };

  const duplicate = (): void => {
    setSelectedId(null);
    setDraft({
      ...draft,
      id: null,
      name: `${draft.name} ${t('providers:copySuffix')}`.trim(),
      hasStoredApiKey: false,
    });
    setFormError(t('providers:duplicateKeyHint'));
    setStatus('idle');
  };

  const reset = (): void => {
    if (selectedProvider) setDraft(fromProvider(selectedProvider, catalogItems));
    else setDraft(emptyDraft(catalogItems[0]));
    setFormError(null);
    setStatus('idle');
  };

  const confirmDelete = async (): Promise<void> => {
    if (!draft.id) return;
    const deletingId = draft.id;
    try {
      await deleteProvider.mutateAsync(deletingId);
      if (settings.data?.activeProviderConfigId === deletingId) {
        await updateSettings.mutateAsync({ activeProviderConfigId: null });
      }
      setDeleteOpen(false);
      setSelectedId(null);
      setDraft(emptyDraft(catalogItems[0]));
      setStatus('idle');
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  const changeSource = (source: ProviderSourceId): void => {
    const entry = catalogItems.find((item) => item.id === source);
    if (!entry) return;
    setDraft((current) => ({
      ...current,
      source,
      apiMode: apiModeForKind(entry.adapterKind),
      kind: entry.adapterKind,
      baseUrl: entry.defaultBaseUrl ?? '',
      publicSettings: {},
      samplerCompatibility: 'standard',
      promptPostProcessing: '',
      additionalParams: EMPTY_ADDITIONAL_PARAMS,
    }));
    setStatus('idle');
  };

  /** Catalog sources belonging to a given top-level API mode. */
  const entriesForMode = (mode: ApiMode): ProviderCatalogEntry[] =>
    catalogItems.filter((entry) => apiModeForKind(entry.adapterKind) === mode);

  /**
   * Switch the top-level API (Chat/Text Completions) and reset the Source select
   * to the first source of that mode — mirrors SillyTavern's `main_api` behaviour
   * where changing the API repopulates the source list.
   */
  const changeApiMode = (mode: ApiMode): void => {
    const entries = entriesForMode(mode);
    const first = entries[0];
    if (!first) return;
    setDraft((current) => ({
      ...current,
      source: first.id,
      apiMode: mode,
      kind: first.adapterKind,
      baseUrl: first.defaultBaseUrl ?? '',
      publicSettings: {},
      samplerCompatibility: 'standard',
      promptPostProcessing: '',
      additionalParams: EMPTY_ADDITIONAL_PARAMS,
    }));
    setStatus('idle');
  };

  const setAutoConnect = (enabled: boolean): void => {
    void updateSettings.mutateAsync({ autoConnect: enabled });
  };

  const selectActiveKey = async (secretId: string): Promise<void> => {
    if (!draft.id || secretId.length === 0) return;
    try {
      await updateSecret.mutateAsync({
        providerId: draft.id,
        secretId,
        update: { active: true },
      });
      setFormError(null);
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  return (
    <section
      className={styles.providerEditor}
      data-component="provider-profile-editor"
      data-surface={surface}
    >
      <div className={styles.editorToolbar} data-part="profile-toolbar">
        <label className={styles.field}>
          <span>{t('providers:profile')}</span>
          <div className={styles.toolbarControlRow}>
            <select
              value={selectedId ?? ''}
              disabled={providers.isLoading || busy}
              onChange={(event) => selectProfile(event.target.value)}
            >
              <option value="">{t('providers:newProfile')}</option>
              {(providers.data?.items ?? []).map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name} ·{' '}
                  {provider.enabled ? t('providers:enabled') : t('providers:disabled')}
                </option>
              ))}
            </select>
            <div className={styles.iconActions} data-part="profile-actions">
              <button
                type="button"
                onClick={() => selectProfile('')}
                title={t('providers:newProfile')}
              >
                <Plus aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={duplicate}
                disabled={!draft.id}
                title={t('providers:duplicateProfile')}
              >
                <Copy aria-hidden="true" />
              </button>
              <button type="button" onClick={reset} title={t('providers:resetForm')}>
                <ArrowsClockwise aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setDeleteOpen(true)}
                disabled={!draft.id}
                title={t('providers:deleteProfile')}
              >
                <Trash aria-hidden="true" />
              </button>
            </div>
          </div>
        </label>
      </div>

      <div className={`${styles.formGrid} ${styles.providerFormGrid}`} data-part="profile-fields">
        {catalogError ? (
          <p className={styles.inlineError} role="alert" data-part="catalog-error">
            {catalogError}
          </p>
        ) : null}
        {catalogItems.length > 0 ? (
          <label className={styles.field} data-part="api-mode">
            <span>{t('providers:apiMode')}</span>
            <select
              value={draft.apiMode}
              disabled={busy}
              onChange={(event) => changeApiMode(event.target.value as ApiMode)}
            >
              <option value="chat">{t('providers:apiChat')}</option>
              <option value="text">{t('providers:apiText')}</option>
            </select>
          </label>
        ) : null}

        {draft.source ? (
          <label className={styles.field} data-part="provider-source">
            <span>{t('providers:source')}</span>
            <select
              value={draft.source}
              disabled={busy}
              onChange={(event) => changeSource(event.target.value as ProviderSourceId)}
            >
              {entriesForMode(draft.apiMode).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {t(`providers:source_${entry.id}`)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div
            className={`${styles.pluginSummary} ${styles.formFieldFull}`}
            data-part="plugin-provider-summary"
          >
            <strong>{t('providers:pluginProvider')}</strong>
            <span>{draft.kind}</span>
            <pre>{JSON.stringify(draft.publicSettings, null, 2)}</pre>
          </div>
        )}

        {/* The panel hides Name once a source is chosen (the source is the
            identity, SillyTavern-style); the page surface keeps it as an
            optional override with the auto-derived name as placeholder. */}
        {surface === 'panel' && draft.source ? null : (
          <label className={`${styles.field} ${styles.formFieldFull}`} data-part="provider-name">
            <span>{t('providers:name')}</span>
            <input
              value={draft.name}
              disabled={busy}
              placeholder={
                draft.name.trim().length === 0 && draft.source
                  ? t(`providers:source_${draft.source}`)
                  : undefined
              }
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
          </label>
        )}

        {selectedCatalog?.baseUrlEditable || !draft.source ? (
          <div className={`${styles.fieldGroup} ${styles.formFieldFull}`} data-part="base-url">
            <label className={styles.field}>
              <span>{t('providers:baseUrl')}</span>
              <input
                inputMode="url"
                value={draft.baseUrl}
                disabled={busy}
                placeholder={selectedCatalog?.defaultBaseUrl ?? t('providers:baseUrlPlaceholder')}
                aria-describedby={
                  draft.source === 'openai-compatible' && !selectedCatalog?.defaultBaseUrl
                    ? baseUrlHintId
                    : undefined
                }
                onChange={(event) =>
                  setDraft((current) => ({ ...current, baseUrl: event.target.value }))
                }
              />
            </label>
            {draft.source === 'openai-compatible' && !selectedCatalog?.defaultBaseUrl ? (
              <small id={baseUrlHintId} className={styles.fieldHint}>
                {t('providers:customBaseUrlHint')}
              </small>
            ) : null}
          </div>
        ) : null}
        <div className={`${styles.field} ${styles.formFieldFull}`} data-part="model-field">
          <span>{t('providers:model')}</span>
          <ModelMenu
            options={discoveredModels.map((model) => ({
              value: model.id,
              label: model.name,
              contextLimit: model.contextLimit,
            }))}
            value={draft.model}
            onValueChange={(model) => setDraft((current) => ({ ...current, model }))}
            onLoadModels={() => void loadModels()}
            loading={discoverModels.isPending}
            disabled={busy}
            aria-label={t('providers:model')}
            placeholder={t('providers:modelPlaceholder')}
            loadLabel={t('providers:loadModels')}
            emptyText={t('providers:modelEmptyText')}
            noResultsText={t('providers:modelNoResultsText')}
            hint={
              discoverModels.isError
                ? t('providers:modelDiscoveryUnavailable')
                : discoveredModels.length > 0
                  ? t('providers:modelsLoaded', { count: discoveredModels.length })
                  : t('providers:modelsLoadHint')
            }
            hintTone={discoverModels.isError ? 'error' : 'default'}
          />
        </div>

        <div className={`${styles.field} ${styles.formFieldFull}`} data-part="api-key-field">
          <span>{t('providers:apiKey')}</span>
          <div className={styles.toolbarControlRow}>
            <select
              aria-label={t('providers:apiKey')}
              value={activeSecretId}
              disabled={!draft.id || secrets.isLoading || updateSecret.isPending || busy}
              onChange={(event) => void selectActiveKey(event.target.value)}
            >
              <option value="">{t('providers:selectKey')}</option>
              {(secrets.data?.items ?? []).map((secret) => (
                <option key={secret.id} value={secret.id}>
                  {secret.label ? `${secret.label} · ${secret.masked}` : secret.masked}
                </option>
              ))}
            </select>
            <button
              className={styles.manageKeyButton}
              type="button"
              disabled={busy}
              aria-label={t('providers:manageKeys')}
              title={t('providers:manageKeys')}
              onClick={() => void openKeys()}
            >
              <Key aria-hidden="true" />
            </button>
          </div>
        </div>

        {draft.source === 'openai-compatible' ? (
          <label className={styles.field}>
            <span>{t('providers:samplerCompatibility')}</span>
            <select
              value={draft.samplerCompatibility}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  samplerCompatibility: event.target.value as 'standard' | 'extended',
                }))
              }
            >
              <option value="standard">{t('providers:samplerCompatibilityStandard')}</option>
              <option value="extended">{t('providers:samplerCompatibilityExtended')}</option>
            </select>
          </label>
        ) : null}

        {draft.source ? (
          <label className={styles.field} data-part="post-processing">
            <span>{t('providers:promptPostProcessing')}</span>
            <select
              value={draft.promptPostProcessing}
              disabled={busy}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  promptPostProcessing: event.target.value as PromptPostProcessingMode,
                }))
              }
            >
              <option value="">{t('providers:postProcessing_none')}</option>
              <optgroup label={t('providers:postProcessingGroupTools')}>
                <option value="merge_tools">{t('providers:postProcessing_merge_tools')}</option>
                <option value="semi_tools">{t('providers:postProcessing_semi_tools')}</option>
                <option value="strict_tools">{t('providers:postProcessing_strict_tools')}</option>
              </optgroup>
              <optgroup label={t('providers:postProcessingGroupNoTools')}>
                <option value="merge">{t('providers:postProcessing_merge')}</option>
                <option value="semi">{t('providers:postProcessing_semi')}</option>
                <option value="strict">{t('providers:postProcessing_strict')}</option>
                <option value="single">{t('providers:postProcessing_single')}</option>
              </optgroup>
            </select>
            <small>{t('providers:promptPostProcessingHint')}</small>
          </label>
        ) : null}

        <label
          className={`${styles.checkboxField} ${styles.formFieldFull}`}
          data-part="auto-connect"
        >
          <Switch
            checked={settings.data?.autoConnect ?? false}
            disabled={updateSettings.isPending}
            onCheckedChange={setAutoConnect}
          />
          <span>{t('providers:autoConnect')}</span>
        </label>
      </div>

      {formError ? (
        <p className={styles.inlineError} role="alert">
          {formError}
        </p>
      ) : null}

      <div className={styles.actionRow} data-part="profile-primary-actions">
        <Button variant="primary" onClick={() => void connect()} disabled={busy}>
          {t('providers:connect')}
        </Button>
        <span className={styles.connectionStatus} data-state={status} aria-live="polite">
          {status === 'ready' ? <CheckCircle weight="fill" aria-hidden="true" /> : null}
          {t(`providers:status_${status}`)}
        </span>
      </div>

      <ConfirmActionDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('providers:deleteTitle')}
        description={
          settings.data?.activeProviderConfigId === draft.id
            ? t('providers:deleteActiveDescription')
            : t('providers:deleteDescription')
        }
        confirmLabel={t('common:delete')}
        busy={deleteProvider.isPending}
        danger
        onConfirm={() => void confirmDelete()}
      />

      <ApiKeysModal
        open={keysOpen}
        onOpenChange={setKeysOpen}
        providerId={draft.id}
        providerName={draft.name.trim() || t('providers:newProfile')}
      />
    </section>
  );
}

function emptyDraft(source?: ProviderCatalogEntry): ProviderDraft {
  return {
    id: null,
    source: source?.id ?? null,
    apiMode: source ? apiModeForKind(source.adapterKind) : 'chat',
    kind: source?.adapterKind ?? 'openai-compatible',
    name: '',
    baseUrl: source?.defaultBaseUrl ?? '',
    model: '',
    enabled: true,
    hasStoredApiKey: false,
    samplerCompatibility: 'standard',
    promptPostProcessing: '',
    additionalParams: EMPTY_ADDITIONAL_PARAMS,
    publicSettings: {},
  };
}

function fromProvider(
  provider: ProviderConfig,
  catalog: readonly ProviderCatalogEntry[],
): ProviderDraft {
  const configuredSource = provider.settings['source'];
  const source =
    typeof configuredSource === 'string'
      ? catalog.find((entry) => entry.id === configuredSource)?.id
      : provider.kind === 'openai-compatible'
        ? 'openai-compatible'
        : provider.kind === 'anthropic'
          ? 'anthropic'
          : undefined;
  const compatibility = provider.settings['samplerCompatibility'];
  const postProcessing = provider.settings['promptPostProcessing'];
  return {
    id: provider.id,
    source: source ?? null,
    apiMode: apiModeForKind(provider.kind),
    kind: provider.kind,
    name: provider.name,
    baseUrl: provider.baseUrl ?? '',
    model: provider.model ?? '',
    enabled: provider.enabled,
    hasStoredApiKey: provider.hasApiKey,
    samplerCompatibility: compatibility === 'extended' ? 'extended' : 'standard',
    promptPostProcessing: toPostProcessingMode(postProcessing),
    additionalParams: serializeAdditionalParams(provider.settings),
    publicSettings: provider.settings,
  };
}

/** Coerce a persisted post-processing value back into the typed mode. */
function toPostProcessingMode(value: unknown): PromptPostProcessingMode {
  if (typeof value === 'string' && (POST_PROCESSING_OPTIONS as readonly string[]).includes(value)) {
    return value as PromptPostProcessingMode;
  }
  return '';
}
