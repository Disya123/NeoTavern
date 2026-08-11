import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { PluginAuthResult, parseAuthResultHash } from './PluginAuthResult.js';
import { renderWithProviders } from '../../test/helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseAuthResultHash', () => {
  it('parses a connected result', () => {
    expect(
      parseAuthResultHash(
        '#/plugin-auth-result?pluginId=author.p&serviceId=com.example.idp&status=connected',
      ),
    ).toEqual({
      pluginId: 'author.p',
      serviceId: 'com.example.idp',
      status: 'connected',
      reason: null,
    });
  });

  it('parses an error result with a reason', () => {
    expect(
      parseAuthResultHash(
        '#/plugin-auth-result?pluginId=author.p&serviceId=com.example.idp&status=error&reason=STATE_EXPIRED',
      ),
    ).toEqual({
      pluginId: 'author.p',
      serviceId: 'com.example.idp',
      status: 'error',
      reason: 'STATE_EXPIRED',
    });
  });

  it('treats a missing or invalid status as unknown', () => {
    expect(parseAuthResultHash('#/plugin-auth-result?status=weird').status).toBe('unknown');
    expect(parseAuthResultHash('')).toEqual({
      pluginId: null,
      serviceId: null,
      status: 'unknown',
      reason: null,
    });
  });
});

describe('PluginAuthResult', () => {
  it('renders the connected state and auto-closes the popup', async () => {
    vi.useFakeTimers();
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    try {
      await renderWithProviders(
        <PluginAuthResult hash="#/plugin-auth-result?serviceId=com.example.idp&status=connected" />,
      );
      expect(screen.getByText('Connected to com.example.idp.')).toBeTruthy();
      expect(close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1600);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the error state with the reason and closes on button click', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    await renderWithProviders(
      <PluginAuthResult hash="#/plugin-auth-result?serviceId=com.example.idp&status=error&reason=DENIED" />,
    );
    expect(
      screen.getByText('The connection to com.example.idp could not be completed.'),
    ).toBeTruthy();
    expect(screen.getByText('DENIED')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close window' }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not auto-close on error', async () => {
    vi.useFakeTimers();
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    try {
      await renderWithProviders(
        <PluginAuthResult hash="#/plugin-auth-result?status=error&reason=DENIED" />,
      );
      vi.advanceTimersByTime(5000);
      expect(close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the unknown state', async () => {
    await renderWithProviders(<PluginAuthResult hash="#/plugin-auth-result?status=weird" />);
    expect(screen.getByText('Unknown authorization state.')).toBeTruthy();
  });
});
