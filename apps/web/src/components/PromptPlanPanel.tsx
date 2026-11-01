/**
 * Durable prompt plan viewer (ТЗ §9.2, М5 slice 37). For one generation run
 * the kernel stores an immutable plan of what context entered the provider
 * request — system blocks (character/persona/lorebook/instruct), the
 * selected history, token counts and every excluded message. This dialog
 * renders that plan so the user can see what was included or cut, with an
 * honest empty state when the run has no recorded plan (no generation yet,
 * unknown run, legacy plane).
 *
 * With a `chatId` the dialog gains an honest fallback (wire
 * `chats.context.audit`, M7 Etap-4 cluster 17 part 1): when the requested run
 * has no recorded plan, the chat's LATEST plan is served instead of a dead
 * end — old runs and discarded plans still open the chat's most recent
 * context audit.
 */
import { X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent } from '@neotavern/ui';
import type { PromptPlanDto } from '@neotavern/contracts';
import { useChatContextAudit, usePromptPlan } from '../api/hooks.js';
import { useErrorText } from '../lib/useErrorText.js';
import styles from './PromptPlanPanel.module.css';

export interface PromptPlanPanelProps {
  open: boolean;
  runId: string | null;
  /**
   * Optional chat id backing the latest-plan fallback: used only when no
   * specific `runId` plan can be served (M7 Etap-4 cluster 17 part 1).
   */
  chatId?: string | null;
  onClose: () => void;
}

export function PromptPlanPanel({ open, runId, chatId, onClose }: PromptPlanPanelProps) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const perRun = usePromptPlan(runId ?? undefined);
  const latest = useChatContextAudit(runId === null ? (chatId ?? undefined) : undefined);

  const loading = runId !== null ? perRun.isLoading : latest.isLoading;
  const isError = runId !== null ? perRun.isError : latest.isError;
  const error = runId !== null ? perRun.error : latest.error;
  const plan: PromptPlanDto | null =
    runId !== null ? (perRun.data ?? null) : (latest.data?.plan ?? null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className={styles.dialog} title={t('chat:promptPlanTitle')}>
        <header className={styles.header}>
          <h2 className={styles.title}>{t('chat:promptPlanTitle')}</h2>
          <button
            type="button"
            className={styles.close}
            data-part="prompt-plan-close"
            onClick={onClose}
            aria-label={t('common:close')}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className={styles.body} data-part="prompt-plan-body">
          {isError ? (
            <p className={styles.error} role="alert">
              {errorText(error)}
            </p>
          ) : loading ? (
            <p className={styles.empty}>{t('chat:promptPlanEmpty')}</p>
          ) : !plan ? (
            <p className={styles.empty}>{t('chat:promptPlanNotFound')}</p>
          ) : (
            <PromptPlanContent plan={plan} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PromptPlanContent({ plan }: { plan: PromptPlanDto }) {
  const { t } = useTranslation();
  return (
    <div className={styles.content}>
      <dl className={styles.meta} data-part="prompt-plan-meta">
        <div className={styles.metaRow}>
          <dt>{t('chat:promptPlanModel')}</dt>
          <dd>
            {plan.provider}/{plan.model || '—'}
          </dd>
        </div>
        <div className={styles.metaRow}>
          <dt>{t('chat:promptPlanInstruct')}</dt>
          <dd>{plan.instructFormat}</dd>
        </div>
        <div className={styles.metaRow}>
          <dt>{t('chat:promptPlanTokenizer')}</dt>
          <dd>
            {plan.tokenizerProfile}
            {plan.approximateTokens ? ` · ${t('chat:promptPlanApproximate')}` : ''}
          </dd>
        </div>
        <div className={styles.metaRow}>
          <dt>{t('chat:promptPlanTokens')}</dt>
          <dd>
            {t('chat:promptPlanInput')} {plan.inputTokens} · {t('chat:promptPlanResponseReserve')}{' '}
            {plan.responseReserved} · {t('chat:promptPlanContextLimit')} {plan.contextLimit}
          </dd>
        </div>
      </dl>
      {plan.overBudget ? (
        <p className={styles.warning} role="alert">
          {t('chat:promptPlanOverBudget')}
        </p>
      ) : null}
      {plan.systemBlocks.length > 0 ? (
        <section className={styles.section} data-part="prompt-plan-blocks">
          <h3 className={styles.sectionTitle}>
            {t('chat:promptPlanSystemBlocks', { count: plan.systemBlocks.length })}
          </h3>
          <ul className={styles.blockList}>
            {plan.systemBlocks.map((block, index) => (
              <li key={`${block.source}-${index}`} className={styles.block}>
                <span className={styles.blockSource} data-source={block.source}>
                  {block.source}
                </span>
                <pre className={styles.blockText}>{block.text || '—'}</pre>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {plan.messages.length > 0 ? (
        <section className={styles.section} data-part="prompt-plan-messages">
          <h3 className={styles.sectionTitle}>
            {t('chat:promptPlanMessages', { count: plan.messages.length })}
          </h3>
          <ul className={styles.messageList}>
            {plan.messages.map((message, index) => (
              <li key={index} className={styles.message} data-role={message.role}>
                <span className={styles.messageRole}>{message.role}</span>
                <pre className={styles.messageContent}>{message.content}</pre>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className={styles.section} data-part="prompt-plan-excluded">
        <h3 className={styles.sectionTitle}>
          {t('chat:promptPlanExcluded', { count: plan.excluded.length })}
        </h3>
        {plan.excluded.length === 0 ? (
          <p className={styles.empty}>{t('chat:promptPlanNoExcluded')}</p>
        ) : (
          <ul className={styles.excludedList}>
            {plan.excluded.map((entry) => (
              <li key={entry.messageId} className={styles.excluded}>
                <span className={styles.excludedId}>{entry.messageId}</span>
                <span className={styles.excludedReason}>
                  {entry.reason === 'token_budget'
                    ? t('chat:promptPlanExcludedReasonBudget')
                    : entry.reason}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
