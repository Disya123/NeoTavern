/**
 * RemoteAccessPanel tests: browser-gated rendering, status card, start/stop,
 * pairing (token shown once + copy), revoke, and lastError surfacing.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/helpers.js';
import { isTauriRuntime } from '../api/tauriTransport.js';
import {
  remotePair,
  remoteRevoke,
  remoteStart,
  remoteStatus,
  remoteStop,
  type RemoteStatus,
} from '../api/remoteAccess.js';
import { RemoteAccessPanel } from './RemoteAccessPanel.js';

vi.mock('../api/tauriTransport.js', () => ({
  isTauriRuntime: vi.fn(),
}));

vi.mock('../api/remoteAccess.js', () => ({
  RemoteAccessError: class RemoteAccessError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'RemoteAccessError';
      this.code = code;
    }
  },
  parseRemoteError: (message: string) => {
    const match = /^([A-Z][A-Z0-9_]*): (.*)$/s.exec(message);
    return match ? { code: match[1], message: match[2] } : null;
  },
  remoteStatus: vi.fn(),
  remoteStart: vi.fn(),
  remoteStop: vi.fn(),
  remotePair: vi.fn(),
  remoteRevoke: vi.fn(),
}));

const STOPPED_STATUS: RemoteStatus = {
  running: false,
  bind: null,
  port: null,
  streams: 0,
  authEnabled: true,
  credentials: [],
  auditEvents: 0,
  lastError: null,
};

const RUNNING_STATUS: RemoteStatus = {
  running: true,
  bind: '127.0.0.1',
  port: 41234,
  streams: 2,
  authEnabled: true,
  credentials: [
    { id: 'c1', label: 'Phone', revoked: false, createdAt: 1780000000000 },
    { id: 'c2', label: null, revoked: true, createdAt: 1780000000000 },
  ],
  auditEvents: 5,
  lastError: null,
};

afterEach(() => {
  cleanup();
  // Module-fn mocks persist across tests: clear call history and queued
  // implementations so call-count assertions see only the current test.
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('RemoteAccessPanel', () => {
  it('renders nothing and never invokes the bridge in a plain browser', async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(false);

    const { container } = await renderWithProviders(<RemoteAccessPanel />);

    expect(container.firstChild).toBeNull();
    expect(remoteStatus).not.toHaveBeenCalled();
  });

  it('renders running status with bind, port, streams, audit events and credentials', async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(remoteStatus).mockResolvedValue(RUNNING_STATUS);

    await renderWithProviders(<RemoteAccessPanel />);

    expect(await screen.findByText('Running')).toBeTruthy();
    const statusSection = screen.getByLabelText('Remote access');
    expect(within(statusSection).getByText('127.0.0.1')).toBeTruthy();
    expect(within(statusSection).getByText('41234')).toBeTruthy();
    expect(within(statusSection).getByText('2')).toBeTruthy();
    expect(within(statusSection).getByText('5')).toBeTruthy();
    expect(screen.getByText('Phone')).toBeTruthy();
    expect(screen.getByText('Revoked')).toBeTruthy();
  });

  it('starts the server with the form payload and refetches status', async () => {
    const user = userEvent.setup();
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(remoteStatus)
      .mockResolvedValueOnce(STOPPED_STATUS)
      .mockResolvedValueOnce(RUNNING_STATUS);
    vi.mocked(remoteStart).mockResolvedValue(RUNNING_STATUS);

    await renderWithProviders(<RemoteAccessPanel />);
    expect(await screen.findByText('Stopped')).toBeTruthy();

    await user.type(
      screen.getByLabelText('Allowed origins (comma-separated)'),
      'https://a.example, https://b.example',
    );
    await user.click(screen.getByRole('button', { name: 'Start server' }));

    await waitFor(() => {
      expect(remoteStart).toHaveBeenCalledWith({
        bind: '127.0.0.1',
        port: 0,
        authEnabled: true,
        allowedOrigins: ['https://a.example', 'https://b.example'],
      });
    });
    await waitFor(() => {
      expect(remoteStatus).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText('Running')).toBeTruthy();
  });

  it('stops the server', async () => {
    const user = userEvent.setup();
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(remoteStatus).mockResolvedValueOnce(RUNNING_STATUS).mockResolvedValueOnce(STOPPED_STATUS);

    await renderWithProviders(<RemoteAccessPanel />);
    await screen.findByText('Running');

    await user.click(screen.getByRole('button', { name: 'Stop server' }));

    await waitFor(() => {
      expect(remoteStop).toHaveBeenCalled();
    });
    expect(await screen.findByText('Stopped')).toBeTruthy();
  });

  it('pairs a device, shows the token once and copies it', async () => {
    const user = userEvent.setup();
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(remoteStatus).mockResolvedValue(STOPPED_STATUS);
    vi.mocked(remotePair).mockResolvedValue({ id: 'p1', token: 'tok-abc' });
    const clipboardWrite = vi.fn(async () => undefined);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
      writeText: clipboardWrite,
    } as unknown as Clipboard);

    await renderWithProviders(<RemoteAccessPanel />);
    expect(await screen.findByText('No paired devices yet.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Pair device' }));

    await waitFor(() => {
      expect(remotePair).toHaveBeenCalledWith(undefined);
    });
    expect(await screen.findByText('tok-abc')).toBeTruthy();
    expect(
      screen.getByText('Show this token only once — it is not stored and cannot be shown again.'),
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledWith('tok-abc');
    });
    expect(screen.getByText('Copied')).toBeTruthy();
  });

  it('pairs with an optional device label', async () => {
    const user = userEvent.setup();
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(remoteStatus).mockResolvedValue(STOPPED_STATUS);
    vi.mocked(remotePair).mockResolvedValue({ id: 'p2', token: 'tok-2' });

    await renderWithProviders(<RemoteAccessPanel />);
    await screen.findByText('No paired devices yet.');

    await user.type(screen.getByLabelText('Device label (optional)'), 'Laptop');
    await user.click(screen.getByRole('button', { name: 'Pair device' }));

    await waitFor(() => {
      expect(remotePair).toHaveBeenCalledWith('Laptop');
    });
  });

  it('revokes a credential and refetches status', async () => {
    const user = userEvent.setup();
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(remoteStatus).mockResolvedValue(RUNNING_STATUS);
    vi.mocked(remoteRevoke).mockResolvedValue(true);

    await renderWithProviders(<RemoteAccessPanel />);
    expect(await screen.findByText('Phone')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(remoteRevoke).toHaveBeenCalledWith('c1');
    });
    await waitFor(() => {
      expect(remoteStatus).toHaveBeenCalledTimes(2);
    });
  });

  it('surfaces the last server error as localized text', async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(remoteStatus).mockResolvedValue({
      ...STOPPED_STATUS,
      lastError: 'REMOTE_START_FAILED: bind failed',
    });

    await renderWithProviders(<RemoteAccessPanel />);

    expect(await screen.findByText('The remote server could not be started.')).toBeTruthy();
  });

  it('surfaces an action error with a REMOTE_* code', async () => {
    const user = userEvent.setup();
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(remoteStatus).mockResolvedValue(STOPPED_STATUS);
    vi.mocked(remoteStart).mockRejectedValue(
      new Error('REMOTE_INSECURE_BIND: loopback required'),
    );

    await renderWithProviders(<RemoteAccessPanel />);
    await screen.findByText('Stopped');

    await user.click(screen.getByRole('button', { name: 'Start server' }));

    expect(
      await screen.findByText('Non-loopback binding requires the trusted-proxy option.'),
    ).toBeTruthy();
  });
});
