/**
 * HostConnect gate: Theme SDK chrome, local / link / QR modes, no hardcoded
 * palette. Local mode is Android-shell only.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WIRE_PROTOCOL, WIRE_SCHEMA_HASH } from '@neotavern/contracts';
import { renderWithProviders } from '../../test/helpers.js';
import { HostConnect } from './HostConnect.js';
import { clearHostSession, openHostConnect, writeHostSession } from '../api/hostSession.js';
import type * as hostSession from '../api/hostSession.js';

vi.mock('../lib/mobile.js', () => ({
  isMobileShell: () => true,
}));

const hostConnectMocks = vi.hoisted(() => ({
  needsHostConnect: vi.fn(() => true),
  readConnectQuery: vi.fn((): string | null => null),
}));

vi.mock('../api/hostSession.js', async () => {
  const actual = await vi.importActual<typeof hostSession>('../api/hostSession.js');
  return {
    ...actual,
    needsHostConnect: hostConnectMocks.needsHostConnect,
    readConnectQuery: hostConnectMocks.readConnectQuery,
  };
});

function fakeBridge(): unknown {
  return {
    handshake: () =>
      JSON.stringify({
        ffiAbiVersion: 1,
        schemaHash: WIRE_SCHEMA_HASH,
        wireProtocol: { major: WIRE_PROTOCOL.major, minor: WIRE_PROTOCOL.minor },
        appVersion: '0.1.0',
      }),
    call: () => undefined,
    cancelStream: () => undefined,
  };
}

beforeEach(() => {
  vi.stubGlobal('__neotavernMobile', fakeBridge());
  hostConnectMocks.needsHostConnect.mockReturnValue(true);
  hostConnectMocks.readConnectQuery.mockReturnValue(null);
  clearHostSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearHostSession();
  cleanup();
});

describe('HostConnect', () => {
  it('renders Theme SDK chrome (card + button + tokens, not a one-off palette)', async () => {
    const rendered = await renderWithProviders(
      <HostConnect>
        <div>Workspace</div>
      </HostConnect>,
    );
    const gate = rendered.container.querySelector('[data-component="host-connect"]');
    expect(gate).not.toBeNull();
    expect(gate?.querySelector('[data-component="card"]')).not.toBeNull();
    expect(gate?.querySelector('[data-component="button"]')).not.toBeNull();
    expect(gate?.querySelector('[data-component="segmented"]')).not.toBeNull();
    expect(gate?.querySelector('[data-part="mark"]')).not.toBeNull();
    expect(gate?.className).toBe('');
    expect(screen.queryByText('Workspace')).not.toBeInTheDocument();
  });

  it('enters the local kernel on Use on this device', async () => {
    const rendered = await renderWithProviders(
      <HostConnect>
        <div>Workspace</div>
      </HostConnect>,
    );
    const gate = within(rendered.container);
    await userEvent.click(gate.getByRole('button', { name: 'Use on this device' }));
    await waitFor(() => {
      expect(gate.getByText('Workspace')).toBeInTheDocument();
    });
    expect(rendered.container.querySelector('[data-component="host-connect"]')).toBeNull();
  });

  it('rejects an invalid link without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const rendered = await renderWithProviders(
      <HostConnect>
        <div>Workspace</div>
      </HostConnect>,
    );
    const gate = within(rendered.container);
    await userEvent.click(gate.getByRole('button', { name: 'Link' }));
    await userEvent.type(gate.getByLabelText('Server address'), 'not-a-url');
    await userEvent.click(gate.getByRole('button', { name: 'Connect' }));
    expect(await gate.findByRole('alert')).toHaveTextContent('Enter a valid http(s) address');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gate.queryByText('Workspace')).not.toBeInTheDocument();
  });

  it('keeps QR mode with a paste field when the camera scanner is missing', async () => {
    const rendered = await renderWithProviders(
      <HostConnect>
        <div>Workspace</div>
      </HostConnect>,
    );
    const gate = within(rendered.container);
    await userEvent.click(gate.getByRole('button', { name: 'QR code' }));
    expect(gate.getByLabelText('Pairing link')).toBeInTheDocument();
    expect(gate.queryByRole('button', { name: 'Scan QR code' })).not.toBeInTheDocument();
    expect(gate.getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(gate.queryByText('Workspace')).not.toBeInTheDocument();
  });

  it('lets an existing session dismiss the gate without clearing the host', async () => {
    writeHostSession({ kind: 'local' });
    const rendered = await renderWithProviders(
      <HostConnect>
        <div>Workspace</div>
      </HostConnect>,
    );
    const gate = within(rendered.container);
    await userEvent.click(gate.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(gate.getByText('Workspace')).toBeInTheDocument();
    });
    expect(rendered.container.querySelector('[data-component="host-connect"]')).toBeNull();
    expect(localStorage.getItem('neotavern.hostSession')).toContain('local');
  });

  it('reopens from openHostConnect and keeps the previous session on Cancel', async () => {
    hostConnectMocks.needsHostConnect.mockReturnValue(false);
    writeHostSession({ kind: 'remote', url: 'http://192.168.1.10:8080' });
    const rendered = await renderWithProviders(
      <HostConnect>
        <div>Workspace</div>
      </HostConnect>,
    );
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(rendered.container.querySelector('[data-component="host-connect"]')).toBeNull();

    openHostConnect();
    await waitFor(() => {
      expect(rendered.container.querySelector('[data-component="host-connect"]')).not.toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Use on this device' })).toBeInTheDocument();
    const gate = within(rendered.container);
    await userEvent.click(gate.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(gate.getByText('Workspace')).toBeInTheDocument();
    });
    expect(JSON.parse(localStorage.getItem('neotavern.hostSession') ?? 'null')).toEqual({
      kind: 'remote',
      url: 'http://192.168.1.10:8080',
    });
  });

  it('reopens a local session on the Link tab so the host can be changed', async () => {
    hostConnectMocks.needsHostConnect.mockReturnValue(false);
    writeHostSession({ kind: 'local' });
    const rendered = await renderWithProviders(
      <HostConnect>
        <div>Workspace</div>
      </HostConnect>,
    );
    expect(screen.getByText('Workspace')).toBeInTheDocument();

    openHostConnect();
    await waitFor(() => {
      expect(rendered.container.querySelector('[data-component="host-connect"]')).not.toBeNull();
    });
    expect(screen.getByLabelText('Server address')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches from This device to Link on the segmented control', async () => {
    const rendered = await renderWithProviders(
      <HostConnect>
        <div>Workspace</div>
      </HostConnect>,
    );
    const gate = within(rendered.container);
    expect(gate.getByRole('button', { name: 'Use on this device' })).toBeInTheDocument();
    await userEvent.click(gate.getByRole('button', { name: 'Link' }));
    expect(gate.getByLabelText('Server address')).toBeInTheDocument();
  });
});
