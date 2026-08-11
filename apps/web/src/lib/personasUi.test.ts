import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMPT_TEMPLATE } from '@neotavern/contracts';
import { readPersonasUi } from './personasUi.js';

describe('readPersonasUi', () => {
  it('returns defaults for missing ui settings', () => {
    expect(readPersonasUi(undefined)).toEqual({});
  });

  it('reads placement and toggles from settings.ui.personas', () => {
    expect(
      readPersonasUi({
        language: 'en',
        themeId: null,
        activeProviderConfigId: null,
        activePersonaId: null,
        contextStrategy: 'truncate',
        maxContextTokens: 8192,
        generationDefaults: {},
        activeGenerationPresetId: null,
        activePromptTemplatePresetId: null,
        promptTemplate: DEFAULT_PROMPT_TEMPLATE,
        instructFormat: null,
        instructFormatId: null,
        ui: {
          personas: {
            placement: 'authors-note-top',
            autoLockToChat: true,
          },
        },
      }),
    ).toEqual({
      placement: 'authors-note-top',
      autoLockToChat: true,
    });
  });
});
