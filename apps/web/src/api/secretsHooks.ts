/**
 * Secret-store hooks (ТЗ §SEC-01.1).
 *
 * The canonical plane exposes ONLY a value-free status surface (wire
 * `secrets.status`): the UI renders the honest store mode — portable
 * encrypted / machine-bound / session-only / fail-closed unavailable — and
 * never requests a value (there is no reveal operation by design).
 *
 * `useLockSecrets` is the manual lock (wire `secrets.lock`): the portable
 * store drops its derived key material in memory (best-effort zeroization).
 * Reads/writes then fail with `SECRET_STORE_LOCKED` until the host re-opens
 * the store with the master passphrase; the status query below is
 * invalidated so the panel honestly flips to `available: false`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { backend } from './backend.js';

export function useSecretsStatus() {
  return useQuery({
    queryKey: ['secrets-status'],
    queryFn: () => backend.secrets.status(),
    staleTime: 30_000,
  });
}

export function useLockSecrets() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => backend.secrets.lock(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['secrets-status'] }),
  });
}
