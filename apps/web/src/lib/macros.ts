import { useMemo } from 'react';
import { pickActivePersona, type Persona } from '@neotavern/contracts';
import { buildMacroContext, replaceMacros, type MacroContext } from '@neotavern/shared';
import { usePersonas, useSettings } from '../api/hooks.js';

export { buildMacroContext, replaceMacros, type MacroContext };

/**
 * Resolve the active persona for a chat (chat override → app active persona →
 * default) — delegates to the shared contracts rule so server and client
 * never drift (ARCH-13).
 */
export function resolveActivePersona(
  personas: readonly Persona[],
  personaId: string | null | undefined,
  activePersonaId: string | null | undefined,
): Persona | null {
  return pickActivePersona(personas, personaId, activePersonaId);
}

export function useMacroContext(input: {
  charName?: string | null;
  personaId?: string | null;
}): MacroContext {
  const settings = useSettings();
  const personas = usePersonas();
  return useMemo(() => {
    const persona = resolveActivePersona(
      personas.data?.items ?? [],
      input.personaId,
      settings.data?.activePersonaId,
    );
    return buildMacroContext({
      userName: persona?.name,
      charName: input.charName,
      variables: settings.data?.macroVariables,
    });
  }, [
    input.charName,
    input.personaId,
    personas.data?.items,
    settings.data?.activePersonaId,
    settings.data?.macroVariables,
  ]);
}

export function expandDisplayMacros(text: string, context: MacroContext): string {
  return replaceMacros(text, context);
}
