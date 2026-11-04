/**
 * Query hooks for plugin process health (ADR-0066 P3c).
 *
 * The supervisor lives in the kernel; this is the read side the Settings → Plugins
 * panel needs: current state, restart count, the last failure reason, and the two
 * operator actions. Polling is intentional — a crashed process has no way to push an
 * event, so the panel asks instead of waiting for a notification that will never come.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  hasPluginProcessHost,
  readPluginProcessStatus,
  resetPluginProcess,
  stopPluginProcess,
  type PluginProcessStatus,
} from './processHost.js';

/** Stable cache key for one plugin's process state. */
export function pluginProcessKey(pluginId: string) {
  return ['plugin-process', pluginId] as const;
}

const POLL_MS = 5_000;

/**
 * Reads a plugin's supervisory state.
 *
 * Disabled when there is no host: a browser session has no processes, and an empty
 * panel is more honest than a spinner that never resolves.
 */
export function usePluginProcessHealth(pluginId: string) {
  return useQuery<PluginProcessStatus>({
    queryKey: pluginProcessKey(pluginId),
    queryFn: () => readPluginProcessStatus(pluginId),
    enabled: pluginId.length > 0 && hasPluginProcessHost(),
    refetchInterval: POLL_MS,
    staleTime: POLL_MS / 2,
  });
}

/** Operator stop; the failure history stays for the panel. */
export function useStopPluginProcess(pluginId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => stopPluginProcess(pluginId),
    onSuccess: () => client.invalidateQueries({ queryKey: pluginProcessKey(pluginId) }),
  });
}

/** Operator reset; a plugin that exhausted its restarts may start again. */
export function useResetPluginProcess(pluginId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => resetPluginProcess(pluginId),
    onSuccess: () => client.invalidateQueries({ queryKey: pluginProcessKey(pluginId) }),
  });
}
