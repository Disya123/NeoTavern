/**
 * rev4 §G7: host overlay chrome (plugin name indicator + host-controlled
 * close) while a 'full' overlay is live. Drives the real runtime singleton
 * so the component exercises the same store the layout loop publishes to.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InstalledPlugin } from '@neotavern/contracts';
import { frontendPluginRuntime } from '../plugins/runtime.js';
import { PluginRuntimeUi } from './PluginRuntimeUi.js';
import { renderWithProviders } from '../../test/helpers.js';

function installedPlugin(): InstalledPlugin {
  return {
    id: 'test.chrome',
    name: 'Chrome Overlay',
    version: '1.0.0',
    apiVersion: 2,
    enabled: true,
    status: 'active',
    manifest: {},
    requestedPermissions: [],
    grantedPermissions: [],
    grantedCapabilities: [],
    addedPermissions: [],
    installedAt: 1,
    updatedAt: 1,
    hasFrontend: true,
    hasBackend: false,
    hasStyles: false,
    hasLegacyFrontend: false,
    hasLegacyBackend: false,
    compatibilityLevel: 'native-v2',
    trust: 'unsigned-untrusted',
    lastErrorCode: null,
  };
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function activateFullOverlay(): void {
  frontendPluginRuntime.sync([installedPlugin()]);
  const frame = frontendPluginRuntime.kernelGetFrame('test.chrome');
  if (!frame) throw new Error('frame missing');
  const container = document.createElement('div');
  frontendPluginRuntime.kernelMountOverlay(frame, 'full-1', container, 'full');
  frontendPluginRuntime.kernelAddRegistration({
    pluginId: 'test.chrome',
    pluginName: 'Chrome Overlay',
    registrationId: 'full-1',
    kind: 'overlays',
    definition: { id: 'full-1', title: 'Full overlay' },
  });
}

afterEach(async () => {
  // Unmount the rendered tree: without RTL auto-cleanup configured, a prior
  // test's instance would keep its window keydown listener and chrome-store
  // subscription live and interleave its deferred re-renders into the next
  // test.
  cleanup();
  // A layout flush scheduled under real timers cannot be cancelled by the
  // fake-timer realm below; let it fire first so a stale frame never touches
  // the next test.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  document.body.replaceChildren();
  // Frame removal is deferred (500 ms); flush it so the chrome store and
  // overlay entries never leak into the next test.
  vi.useFakeTimers();
  frontendPluginRuntime.clear();
  vi.advanceTimersByTime(600);
  vi.useRealTimers();
});

describe('plugin overlay chrome (rev4 §G7)', () => {
  it('shows the plugin name and closes the overlay via the host button', async () => {
    const user = userEvent.setup();
    activateFullOverlay();
    await nextFrame();
    await renderWithProviders(<PluginRuntimeUi />);

    const chrome = screen.getByRole('status');
    expect(chrome).toHaveAttribute('data-component', 'plugin-overlay-chrome');
    expect(chrome).toHaveAttribute('data-plugin-id', 'test.chrome');
    expect(chrome).toHaveTextContent('Plugin overlay active — Chrome Overlay');

    await user.click(screen.getByRole('button', { name: 'Close overlay (Esc)' }));
    expect(frontendPluginRuntime.getOverlayChrome()).toMatchObject({ active: false });
    expect(frontendPluginRuntime.kernelGetFrame('test.chrome')?.overlays.has('full-1')).toBe(false);
  });

  it('closes the overlay on Escape and restores the previous focus', async () => {
    const user = userEvent.setup();
    const trigger = document.createElement('button');
    trigger.textContent = 'app trigger';
    document.body.append(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    activateFullOverlay();
    await nextFrame();
    await renderWithProviders(<PluginRuntimeUi />);
    expect(frontendPluginRuntime.getOverlayChrome().active).toBe(true);

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(frontendPluginRuntime.getOverlayChrome()).toMatchObject({ active: false });
    });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('makes the app background inert while active and restores it after', async () => {
    const user = userEvent.setup();
    const main = document.createElement('main');
    main.setAttribute('data-component', 'main-area');
    document.body.append(main);

    activateFullOverlay();
    await nextFrame();
    await renderWithProviders(<PluginRuntimeUi />);
    expect(main.inert).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Close overlay (Esc)' }));
    await waitFor(() => expect(main.inert).toBe(false));
  });

  it('does not render without an active full overlay', async () => {
    await renderWithProviders(<PluginRuntimeUi />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(frontendPluginRuntime.getOverlayChrome()).toMatchObject({ active: false });
  });
});

describe('plugin crash toast (rev4 §M3)', () => {
  it('renders a host-owned crash notification for a restarted plugin', async () => {
    await renderWithProviders(<PluginRuntimeUi />);
    window.dispatchEvent(
      new CustomEvent('neotavern-plugin-crash', {
        detail: {
          pluginId: 'test.chrome',
          pluginName: 'Chrome Overlay',
          error: 'PLUGIN_UNRESPONSIVE',
          restartBudgetLeft: 2,
          disabled: false,
          crashedAt: Date.now(),
        },
      }),
    );
    expect(
      await screen.findByText('Plugin Chrome Overlay stopped responding and was restarted'),
    ).toBeInTheDocument();
    expect(screen.getByText('Automatic restarts left: 2')).toBeInTheDocument();
  });

  it('renders the crash-loop disable notification', async () => {
    await renderWithProviders(<PluginRuntimeUi />);
    window.dispatchEvent(
      new CustomEvent('neotavern-plugin-crash', {
        detail: {
          pluginId: 'test.chrome',
          pluginName: 'Chrome Overlay',
          error: 'PLUGIN_UNRESPONSIVE',
          restartBudgetLeft: 0,
          disabled: true,
          crashedAt: Date.now(),
        },
      }),
    );
    expect(
      await screen.findByText('Plugin Chrome Overlay was disabled after repeated crashes'),
    ).toBeInTheDocument();
  });
});
