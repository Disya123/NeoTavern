import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ContextUsageSummary } from '../lib/contextUsage.js';
import { renderWithProviders } from '../../test/helpers.js';
import { ContextUsagePanel } from './ContextUsagePanel.js';

const summary: ContextUsageSummary = {
  isExact: true,
  promptTokens: 100,
  contextLimit: 1_000,
  reservedForReply: 200,
  availableTokens: 700,
  usagePercent: 30,
  breakdown: {
    chatHistory: 10,
    worldInfo: 20,
    character: 30,
    persona: 15,
    other: 25,
  },
};

describe('ContextUsagePanel', () => {
  it('renders the exact preview breakdown from the shared panel', async () => {
    await renderWithProviders(
      <ContextUsagePanel
        id="context-preview"
        summary={summary}
        source="preview"
        isLoading
        tokenizerProfile="test:exact"
      />,
    );

    const panel = screen.getByRole('status').closest('[data-component="context-usage-panel"]');
    expect(panel).toHaveAttribute('data-state', 'exact');
    expect(panel?.querySelectorAll('[data-part="metric"]')).toHaveLength(4);
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    expect(screen.getByText('Current context preview')).toBeInTheDocument();
    expect(screen.getByText('Chat history')).toBeInTheDocument();
    expect(screen.getByText('World info')).toBeInTheDocument();
    expect(screen.getByText('Character')).toBeInTheDocument();
    expect(screen.getByText('Persona')).toBeInTheDocument();
    expect(screen.getByText('Other')).toBeInTheDocument();
    expect(screen.getByText('test:exact', { exact: false })).toBeInTheDocument();
  });
});
