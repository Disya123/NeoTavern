/** Tests for the plugin process health hooks (ADR-0066 P3c). */
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createQueryClient } from '../../test/helpers.js';

const hostMock = vi.hoisted(() => ({
  hasPluginProcessHost: vi.fn(() => true),
  readPluginProcessStatus: vi.fn(),
  stopPluginProcess: vi.fn(),
  resetPluginProcess: vi.fn(),
}));

vi.mock('./processHost.js', () => ({
  hasPluginProcessHost: hostMock.hasPluginProcessHost,
  readPluginProcessStatus: hostMock.readPluginProcessStatus,
  stopPluginProcess: hostMock.stopPluginProcess,
  resetPluginProcess: hostMock.resetPluginProcess,
}));

import {
  pluginProcessKey,
  usePluginProcessHealth,
  useResetPluginProcess,
  useStopPluginProcess,
} from './usePluginProcessHealth.js';

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

let client: QueryClient;

beforeEach(() => {
  hostMock.hasPluginProcessHost.mockReturnValue(true);
  hostMock.readPluginProcessStatus.mockReset();
  hostMock.stopPluginProcess.mockReset();
  hostMock.resetPluginProcess.mockReset();
  client = createQueryClient();
});

afterEach(() => {
  client.clear();
});

describe('plugin process health', () => {
  it('reads the supervisor state for a plugin', async () => {
    hostMock.readPluginProcessStatus.mockResolvedValue({
      state: 'Backoff',
      restarts: 2,
      lastError: 'segfault',
    });
    const { result } = renderHook(() => usePluginProcessHealth('author.plugin'), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      state: 'Backoff',
      restarts: 2,
      lastError: 'segfault',
    });
    expect(client.getQueryData(pluginProcessKey('author.plugin'))).toBeDefined();
  });

  it('stays idle without a host instead of polling forever', () => {
    hostMock.hasPluginProcessHost.mockReturnValue(false);
    const { result } = renderHook(() => usePluginProcessHealth('author.plugin'), {
      wrapper: wrapperFor(client),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(hostMock.readPluginProcessStatus).not.toHaveBeenCalled();
  });

  it('stops and resets through the host and refreshes the panel', async () => {
    hostMock.readPluginProcessStatus.mockResolvedValue({
      state: 'Failed',
      restarts: 5,
      lastError: 'boom',
    });
    hostMock.stopPluginProcess.mockResolvedValue(undefined);
    hostMock.resetPluginProcess.mockResolvedValue(undefined);

    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(
      () => ({
        stop: useStopPluginProcess('author.plugin'),
        reset: useResetPluginProcess('author.plugin'),
      }),
      { wrapper: wrapperFor(client) },
    );

    await act(async () => {
      await result.current.stop.mutateAsync();
      await result.current.reset.mutateAsync();
    });

    expect(hostMock.stopPluginProcess).toHaveBeenCalledWith('author.plugin');
    expect(hostMock.resetPluginProcess).toHaveBeenCalledWith('author.plugin');
    // Invalidation makes the next read happen; the panel never shows a stale failure.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: pluginProcessKey('author.plugin') });
  });
});
