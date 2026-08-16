/**
 * ToolsPanel tests (М5 slice 43, ТЗ §8.3/§13.2): the panel renders the
 * declarative tool contracts from `generation.tools.list` (name, description,
 * required argument names) and shows an honest empty state when the host
 * registered none. It never renders tool arguments or results.
 */
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/helpers.js';
import { ToolsPanel } from './ToolsPanel.js';

const WEATHER_TOOL = {
  id: 'lookup-weather',
  name: 'lookup_weather',
  description: 'Look up the current weather for a city.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
};

const NOARGS_TOOL = {
  id: 'current-time',
  name: 'current_time',
  description: 'Return the current time.',
  inputSchema: { type: 'object', properties: {} },
};

vi.mock('../api/backend.js', () => ({
  backend: {
    generation: {
      tools: {
        list: vi.fn(async () => ({ items: [WEATHER_TOOL, NOARGS_TOOL] })),
      },
    },
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ToolsPanel', () => {
  it('lists the registered tool contracts with descriptions and required arguments', async () => {
    await renderWithProviders(<ToolsPanel />);

    await waitFor(() => expect(screen.getByText('lookup_weather')).toBeTruthy());
    expect(screen.getByText('current_time')).toBeTruthy();
    expect(screen.getByText('Look up the current weather for a city.')).toBeTruthy();
    expect(screen.getByText('Requires: query')).toBeTruthy();
    expect(screen.getByText('No required arguments.')).toBeTruthy();
  });

  it('shows an honest empty state when the host registered no tools', async () => {
    const { backend } = await import('../api/backend.js');
    vi.mocked(backend.generation.tools.list).mockResolvedValueOnce({ items: [] });
    await renderWithProviders(<ToolsPanel />);

    await waitFor(() => expect(screen.getByText('No tools registered by this host.')).toBeTruthy());
  });
});
