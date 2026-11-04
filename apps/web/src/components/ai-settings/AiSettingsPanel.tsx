import { Globe } from '@phosphor-icons/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PromptTemplateModes } from '@neotavern/contracts';
import { Tabs } from '@neotavern/ui';
import { useSettings, useUpdateSettings } from '../../api/hooks.js';
import { useErrorText } from '../../lib/useErrorText.js';
import { FloatingTabContent } from '../FloatingTabContent.js';
import { FloatingTabPanel } from '../FloatingTabPanel.js';
import { ChatTemplateEditor } from './ChatTemplateEditor.js';
import { GenerationPresetEditor } from './GenerationPresetEditor.js';
import { ProviderProfileEditor } from './ProviderProfileEditor.js';
import { PromptTemplateEditor } from './PromptTemplateEditor.js';
import styles from './AiSettings.module.css';

interface AiSettingsPanelProps {
  onClose: () => void;
}

export function AiSettingsPanel({ onClose }: AiSettingsPanelProps) {
  const { t } = useTranslation();

  return (
    <FloatingTabPanel
      component="ai-settings-panel"
      headerPart="ai-settings-header"
      avatar={
        <span className={styles.headerAvatar} aria-hidden="true">
          <Globe size={20} />
        </span>
      }
      title={t('settings:aiSettings')}
      onClose={onClose}
    >
      <Tabs
        variant="segment"
        ariaLabel={t('settings:aiSettings')}
        defaultValue="config"
        className={styles.tabs}
        contentClassName={styles.tabPanel}
        scrollable
        scrollMode="root"
        tabs={[
          {
            value: 'config',
            label: t('settings:configTab'),
            content: (
              <FloatingTabContent>
                <div className={styles.tabBody}>
                  <GenerationPresetEditor />
                </div>
              </FloatingTabContent>
            ),
          },
          {
            value: 'api',
            label: t('settings:apiTab'),
            content: (
              <FloatingTabContent>
                <div className={styles.tabBody}>
                  <ProviderProfileEditor />
                </div>
              </FloatingTabContent>
            ),
          },
          {
            value: 'advanced',
            label: t('settings:advancedTab'),
            content: (
              <FloatingTabContent>
                <div className={styles.tabBody}>
                  <AdvancedPromptSettings />
                </div>
              </FloatingTabContent>
            ),
          },
        ]}
      />
    </FloatingTabPanel>
  );
}

function AdvancedPromptSettings() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const mode = settings.data?.promptTemplate.mode ?? 'chat';
  const [formError, setFormError] = useState<string | null>(null);

  const changeMode = async (nextMode: 'chat' | 'text'): Promise<void> => {
    if (!settings.data) return;
    try {
      await updateSettings.mutateAsync({
        promptTemplate: { ...settings.data.promptTemplate, mode: nextMode },
      });
      setFormError(null);
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  return (
    <div className={styles.templateEditor} data-component="advanced-prompt-settings">
      <div
        className={styles.modeSwitch}
        role="radiogroup"
        aria-labelledby="prompt-template-mode-label"
      >
        <span id="prompt-template-mode-label" className={styles.modeSwitchLabel}>
          {t('settings:promptMode')}
        </span>
        {PromptTemplateModes.map((value) => (
          <label key={value} data-state={mode === value ? 'active' : 'inactive'}>
            <input
              type="radio"
              name="prompt-template-mode"
              value={value}
              checked={mode === value}
              disabled={settings.isLoading || updateSettings.isPending}
              onChange={() => void changeMode(value)}
            />
            <span>
              {value === 'chat' ? t('settings:chatTemplateMode') : t('settings:promptTemplateMode')}
            </span>
          </label>
        ))}
      </div>
      {formError ? (
        <p className={styles.inlineError} role="alert">
          {formError}
        </p>
      ) : null}
      {mode === 'chat' ? <ChatTemplateEditor /> : <PromptTemplateEditor />}
    </div>
  );
}
