import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InstructTemplateRoles, type CustomInstructFormat } from '@neotavern/contracts';
import { Button } from '@neotavern/ui';
import { useInstructFormats, useSettings, useUpdateSettings } from '../../api/hooks.js';
import { useErrorText } from '../../lib/useErrorText.js';
import styles from './AiSettings.module.css';

const DEFAULT_CUSTOM_TEMPLATE: CustomInstructFormat = {
  id: 'custom-chatml',
  version: 1,
  system: '<|im_start|>system\n{{{content}}}<|im_end|>\n',
  user: '<|im_start|>user\n{{{content}}}<|im_end|>\n',
  assistant: '<|im_start|>assistant\n{{{content}}}<|im_end|>\n',
  tool: '<|im_start|>tool\n{{{content}}}<|im_end|>\n',
  promptSuffix: '<|im_start|>assistant\n',
  stopStrings: ['<|im_end|>'],
};

export function ChatTemplateEditor() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const settings = useSettings();
  const formats = useInstructFormats();
  const updateSettings = useUpdateSettings();
  const [draft, setDraft] = useState<CustomInstructFormat>(DEFAULT_CUSTOM_TEMPLATE);
  const [selection, setSelection] = useState('native');
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data?.instructFormat) {
      setDraft(cloneTemplate(settings.data.instructFormat));
      setSelection('custom');
      return;
    }
    setSelection(settings.data?.instructFormatId ?? 'native');
  }, [settings.data?.instructFormat, settings.data?.instructFormatId]);

  const changeSelection = async (value: string): Promise<void> => {
    setSelection(value);
    if (value === 'custom') return;
    try {
      await updateSettings.mutateAsync({
        instructFormat: null,
        instructFormatId: value === 'native' ? null : value,
      });
      setFormError(null);
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  const save = async (): Promise<void> => {
    try {
      await updateSettings.mutateAsync({ instructFormat: draft, instructFormatId: null });
      setSelection('custom');
      setFormError(null);
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  return (
    <section className={styles.templateEditor} data-component="chat-template-editor">
      <div className={styles.sectionHeading}>
        <strong>{t('settings:templateEditor')}</strong>
        <span>{t('settings:templateEditorHint')}</span>
      </div>
      <label className={styles.field}>
        <span>{t('settings:chatSerialization')}</span>
        <select
          value={selection}
          disabled={updateSettings.isPending || formats.isLoading}
          onChange={(event) => void changeSelection(event.target.value)}
        >
          <option value="native">{t('settings:chatSerializationNative')}</option>
          {(formats.data?.formats ?? []).map((format) => (
            <option key={format.id} value={format.id}>
              {format.id}
            </option>
          ))}
          <option value="custom">{t('settings:chatSerializationCustom')}</option>
        </select>
        <small>
          {selection === 'native'
            ? t('settings:chatSerializationNativeHint')
            : t('settings:chatSerializationExplicitHint')}
        </small>
      </label>

      {selection === 'custom' ? (
        <>
          <div className={styles.templateFields}>
            {InstructTemplateRoles.map((role) => (
              <label key={role} className={styles.field}>
                <span>{t(`settings:${role}Template`)}</span>
                <textarea
                  value={draft[role]}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, [role]: event.target.value }))
                  }
                />
              </label>
            ))}
            <label className={styles.field}>
              <span>{t('settings:promptSuffix')}</span>
              <textarea
                value={draft.promptSuffix}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, promptSuffix: event.target.value }))
                }
              />
            </label>
            <label className={styles.field}>
              <span>{t('settings:stopStrings')}</span>
              <textarea
                value={draft.stopStrings.join('\n')}
                aria-describedby="chat-template-stop-hint"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    stopStrings: event.target.value
                      .split('\n')
                      .map((value) => value.trim())
                      .filter((value) => value.length > 0),
                  }))
                }
              />
              <small id="chat-template-stop-hint">{t('settings:stopStringsHint')}</small>
            </label>
          </div>
          <div className={styles.actionRow}>
            <Button
              variant="primary"
              disabled={updateSettings.isPending}
              onClick={() => void save()}
            >
              {t('settings:saveTemplate')}
            </Button>
          </div>
        </>
      ) : null}

      {formError ? (
        <p className={styles.inlineError} role="alert">
          {formError}
        </p>
      ) : null}
    </section>
  );
}

function cloneTemplate(template: CustomInstructFormat): CustomInstructFormat {
  return { ...template, stopStrings: [...template.stopStrings] };
}
