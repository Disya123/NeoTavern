/**
 * Generation tool-registry hooks (ТЗ §8.3, М5 slice 43).
 *
 * `generation.tools.list` returns the declarative tool contracts the host
 * registered with the kernel (id, name, description, input JSON-Schema).
 * The kernel validates provider tool calls against these contracts but NEVER
 * executes tools itself — the host performs the effect. The panel renders the
 * registry so the user can see which tools exist and what they require
 * (transparency before any consent, §13.2).
 */
import { useQuery } from '@tanstack/react-query';
import { backend } from './backend.js';

export function useGenerationTools() {
  return useQuery({
    queryKey: ['generation-tools'],
    queryFn: () => backend.generation.tools.list(),
    staleTime: 30_000,
  });
}
