/**
 * Tool registry panel (ТЗ §8.3, §13.2; М5 slice 43). Rendered as the Tools
 * tab inside the Settings panel.
 *
 * Shows the declarative tool contracts the host registered with the kernel
 * (`generation.tools.list`): name, description and the required argument
 * names from the input JSON-Schema. The kernel never executes tools itself;
 * an empty registry is honest ("no tools registered by this host"), never a
 * fake fallback.
 */
import { Wrench } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useGenerationTools } from '../api/toolsHooks.js';
import { useErrorText } from '../lib/useErrorText.js';
import styles from './SettingsPanel.module.css';

/** Reads the required-property names of a JSON-Schema `inputSchema`. */
function requiredNames(inputSchema: unknown): string[] {
  if (typeof inputSchema !== 'object' || inputSchema === null) return [];
  const required = (inputSchema as { required?: unknown }).required;
  if (!Array.isArray(required)) return [];
  return required.filter((item): item is string => typeof item === 'string');
}

export function ToolsPanel() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const tools = useGenerationTools();

  const items = tools.data?.items ?? [];

  return (
    <div className={styles.section}>
      <header className={styles.sectionHeader}>
        <h2>{t('tools:title')}</h2>
        <p>{t('tools:titleHint')}</p>
      </header>

      {tools.isError ? (
        <p className={styles.error} role="alert">
          {errorText(tools.error)}
        </p>
      ) : items.length === 0 ? (
        <p className={styles.noBackups}>{t('tools:empty')}</p>
      ) : (
        <ul className={styles.backups}>
          {items.map((tool) => {
            const required = requiredNames(tool.inputSchema);
            return (
              <li key={tool.id} className={styles.backupItem} data-component="tool-entry">
                <div className={styles.renameRow}>
                  <Wrench aria-hidden="true" />
                  <strong>{tool.name}</strong>
                </div>
                <p className={styles.hint}>{tool.description || t('tools:noDescription')}</p>
                <p className={styles.hint} data-part="tool-required">
                  {required.length > 0
                    ? `${t('tools:requires')} ${required.join(', ')}`
                    : t('tools:noArgs')}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
