import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { PluginSurfaceHost } from './PluginSurfaceHost.js';
import { shellMode } from './shellMode.js';

beforeEach(() => shellMode.restore());
afterEach(() => cleanup());

describe('PluginSurfaceHost', () => {
  it('renders the stock application when no plugin owns the shell', () => {
    render(
      <PluginSurfaceHost>
        <div data-testid="stock-ui" />
      </PluginSurfaceHost>,
    );
    expect(screen.getByTestId('stock-ui')).toBeInTheDocument();
    expect(screen.queryByTitle('plugins:shellTitle')).toBeNull();
  });

  it('replaces the stock UI with an isolated frame when a plugin takes over', async () => {
    render(
      <PluginSurfaceHost>
        <div data-testid="stock-ui" />
      </PluginSurfaceHost>,
    );
    shellMode.replace('author.shell');

    const frame = await screen.findByTitle('plugins:shellTitle');
    expect(frame).toHaveAttribute('data-plugin-id', 'author.shell');
    expect(frame.getAttribute('src')).toBe('/plugin-sandbox.html?plugin=author.shell&frame=shell');
    // Opaque origin: scripts run, but nothing of the app is reachable.
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(screen.queryByTestId('stock-ui')).toBeNull();
  });

  it('brings the user back with a host-drawn control, not a plugin one', async () => {
    render(
      <PluginSurfaceHost>
        <div data-testid="stock-ui" />
      </PluginSurfaceHost>,
    );
    shellMode.replace('author.shell');
    const exit = await screen.findByRole('button', { name: 'plugins:shellExit' });
    await userEvent.click(exit);
    expect(shellMode.activePluginId()).toBeNull();
    expect(await screen.findByTestId('stock-ui')).toBeInTheDocument();
  });
});
