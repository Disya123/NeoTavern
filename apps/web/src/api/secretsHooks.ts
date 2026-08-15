/**
 * Secret-store status hooks (ТЗ §SEC-01.1, Этап 4 slice 7 remainder).
 *
 * The canonical plane exposes ONLY a value-free status surface (wire
 * `secrets.status`): the UI renders the honest store mode — portable
 * encrypted / machine-bound / session-only / fail-closed unavailable — and
 * never requests a value (there is no reveal operation by design).
 */
import { useQuery } from '@tanstack/react-query';
import { backend } from './backend.js';

export function useSecretsStatus() {
  return useQuery({
    queryKey: ['secrets-status'],
    queryFn: () => backend.secrets.status(),
    staleTime: 30_000,
  });
}
