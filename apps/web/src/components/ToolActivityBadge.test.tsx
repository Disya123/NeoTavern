/**
 * ToolActivityBadge tests (М5 slice 41, ТЗ §13.2): the badge renders the
 * running-tool status from the step input tool name; it is purely
 * presentational and never renders arguments or results.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolActivityBadge } from './ToolActivityBadge.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (key === 'chat:toolRunning') return `Running tool: ${String(vars?.name)}…`;
      return key;
    },
  }),
}));

afterEach(() => {
  cleanup();
});

describe('ToolActivityBadge', () => {
  it('renders the running tool name as a status region', () => {
    render(<ToolActivityBadge name="search_lorebook" />);
    expect(screen.getByRole('status')).toHaveTextContent('Running tool: search_lorebook…');
    expect(screen.getByRole('status').getAttribute('data-component')).toBe('tool-activity');
  });

  it('never renders arguments or results', () => {
    render(<ToolActivityBadge name="web_search" />);
    const status = screen.getByRole('status').textContent ?? '';
    expect(status).not.toContain('{');
    expect(status).not.toContain('"');
  });
});
