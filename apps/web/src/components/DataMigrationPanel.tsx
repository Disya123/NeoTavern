import {
  Archive,
  CheckCircle,
  Database,
  FileMagnifyingGlass,
  FileZip,
  ShieldCheck,
  UploadSimple,
  Warning,
} from '@phosphor-icons/react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DataImportConflictPolicy,
  DataImportCounts,
  DataImportEntityCount,
  DataImportWarning,
  FullBackupAnalysis,
  FullBackupCategoryId,
  FullBackupImportResult,
} from '@neotavern/contracts';
import { ActionBar, ActionBarGroup, Button } from '@neotavern/ui';
import {
  useAnalyzeFullBackup,
  useDiscardFullBackupAnalysis,
  useExecuteFullBackupImport,
} from '../api/hooks.js';
import {
  isLegacyImportAvailable,
  legacyImportExecute,
  legacyImportPlan,
  legacyImportRollback,
  parseLegacyOpError,
  pickLegacyAppDb,
  type LegacyImportExecuteReport,
  type LegacyImportPlanReport,
  type LegacyOpFailure,
} from '../api/legacyAppDb.js';
import { useErrorText } from '../lib/useErrorText.js';
import styles from './DataMigrationPanel.module.css';

const ENTITY_KEYS = [
  'characters',
  'chats',
  'messages',
  'personas',
  'lorebooks',
  'loreEntries',
  'presets',
  'groups',
  'backgrounds',
  'extensionSettings',
  'apiSettings',
  'legacyExtensions',
  'themes',
] as const satisfies readonly (keyof DataImportCounts)[];
const CATEGORY_IDS = [
  'characters',
  'chats',
  'personas',
  'lorebooks',
  'presets',
  'groups',
  'backgrounds',
  'extensionSettings',
  'apiSettings',
  'legacyExtensions',
  'themes',
] as const satisfies readonly FullBackupCategoryId[];
const CONFLICT_POLICIES = [
  'skip',
  'copy',
  'merge',
  'replace',
] as const satisfies readonly DataImportConflictPolicy[];
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;

export function DataMigrationPanel() {
  const { t, i18n } = useTranslation();
  const inputId = useId();
  const policyGroup = useId();
  const errorText = useErrorText();
  const analysisMutation = useAnalyzeFullBackup();
  const execution = useExecuteFullBackupImport();
  const discard = useDiscardFullBackupAnalysis();
  const activeRequest = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<FullBackupAnalysis | null>(null);
  const [selectedCategories, setSelectedCategories] =
    useState<readonly FullBackupCategoryId[]>(CATEGORY_IDS);
  const [conflictPolicy, setConflictPolicy] = useState<DataImportConflictPolicy>('skip');
  const [result, setResult] = useState<FullBackupImportResult | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const number = new Intl.NumberFormat(i18n.language);
  const fileSize = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  const busy = analysisMutation.isPending || execution.isPending;
  const archiveTooLarge = file !== null && file.size > MAX_ARCHIVE_BYTES;

  const clearAnalysis = (removeRemote: boolean): void => {
    if (removeRemote && analysis) discard.mutate(analysis.analysisId);
    setAnalysis(null);
    setSelectedCategories(CATEGORY_IDS);
    setConflictPolicy('skip');
    analysisMutation.reset();
    execution.reset();
  };

  const analyzeArchive = async (): Promise<void> => {
    if (!file) return;
    setResult(null);
    setCancelled(false);
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const inspected = await analysisMutation.mutateAsync({
        file,
        signal: controller.signal,
      });
      setAnalysis(inspected);
      setSelectedCategories(
        inspected.categories
          .filter((category) => category.discovered > 0)
          .map((category) => category.id),
      );
    } catch {
      if (controller.signal.aborted) {
        analysisMutation.reset();
        setCancelled(true);
      }
    } finally {
      activeRequest.current = null;
    }
  };

  const executeImport = async (): Promise<void> => {
    if (!analysis || selectedCategories.length === 0) return;
    setCancelled(false);
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const imported = await execution.mutateAsync({
        analysisId: analysis.analysisId,
        input: { categories: [...selectedCategories], conflictPolicy },
        signal: controller.signal,
      });
      setResult(imported);
      setAnalysis(null);
    } catch {
      if (controller.signal.aborted) {
        execution.reset();
        setCancelled(true);
      }
    } finally {
      activeRequest.current = null;
    }
  };

  return (
    <section className={styles.panel} data-component="fullbackup-migration">
      <div className={styles.intro}>
        <span className={styles.icon}>
          <Archive weight="duotone" aria-hidden="true" />
        </span>
        <div className={styles.copy}>
          <h3>{t('settings:migrateFullBackup')}</h3>
          <p>{t('settings:migrateFullBackupHint')}</p>
        </div>
        <Button asChild variant="ghost">
          <label htmlFor={inputId} aria-disabled={busy}>
            <UploadSimple aria-hidden="true" />
            {t('settings:chooseArchive')}
          </label>
        </Button>
        <input
          id={inputId}
          className={styles.fileInput}
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          disabled={busy}
          onChange={(event) => {
            clearAnalysis(true);
            setFile(event.target.files?.[0] ?? null);
            setResult(null);
            setCancelled(false);
          }}
        />
      </div>

      <div className={styles.safety}>
        <ShieldCheck weight="fill" aria-hidden="true" />
        <p>{t('settings:migrationSafetyTwoPhase')}</p>
      </div>

      {file && !analysis && !result ? (
        <div className={styles.selection}>
          <FileZip weight="duotone" aria-hidden="true" />
          <span>
            <strong>{file.name}</strong>
            <small>
              {t('settings:archiveSize', {
                size: fileSize.format(file.size / 1024 / 1024),
              })}
            </small>
          </span>
          <Button
            variant="primary"
            startIcon={<FileMagnifyingGlass />}
            onClick={() => void analyzeArchive()}
            disabled={busy || archiveTooLarge}
          >
            {analysisMutation.isPending
              ? t('settings:migrationAnalyzing')
              : t('settings:analyzeArchive')}
          </Button>
          {analysisMutation.isPending ? (
            <Button variant="ghost" onClick={() => activeRequest.current?.abort()}>
              {t('common:cancel')}
            </Button>
          ) : null}
        </div>
      ) : !file ? (
        <p className={styles.empty}>{t('settings:migrationArchiveHint')}</p>
      ) : null}

      {archiveTooLarge ? (
        <p className={styles.error} role="alert">
          {t('settings:migrationArchiveTooLarge')}
        </p>
      ) : null}

      {busy ? (
        <div className={styles.progress} role="status" aria-live="polite">
          <span>
            {analysisMutation.isPending
              ? t('settings:migrationAnalyzingHint')
              : t('settings:migrationRunningHint')}
          </span>
          <div aria-hidden="true">
            <i />
          </div>
        </div>
      ) : null}

      {analysis ? (
        <div className={styles.analysis} aria-live="polite">
          <header>
            <span>{t('settings:migrationReviewStep')}</span>
            <h4>{t('settings:migrationAnalysisReady')}</h4>
            <p>
              {t('settings:migrationAnalysisSummary', {
                archiveSize: fileSize.format(analysis.totalCompressedBytes / 1024 / 1024),
                expandedSize: fileSize.format(analysis.totalExpandedBytes / 1024 / 1024),
                conflicts: number.format(analysis.conflictCount),
                warnings: number.format(analysis.warningCount),
              })}
            </p>
          </header>

          {analysis.archiveAlreadyImported ? (
            <p className={styles.notice} role="status">
              {t('settings:migrationArchivePreviouslyImported')}
            </p>
          ) : null}

          <fieldset className={styles.categories}>
            <legend>{t('settings:migrationChooseCategories')}</legend>
            {analysis.categories.map((category) => {
              const checked = selectedCategories.includes(category.id);
              return (
                <label key={category.id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={category.discovered === 0 || execution.isPending}
                    onChange={(event) => {
                      setSelectedCategories((current) =>
                        event.target.checked
                          ? [...current, category.id]
                          : current.filter((id) => id !== category.id),
                      );
                    }}
                  />
                  <span>
                    <strong>{t(`settings:migrationCategory_${category.id}`)}</strong>
                    <small>
                      {t('settings:migrationCategoryDetails', {
                        count: number.format(category.discovered),
                        dependent: number.format(category.dependentRecords),
                        invalid: number.format(category.invalid),
                        conflicts: number.format(category.conflicts),
                        size: fileSize.format(category.sizeBytes / 1024 / 1024),
                      })}
                    </small>
                  </span>
                </label>
              );
            })}
          </fieldset>

          <fieldset className={styles.policies}>
            <legend>{t('settings:migrationConflictPolicy')}</legend>
            <p>{t('settings:migrationConflictPolicyHint')}</p>
            <div>
              {CONFLICT_POLICIES.map((policy) => (
                <label key={policy}>
                  <input
                    type="radio"
                    name={policyGroup}
                    value={policy}
                    checked={conflictPolicy === policy}
                    disabled={execution.isPending}
                    onChange={() => setConflictPolicy(policy)}
                  />
                  <span>
                    <strong>{t(`settings:migrationPolicy_${policy}`)}</strong>
                    <small>{t(`settings:migrationPolicy_${policy}Hint`)}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {analysis.warningCount > 0 ? (
            <Warnings
              warnings={analysis.warnings}
              warningCount={analysis.warningCount}
              number={number}
            />
          ) : null}

          <footer>
            <p>{t('settings:migrationConfirmBackupHint')}</p>
            <ActionBar align="end" collapse="stack" data-part="migration-actions">
              <ActionBarGroup placement="primary">
                <Button
                  variant="ghost"
                  disabled={execution.isPending}
                  onClick={() => clearAnalysis(true)}
                >
                  {t('common:cancel')}
                </Button>
                <Button
                  variant="primary"
                  disabled={execution.isPending || selectedCategories.length === 0}
                  onClick={() => void executeImport()}
                >
                  {execution.isPending
                    ? t('settings:migrationRunning')
                    : t('settings:confirmMigration')}
                </Button>
              </ActionBarGroup>
            </ActionBar>
          </footer>
        </div>
      ) : null}

      {analysisMutation.error || execution.error ? (
        <p className={styles.error} role="alert">
          {errorText(analysisMutation.error ?? execution.error)}
        </p>
      ) : null}

      {cancelled ? (
        <p className={styles.cancelled} role="status">
          {t('settings:migrationCancelled')}
        </p>
      ) : null}

      {result ? <MigrationResult result={result} number={number} /> : null}

      <LegacyAppDbImport />
    </section>
  );
}

/**
 * Kernel-mode legacy app.db migration (G7/G8 user-facing half): pick the
 * old database, see the per-family plan, stage + activate (restart
 * applies), one rollback kept. Hidden outside the desktop kernel runtime.
 */
function LegacyAppDbImport() {
  const { t } = useTranslation();
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [plan, setPlan] = useState<LegacyImportPlanReport | null>(null);
  const [executed, setExecuted] = useState<LegacyImportExecuteReport | null>(null);
  const [rolledBack, setRolledBack] = useState(false);
  const [failure, setFailure] = useState<LegacyOpFailure | null>(null);
  const [busy, setBusy] = useState<'plan' | 'execute' | 'rollback' | null>(null);
  if (!isLegacyImportAvailable()) return null;

  const reset = (): void => {
    setPlan(null);
    setExecuted(null);
    setRolledBack(false);
    setFailure(null);
  };

  const run = async (step: 'plan' | 'execute' | 'rollback'): Promise<void> => {
    setFailure(null);
    setBusy(step);
    try {
      if (step === 'plan' && sourcePath) {
        setExecuted(null);
        setRolledBack(false);
        setPlan(await legacyImportPlan(sourcePath));
      } else if (step === 'execute' && sourcePath) {
        setExecuted(await legacyImportExecute(sourcePath));
      } else if (step === 'rollback') {
        await legacyImportRollback();
        setExecuted(null);
        setRolledBack(true);
      }
    } catch (error) {
      setFailure(parseLegacyOpError(error));
    } finally {
      setBusy(null);
    }
  };

  const failureKey =
    failure?.code === 'LEGACY_SOURCE_UNREADABLE'
      ? 'settings:legacyErrSource'
      : failure?.code === 'LEGACY_NO_ROLLBACK_TARGET'
        ? 'settings:legacyErrNoTarget'
        : failure?.code === 'LEGACY_NO_DATA_ROOT'
          ? 'settings:legacyErrNoRoot'
          : failure?.code === 'LEGACY_UNAVAILABLE'
            ? 'settings:legacyErrUnavailable'
            : null;

  return (
    <section className={styles.legacyBlock} data-component="legacy-appdb-migration">
      <div className={styles.intro}>
        <span className={styles.icon}>
          <Database weight="duotone" aria-hidden="true" />
        </span>
        <div className={styles.copy}>
          <h3>{t('settings:legacyAppDb')}</h3>
          <p>{t('settings:legacyAppDbHint')}</p>
        </div>
        <Button
          variant="ghost"
          disabled={busy !== null}
          onClick={() => {
            void (async () => {
              const picked = await pickLegacyAppDb();
              if (picked === null) return;
              setSourcePath(picked);
              reset();
            })();
          }}
        >
          <FileMagnifyingGlass aria-hidden="true" />
          {t('settings:legacyChooseFile')}
        </Button>
      </div>

      {sourcePath ? (
        <p className={styles.cancelled} role="status">
          {t('settings:legacyPickedFile', { path: sourcePath })}
        </p>
      ) : null}

      {plan ? (
        <div className={styles.selection}>
          <p>
            <strong>
              {plan.ready ? t('settings:legacyPlanReady') : t('settings:legacyPlanNotReady')}
            </strong>
          </p>
          <dl className={styles.counts}>
            {plan.families.map((family) => (
              <div key={family.family}>
                <dt>{family.family}</dt>
                <dd>{new Intl.NumberFormat().format(family.count)}</dd>
              </div>
            ))}
          </dl>
          {plan.problems.length > 0 ? (
            <ul>
              {plan.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {executed ? (
        <div className={styles.result} aria-live="polite">
          <header>
            <CheckCircle weight="fill" aria-hidden="true" />
            <div>
              <h4>{t('settings:legacyRestartRequired', { rootId: executed.stagedRootId })}</h4>
            </div>
          </header>
        </div>
      ) : null}

      {rolledBack ? (
        <p className={styles.cancelled} role="status">
          {t('settings:legacyRolledBack')}
        </p>
      ) : null}

      {failure ? (
        <p className={styles.error} role="alert">
          {failureKey !== null
            ? t(failureKey, failure.code === 'LEGACY_STORAGE' ? { message: failure.message } : {})
            : t('settings:legacyErrGeneric', { message: failure.message })}
        </p>
      ) : null}

      {sourcePath ? (
        <ActionBar align="end" collapse="stack" data-part="legacy-appdb-actions">
          <ActionBarGroup placement="primary">
            {executed ? (
              <Button variant="ghost" disabled={busy !== null} onClick={() => void run('rollback')}>
                {t('settings:legacyRollback')}
              </Button>
            ) : null}
            <Button
              variant="primary"
              disabled={busy !== null || executed !== null || !plan?.ready}
              onClick={() => void run('execute')}
            >
              {busy === 'execute' ? t('settings:migrationRunning') : t('settings:legacyImport')}
            </Button>
          </ActionBarGroup>
        </ActionBar>
      ) : null}
    </section>
  );
}

function MigrationResult({
  result,
  number,
}: {
  result: FullBackupImportResult;
  number: Intl.NumberFormat;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.result} aria-live="polite">
      <header>
        <CheckCircle weight="fill" aria-hidden="true" />
        <div>
          <h4>
            {result.reusedArchive
              ? t('settings:migrationAlreadyCompleted')
              : t('settings:migrationComplete')}
          </h4>
          <p>
            {result.reusedArchive
              ? t('settings:migrationAlreadyCompletedHint')
              : t('settings:migrationCompleteHint', {
                  count: number.format(totalImported(result.counts)),
                })}
          </p>
          <small>{t('settings:migrationSafetyBackup', { backupId: result.safetyBackupId })}</small>
        </div>
      </header>

      <dl className={styles.counts}>
        {ENTITY_KEYS.map((key) => (
          <ImportCount
            key={key}
            label={t(`settings:migrationEntity_${key}`)}
            count={result.counts[key]}
            format={(value) => number.format(value)}
            detail={t('settings:migrationCountDetails', {
              reused: number.format(result.counts[key].reused),
              skipped: number.format(result.counts[key].skipped),
            })}
          />
        ))}
      </dl>

      {result.warningCount > 0 ? (
        <Warnings warnings={result.warnings} warningCount={result.warningCount} number={number} />
      ) : null}
    </div>
  );
}

function Warnings({
  warnings,
  warningCount,
  number,
}: {
  warnings: readonly DataImportWarning[];
  warningCount: number;
  number: Intl.NumberFormat;
}) {
  const { t } = useTranslation();
  return (
    <details className={styles.warnings}>
      <summary>
        <Warning weight="fill" aria-hidden="true" />
        {t('settings:migrationWarnings', { count: number.format(warningCount) })}
      </summary>
      <ul>
        {warnings.map((warning, index) => (
          <li key={`${warning.code}-${warning.path ?? ''}-${index}`}>
            <span>{warningText(t, warning)}</span>
            {warning.path ? <code>{warning.path}</code> : null}
          </li>
        ))}
      </ul>
      {warningCount > warnings.length ? (
        <p>
          {t('settings:migrationWarningsTruncated', {
            count: number.format(warningCount - warnings.length),
          })}
        </p>
      ) : null}
    </details>
  );
}

function ImportCount({
  label,
  count,
  format,
  detail,
}: {
  label: string;
  count: DataImportEntityCount;
  format: (value: number) => string;
  detail: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{format(count.imported)}</dd>
      <small>{detail}</small>
    </div>
  );
}

function totalImported(counts: DataImportCounts): number {
  return ENTITY_KEYS.reduce((total, key) => total + counts[key].imported, 0);
}

function warningText(
  t: ReturnType<typeof useTranslation>['t'],
  warning: DataImportWarning,
): string {
  return t(`settings:migrationWarning_${warning.code}`, {
    defaultValue: t('settings:migrationWarningUnknown', { code: warning.code }),
    ...(warning.params ?? {}),
  });
}
