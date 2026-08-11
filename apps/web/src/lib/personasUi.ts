/**
 * Personas UI settings live on the untyped `settings.ui` bag; the typed view
 * and its parser come from @neotavern/contracts (ARCH-13) so server and client can
 * never drift. This module keeps only the web-side update merge.
 */
import {
  parsePersonasUi,
  type AppSettings,
  type AppSettingsUpdate,
  type PersonasUiSettings,
} from '@neotavern/contracts';

export type { PersonaPlacementId, PersonasUiSettings } from '@neotavern/contracts';
export { PersonaPlacements as PERSONA_PLACEMENTS } from '@neotavern/contracts';

export function readPersonasUi(settings: AppSettings | undefined): PersonasUiSettings {
  return parsePersonasUi(settings?.ui);
}

export function mergePersonasUiUpdate(
  settings: AppSettings | undefined,
  patch: Partial<PersonasUiSettings>,
): AppSettingsUpdate {
  const current = readPersonasUi(settings);
  const ui = settings?.ui;
  return {
    ui: {
      ...(typeof ui === 'object' && ui !== null && !Array.isArray(ui) ? ui : {}),
      personas: {
        ...current,
        ...patch,
      },
    },
  };
}
