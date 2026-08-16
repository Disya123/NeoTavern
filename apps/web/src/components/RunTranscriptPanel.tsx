/**
 * Durable run-step transcript viewer (ТЗ §8.3, §13.2, §15 generation
 * timeline, М5 slice 47). For one generation run the kernel journals an
 * immutable step sequence — provider turns, tool calls, tool results, the
 * final commit — and this dialog renders it so the user can see what the run
 * actually did. Tool arguments and results are NEVER rendered (SEC-07: they
 * may carry data the user did not ask to see; the wireBridge keeps them out
 * of the UI shape entirely). Honest empty state when the run has no recorded
 * steps (no generation yet, unknown run, legacy plane).
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from '@phosphor-icons/react';
import { Dialog, DialogContent } from '@neotavern/ui';
import { useGenerationRunSteps } from '../api/hooks.js';
import type { RunStepItem } from '../api/wireBridge.js';
import { useErrorText } from '../lib/useErrorText.js';
import styles from './RunTranscriptPanel.module.css';

export interface RunTranscriptPanelProps {
  open: boolean;
  runId: string | null;
  onClose: () => void;
}

export function RunTranscriptPanel({ open, runId, onClose }: RunTranscriptPanelProps) {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const steps = useGenerationRunSteps(runId ?? undefined);
  const timeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [i18n.language],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className={styles.dialog} title={t('chat:runTranscriptTitle')}>
        <header className={styles.header}>
          <h2 className={styles.title}>{t('chat:runTranscriptTitle')}</h2>
          <button
            type="button"
            className={styles.close}
            data-part="run-transcript-close"
            onClick={onClose}
            aria-label={t('common:close')}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className={styles.body} data-part="run-transcript-body">
          {steps.isError ? (
            <p className={styles.error} role="alert">
              {errorText(steps.error)}
            </p>
          ) : steps.isLoading ? (
            <p className={styles.empty}>{t('common:loading')}</p>
          ) : !steps.data || steps.data.items.length === 0 ? (
            <p className={styles.empty}>{t('chat:runTranscriptEmpty')}</p>
          ) : (
            <ol className={styles.list} data-part="run-transcript-steps">
              {steps.data.items.map((step) => (
                <RunStepRow
                  key={`${step.sequence}-${step.attempt}`}
                  step={step}
                  timeFormat={timeFormat}
                />
              ))}
            </ol>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RunStepRow({ step, timeFormat }: { step: RunStepItem; timeFormat: Intl.DateTimeFormat }) {
  const { t } = useTranslation();
  const time = useMemo(() => {
    const date = new Date(step.createdAt);
    if (!Number.isFinite(date.getTime())) return null;
    return timeFormat.format(date);
  }, [step.createdAt, timeFormat]);
  return (
    <li className={styles.step} data-step-type={step.type} data-step-status={step.status}>
      <span className={styles.sequence} data-part="step-sequence">
        {step.sequence}
      </span>
      <span className={styles.stepText}>
        <strong>{t(`chat:runStepType_${step.type}`)}</strong>
        <span className={styles.status} data-part="step-status">
          {t(`chat:runStepStatus_${step.status}`)}
        </span>
        {step.attempt > 1 ? (
          <span className={styles.attempt} data-part="step-attempt">
            {t('chat:runStepAttempt', { count: step.attempt })}
          </span>
        ) : null}
      </span>
      {time ? (
        <time className={styles.time} dateTime={step.createdAt}>
          {time}
        </time>
      ) : null}
    </li>
  );
}
