/**
 * Tool-execution indicator (ТЗ §13.2, М5 slice 41): when the kernel journals
 * a durable `tool_call` step (`generation.step`), the chat shows which tool
 * the run is waiting on — distinguishing tool execution / waiting-for-tool
 * from text streaming. Purely presentational: it receives the tool name only;
 * arguments and results are never rendered (they may carry data the user did
 * not ask to see).
 */
import { Lightning } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import styles from './ToolActivityBadge.module.css';

export interface ToolActivityBadgeProps {
  /** Tool name from the step input (`step.input.toolCall.name`). */
  name: string;
}

export function ToolActivityBadge({ name }: ToolActivityBadgeProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.toolActivity} data-component="tool-activity" role="status">
      <span className={styles.toolIcon} aria-hidden="true">
        <Lightning size={14} />
      </span>
      <span>{t('chat:toolRunning', { name })}</span>
    </div>
  );
}
