/**
 * Remote access API tests: command names, payload serialization to the
 * nullable wire shape, and `CODE: message` → RemoteAccessError mapping.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  RemoteAccessError,
  remotePair,
  remoteRevoke,
  remoteStart,
  remoteStatus,
  remoteStop,
  type RemoteStatus,
} from './remoteAccess.js';

/** Mocking pattern: the module is replaced with a plain `vi.fn()` invoke. */
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

const STATUS: RemoteStatus = {
  running: true,
  bind: '127.0.0.1',
  port: 41234,
  streams: 2,
  authEnabled: true,
  credentials: [{ id: 'c1', label: 'Phone', revoked: false, createdAt: 1780000000000 }],
  auditEvents: 5,
  lastError: null,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('remote access API', () => {
  it('remoteStatus resolves the status from kernel_remote_status', async () => {
    invokeMock.mockResolvedValue(STATUS);

    await expect(remoteStatus()).resolves.toEqual(STATUS);
    expect(invokeMock).toHaveBeenCalledWith('kernel_remote_status');
  });

  it('remoteStart serializes the payload to the nullable wire shape', async () => {
    invokeMock.mockResolvedValue(STATUS);
    const payload = {
      bind: '127.0.0.1',
      port: 0,
      authEnabled: true,
      allowedOrigins: ['https://a.example', 'https://b.example'],
    };

    await expect(remoteStart(payload)).resolves.toEqual(STATUS);
    expect(invokeMock).toHaveBeenCalledWith('kernel_remote_start', payload);
  });

  it('remoteStart fills missing fields with null', async () => {
    invokeMock.mockResolvedValue(STATUS);

    await remoteStart({ bind: '::1' });
    expect(invokeMock).toHaveBeenCalledWith('kernel_remote_start', {
      bind: '::1',
      port: null,
      authEnabled: null,
      allowedOrigins: null,
    });
  });

  it('remoteStop, remotePair and remoteRevoke use their commands', async () => {
    invokeMock.mockResolvedValue(null);
    await remoteStop();
    expect(invokeMock).toHaveBeenCalledWith('kernel_remote_stop');

    invokeMock.mockResolvedValue({ id: 'p1', token: 'tok' });
    await remotePair('Phone');
    expect(invokeMock).toHaveBeenCalledWith('kernel_remote_pair', { label: 'Phone' });
    await remotePair();
    expect(invokeMock).toHaveBeenCalledWith('kernel_remote_pair', { label: null });

    invokeMock.mockResolvedValue(true);
    await expect(remoteRevoke('c1')).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('kernel_remote_revoke', { id: 'c1' });
  });

  it('maps a REMOTE_INSECURE_BIND rejection to RemoteAccessError with its code', async () => {
    invokeMock.mockRejectedValue('REMOTE_INSECURE_BIND: loopback required');

    await expect(remoteStart({ bind: '0.0.0.0' })).rejects.toBeInstanceOf(RemoteAccessError);
    await expect(remoteStart({ bind: '0.0.0.0' })).rejects.toMatchObject({
      code: 'REMOTE_INSECURE_BIND',
      message: 'loopback required',
    });
  });

  it('maps an unknown rejection shape to REMOTE_INTERNAL', async () => {
    invokeMock.mockRejectedValue('boom');

    await expect(remoteStatus()).rejects.toBeInstanceOf(RemoteAccessError);
    await expect(remoteStatus()).rejects.toMatchObject({ code: 'REMOTE_INTERNAL' });
  });
});
