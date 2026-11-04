import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import {
  hasPluginProcessHost,
  parseOutcome,
  parseStatus,
  readPluginProcessStatus,
  resetPluginProcess,
  startPluginProcess,
  stopPluginProcess,
} from './processHost.js';
import { UnsupportedError } from '@neotavern/neobackend';

describe('plugin process host bridge', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  });

  it('refuses honestly when there is no shell', async () => {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
    expect(hasPluginProcessHost()).toBe(false);
    await expect(
      startPluginProcess('author.plugin', '1.0.0', 'native/agent.exe'),
    ).rejects.toBeInstanceOf(UnsupportedError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('parses a crash with its reason', () => {
    expect(parseOutcome('Crash|1500|plugin process exited with code 7')).toEqual({
      kind: 'Crash',
      elapsedMs: 1500,
      detail: 'plugin process exited with code 7',
    });
    expect(parseOutcome('Hang|300|')).toEqual({ kind: 'Hang', elapsedMs: 300, detail: '' });
    expect(parseOutcome('garbage')).toEqual({ kind: 'Unknown', elapsedMs: 0, detail: '' });
  });

  it('parses supervisor status including a failure reason with separators', () => {
    expect(parseStatus('Failed|5|boom|again')).toEqual({
      state: 'Failed',
      restarts: 5,
      lastError: 'boom|again',
    });
    expect(parseStatus('Running|0|')).toEqual({ state: 'Running', restarts: 0, lastError: '' });
  });

  it('forwards start with a package-relative entry and no path building', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    invoke.mockResolvedValue('Clean|1200|');
    const outcome = await startPluginProcess(
      'author.plugin',
      '2.1.0',
      'native/win/agent.exe',
      5000,
    );
    expect(outcome).toEqual({ kind: 'Clean', elapsedMs: 1200, detail: '' });
    expect(invoke).toHaveBeenCalledWith('plugin_process_start', {
      pluginId: 'author.plugin',
      version: '2.1.0',
      entry: 'native/win/agent.exe',
      timeoutMs: 5000,
    });
  });

  it('reads status, stops and resets through the host', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    invoke.mockResolvedValueOnce('Backoff|2|segfault');
    await expect(readPluginProcessStatus('author.plugin')).resolves.toEqual({
      state: 'Backoff',
      restarts: 2,
      lastError: 'segfault',
    });
    invoke.mockResolvedValue(null);
    await stopPluginProcess('author.plugin');
    await resetPluginProcess('author.plugin');
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      'plugin_process_status',
      'plugin_process_stop',
      'plugin_process_reset',
    ]);
  });
});
