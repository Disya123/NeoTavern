import { PuzzlePiece } from '@phosphor-icons/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionBar, ActionBarGroup, Button } from '@neotavern/ui';
import { frontendPluginRuntime, usePluginRegistrations } from '../plugins/runtime.js';
import styles from './PluginToolbar.module.css';

export function PluginToolbar() {
  const { t } = useTranslation();
  const actions = usePluginRegistrations('toolbarActions');
  const commands = usePluginRegistrations('commands');
  const dialogs = usePluginRegistrations('dialogs');
  const items = [...actions, ...commands, ...dialogs];
  const [running, setRunning] = useState<string | null>(null);
  if (items.length === 0) return null;

  return (
    <div className={styles.toolbar} data-component="plugin-toolbar">
      <ActionBar
        collapse="scroll"
        data-part="actions"
        role="toolbar"
        aria-label={t('plugins:toolbarActions')}
      >
        <ActionBarGroup placement="primary">
          {items.map((action) => (
            <Button
              key={action.registrationId}
              size="sm"
              variant="ghost"
              startIcon={<PuzzlePiece />}
              disabled={running === action.registrationId}
              title={action.pluginName}
              onClick={() => {
                if (action.kind === 'dialogs') {
                  window.dispatchEvent(
                    new CustomEvent('neotavern-open-plugin-dialog', { detail: action }),
                  );
                  return;
                }
                setRunning(action.registrationId);
                void frontendPluginRuntime
                  .invoke(action)
                  .finally(() =>
                    setRunning((current) => (current === action.registrationId ? null : current)),
                  );
              }}
            >
              {action.definition.title}
            </Button>
          ))}
        </ActionBarGroup>
      </ActionBar>
    </div>
  );
}
