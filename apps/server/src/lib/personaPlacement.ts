/**
 * Prompt placement of the active persona, read from the UI-owned settings
 * bag. The typed parser lives in @neotavern/contracts (ARCH-13); this helper only
 * applies the server default. Renamed from `personasUi.ts` — on the server
 * this is prompt-placement logic, not UI (ARCH-13).
 */
import { parsePersonasUi, type AppSettings, type PersonaPlacementId } from '@neotavern/contracts';

export function readPersonaPlacement(settings: AppSettings): PersonaPlacementId {
  return parsePersonasUi(settings.ui).placement ?? 'persona';
}
