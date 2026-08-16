/**
 * PromptPlanPanel tests (ТЗ §9.2, М5 slice 37): the dialog renders the
 * durable plan of one generation run — meta (model/instruct/tokenizer/
 * tokens), over-budget warning, system blocks, selected messages and the
 * excluded list — with honest empty/error states. `usePromptPlan` is mocked
 * so no wire transport runs.
 */
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PromptPlanDto } from '@neotavern/contracts';
import { renderWithProviders } from '../../test/helpers.js';
import { PromptPlanPanel } from './PromptPlanPanel.js';

const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const PLAN: PromptPlanDto = {
  runId: RUN_ID,
  chatId: 'chat-1',
  provider: 'openai-compatible',
  model: 'gpt-4o-mini',
  instructFormat: 'chatml',
  tokenizerProfile: 'heuristic',
  approximateTokens: true,
  contextLimit: 8192,
  responseReserved: 1024,
  inputTokens: 1200,
  overBudget: false,
  userName: 'Ada',
  systemBlocks: [
    { source: 'character', text: 'You are Ada Lovelace.' },
    { source: 'instruct', text: 'Respond as Ada.' },
  ],
  messages: [{ role: 'user', content: 'Hello.' }],
  excluded: [
    {
      messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      reason: 'token_budget',
    },
  ],
  createdAt: '2026-06-01T12:00:00.000Z',
};

const mockUsePromptPlan = vi.hoisted(() => vi.fn());
vi.mock('../api/hooks.js', () => ({
  usePromptPlan: mockUsePromptPlan,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PromptPlanPanel', () => {
  it('renders the plan meta, blocks, messages and excluded entries', async () => {
    mockUsePromptPlan.mockReturnValue({
      data: PLAN,
      isLoading: false,
      isError: false,
      error: null,
    });
    await renderWithProviders(<PromptPlanPanel open runId={RUN_ID} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText('Prompt plan').length).toBeGreaterThan(0));
    expect(screen.getByText(/openai-compatible\/gpt-4o-mini/)).toBeTruthy();
    expect(screen.getByText('chatml')).toBeTruthy();
    expect(screen.getByText(/heuristic/)).toBeTruthy();
    expect(screen.getByText(/Input 1200/)).toBeTruthy();
    expect(screen.getByText('character')).toBeTruthy();
    expect(screen.getByText('You are Ada Lovelace.')).toBeTruthy();
    expect(screen.getByText('user')).toBeTruthy();
    expect(screen.getByText('Hello.')).toBeTruthy();
    expect(screen.getByText(/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/)).toBeTruthy();
    expect(screen.getByText('Removed by token budget')).toBeTruthy();
    // No over-budget warning.
    expect(screen.queryByText(/still exceeds the context window/)).toBeNull();
  });

  it('shows the over-budget warning when the plan reports it', async () => {
    mockUsePromptPlan.mockReturnValue({
      data: { ...PLAN, overBudget: true },
      isLoading: false,
      isError: false,
      error: null,
    });
    await renderWithProviders(<PromptPlanPanel open runId={RUN_ID} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/still exceeds the context window/)).toBeTruthy());
  });

  it('shows the honest empty state when the run has no recorded plan', async () => {
    mockUsePromptPlan.mockReturnValue({
      data: null,
      isLoading: false,
      isError: false,
      error: null,
    });
    await renderWithProviders(<PromptPlanPanel open runId={RUN_ID} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/no recorded prompt plan/)).toBeTruthy());
  });

  it('closes via the close button', async () => {
    mockUsePromptPlan.mockReturnValue({
      data: null,
      isLoading: false,
      isError: false,
      error: null,
    });
    const onClose = vi.fn();
    await renderWithProviders(<PromptPlanPanel open runId={RUN_ID} onClose={onClose} />);
    await userEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });
});
