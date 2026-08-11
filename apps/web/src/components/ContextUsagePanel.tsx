import type { ReactNode } from 'react';
import {
  BookOpen,
  ChatsCircle,
  CircleDashed,
  Database,
  Info,
  PencilSimple,
  Sparkle,
  SquaresFour,
  UserCircle,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import type { ContextUsageSummary } from '../lib/contextUsage.js';
import styles from './ContextUsagePanel.module.css';

interface ContextUsagePanelProps {
  id: string;
  summary: ContextUsageSummary;
  source: 'audit' | 'preview';
  isLoading?: boolean;
  isError?: boolean;
  createdAt?: number;
  tokenizerProfile?: string;
  tokenizerApproximate?: boolean;
}

/** Shared context meter used before and after a chat is created. */
export function ContextUsagePanel({
  id,
  summary,
  source,
  isLoading = false,
  isError = false,
  createdAt,
  tokenizerProfile,
  tokenizerApproximate = false,
}: ContextUsagePanelProps) {
  const { t, i18n } = useTranslation();
  const showLoading = isLoading && !summary.isExact;
  const title = summary.isExact
    ? t(source === 'preview' ? 'chat:contextPreviewTitle' : 'chat:contextAuditTitle')
    : t('chat:contextDraftEstimate');
  const note = contextNote({
    source,
    isLoading: showLoading,
    isError,
    isExact: summary.isExact,
    createdAt,
    tokenizerProfile,
    tokenizerApproximate,
    language: i18n.language,
    t,
  });
  const rows = [
    {
      id: 'history',
      label: t('chat:contextBreakdownHistory'),
      Icon: ChatsCircle,
      tokens: summary.breakdown.chatHistory,
    },
    {
      id: 'world-info',
      label: t('chat:contextBreakdownWorldInfo'),
      Icon: BookOpen,
      tokens: summary.breakdown.worldInfo,
    },
    {
      id: 'character',
      label: t('chat:contextBreakdownCharacter'),
      Icon: Sparkle,
      tokens: summary.breakdown.character,
    },
    {
      id: 'persona',
      label: t('chat:contextBreakdownPersona'),
      Icon: UserCircle,
      tokens: summary.breakdown.persona,
    },
    {
      id: 'other',
      label: t('chat:contextBreakdownOther'),
      Icon: SquaresFour,
      tokens: summary.breakdown.other,
    },
  ];

  return (
    <div className={styles.container}>
      <section
        className={styles.panel}
        id={id}
        data-component="context-usage-panel"
        data-state={
          isError ? 'error' : showLoading ? 'loading' : summary.isExact ? 'exact' : 'estimate'
        }
      >
        <div className={styles.leftColumn} data-part="summary">
          <div className={styles.headerRow} data-part="header">
            <div className={styles.headerIcon} data-part="icon" aria-hidden="true">
              <Database size={18} weight="duotone" />
            </div>
            <div>
              <div className={styles.headerTitle}>{title}</div>
              <div className={styles.headerValue} data-part="usage">
                {summary.promptTokens.toLocaleString()} / {summary.contextLimit.toLocaleString()}
              </div>
            </div>
          </div>

          <div className={styles.metrics} data-part="metrics">
            <Metric
              icon={<Database size={14} aria-hidden="true" />}
              label={t('chat:contextUsage')}
              value={`${summary.usagePercent}%`}
            />
            <Metric
              icon={<Sparkle size={14} aria-hidden="true" />}
              label={t('chat:contextAvailable')}
              value={summary.availableTokens.toLocaleString()}
            />
            <Metric
              icon={<PencilSimple size={14} aria-hidden="true" />}
              label={t('chat:contextPromptTokens')}
              value={`${summary.promptTokens.toLocaleString()} / ${(
                summary.contextLimit - summary.reservedForReply
              ).toLocaleString()}`}
            />
            <Metric
              icon={<CircleDashed size={14} aria-hidden="true" />}
              label={t('chat:contextReserve')}
              value={summary.reservedForReply.toLocaleString()}
            />
          </div>

          <div className={styles.note} data-part="status" role={isError ? 'alert' : 'status'}>
            <Info size={14} aria-hidden="true" /> {note}
          </div>
        </div>

        <div className={styles.rightColumn} data-part="details">
          <div className={styles.breakdown} data-part="breakdown">
            {rows.map(({ id: rowId, label, Icon, tokens }) => (
              <div className={styles.breakdownRow} data-part="breakdown-row" key={rowId}>
                <div className={styles.breakdownLabel}>
                  <Icon size={15} aria-hidden="true" /> {label}
                </div>
                <div className={styles.breakdownTrack} aria-hidden="true">
                  <div
                    className={styles.breakdownFill}
                    style={{
                      width: `${Math.min(100, (tokens / Math.max(1, summary.promptTokens)) * 100)}%`,
                    }}
                  />
                </div>
                <div className={styles.breakdownCount}>{tokens.toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className={styles.metric} data-part="metric">
      <div className={styles.metricLabel}>
        {icon} {label}
      </div>
      <div className={styles.metricValue}>{value}</div>
    </div>
  );
}

type Translate = ReturnType<typeof useTranslation>['t'];

function contextNote(input: {
  source: 'audit' | 'preview';
  isLoading: boolean;
  isError: boolean;
  isExact: boolean;
  createdAt?: number;
  tokenizerProfile?: string;
  tokenizerApproximate: boolean;
  language: string;
  t: Translate;
}): string {
  if (input.isLoading) return input.t('common:loading');
  if (input.isError) {
    return input.t(
      input.source === 'preview' ? 'chat:contextPreviewError' : 'chat:contextAuditError',
    );
  }
  if (!input.isExact) return input.t('chat:contextDraftEstimateHint');
  if (input.source === 'preview') {
    return input.t('chat:contextPreviewReady', {
      tokenizer: input.tokenizerProfile ?? input.t('chat:approximate'),
      precision: input.tokenizerApproximate ? ` · ${input.t('chat:approximate')}` : '',
    });
  }
  if (input.createdAt !== undefined) {
    const date = new Intl.DateTimeFormat(input.language, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(input.createdAt);
    return input.t('chat:contextAuditCreated', { date });
  }
  return input.t('chat:contextAuditTitle');
}
