/** Tests for the plugin process health panel (ADR-0066 P3c). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  hasHost: vi.fn(() => true),
  health: vi.fn(),
  stop: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('./processHost.js', () => ({ hasPluginProcessHost: mocks.hasHost }));

vi.mock('./usePluginProcessHealth.js', () => ({
  usePluginProcessHealth: () => mocks.health(),
  useStopPluginProcess: () => ({ mutate: mocks.stop, isPending: false }),
  useResetPluginProcess: () => ({ mutate: mocks.reset, isPending: false }),
}));

import { PluginProcessHealthPanel } from './PluginProcessHealthPanel.js';

afterEach(() => cleanup());

describe('PluginProcessHealthPanel', () => {
  it('shows the failure reason and restart count from the supervisor', () => {
    mocks.hasHost.mockReturnValue(true);
    mocks.health.mockReturnValue({
      data: { state: 'Failed', restarts: 5, lastError: 'segfault' },
      isError: false,
    });
    render(<PluginProcessHealthPanel pluginId="author.plugin" />);
    expect(screen.getByText('plugins:processStateFailed')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('segfault')).toBeInTheDocument();
  });

  it('explains that a browser session has no processes', () => {
    mocks.hasHost.mockReturnValue(false);
    render(<PluginProcessHealthPanel pluginId="author.plugin" />);
    expect(screen.getByText('plugins:processNoHost')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('sends stop and reset to the host', async () => {
    mocks.hasHost.mockReturnValue(true);
    mocks.health.mockReturnValue({
      data: { state: 'Running', restarts: 0, lastError: '' },
      isError: false,
    });
    render(<PluginProcessHealthPanel pluginId="author.plugin" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'plugins:processStop' }));
    await user.click(screen.getByRole('button', { name: 'plugins:processReset' }));
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.reset).toHaveBeenCalledTimes(1);
  });

  it('reports an unavailable state instead of an empty frame', () => {
    mocks.hasHost.mockReturnValue(true);
    mocks.health.mockReturnValue({ data: undefined, isError: true });
    render(<PluginProcessHealthPanel pluginId="author.plugin" />);
    expect(screen.getByRole('alert')).toHaveTextContent('plugins:processUnavailable');
  });
});
