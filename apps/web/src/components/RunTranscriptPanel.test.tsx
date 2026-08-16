/**
 * RunTranscriptPanel tests (ТЗ §8.3, §13.2, М5 slice 47): the dialog renders
 * the durable step journal of one generation run — provider turns, tool
 * calls, tool results, the final commit — in document order with their
 * status and time, and never renders tool arguments/results (SEC-07).
 * `useGenerationRunSteps` is mocked so no wire transport runs.
 */
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/helpers.js';
import { RunTranscriptPanel } from './RunTranscriptPanel.js';

const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const STEPS = {
  items: [
    {
      sequence: 0,
      type: 'provider_turn',
      status: 'completed',
      attempt: 1,
      createdAt: '2026-06-01T12:00:00.000Z',
      updatedAt: '2026-06-01T12:00:05.000Z',
    },
    {
      sequence: 1,
      type: 'tool_call',
      status: 'waiting',
      attempt: 1,
      createdAt: '2026-06-01T12:00:06.000Z',
      updatedAt: '2026-06-01T12:00:06.000Z',
    },
    {
      sequence: 2,
      type: 'tool_result',
      status: 'completed',
      attempt: 1,
      createdAt: '2026-06-01T12:00:07.000Z',
      updatedAt: '2026-06-01T12:00:07.000Z',
    },
    {
      sequence: 3,
      type: 'final_commit',
      status: 'completed',
      attempt: 2,
      createdAt: '2026-06-01T12:00:08.000Z',
      updatedAt: '2026-06-01T12:00:09.000Z',
    },
  ],
  hasMore: false,
};

const mockUseGenerationRunSteps = vi.hoisted(() => vi.fn());
vi.mock('../api/hooks.js', () => ({
  useGenerationRunSteps: mockUseGenerationRunSteps,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RunTranscriptPanel', () => {
  it('renders every durable step in order with type, status and attempt', async () => {
    mockUseGenerationRunSteps.mockReturnValue({
      data: STEPS,
      isLoading: false,
      isError: false,
      error: null,
    });
    await renderWithProviders(<RunTranscriptPanel open runId={RUN_ID} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText('Run steps').length).toBeGreaterThan(0));
    expect(screen.getByText('Provider turn')).toBeTruthy();
    expect(screen.getByText('Tool call')).toBeTruthy();
    expect(screen.getByText('Tool result')).toBeTruthy();
    expect(screen.getByText('Final commit')).toBeTruthy();
    // Statuses render localized; waiting/failed distinguishable.
    expect(screen.getByText('Waiting')).toBeTruthy();
    expect(screen.getAllByText('Completed').length).toBeGreaterThanOrEqual(2);
    // Retried steps show the attempt marker.
    expect(screen.getByText('attempt 2')).toBeTruthy();
  });

  it('never renders tool arguments or results (SEC-07)', async () => {
    mockUseGenerationRunSteps.mockReturnValue({
      data: STEPS,
      isLoading: false,
      isError: false,
      error: null,
    });
    await renderWithProviders(<RunTranscriptPanel open runId={RUN_ID} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Tool call')).toBeTruthy());
    // The transcript exposes the step journal only — the mocked hook never
    // carries input/output, and the panel must not fabricate them.
    expect(screen.queryByText(/toolCall|lookup_weather|Kyiv/i)).toBeNull();
    expect(screen.queryByText(/arguments|input|output/i)).toBeNull();
  });

  it('shows the honest empty state when the run has no recorded steps', async () => {
    mockUseGenerationRunSteps.mockReturnValue({
      data: { items: [], hasMore: false },
      isLoading: false,
      isError: false,
      error: null,
    });
    await renderWithProviders(<RunTranscriptPanel open runId={RUN_ID} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/durable run steps recorded/)).toBeTruthy());
  });

  it('closes via the close button', async () => {
    mockUseGenerationRunSteps.mockReturnValue({
      data: null,
      isLoading: false,
      isError: false,
      error: null,
    });
    const onClose = vi.fn();
    await renderWithProviders(<RunTranscriptPanel open runId={RUN_ID} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText(/durable run steps recorded/)).toBeTruthy());
    await userEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });
});
