// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Segmented } from '../src/index.js';
import { render, cleanup, click } from './helpers.js';

afterEach(cleanup);

const options = [
  { value: 'a', label: 'Option A' },
  { value: 'b', label: 'Option B' },
];

describe('Segmented', () => {
  it('renders a labelled group with one button per option', () => {
    const { container } = render(
      <Segmented value="a" options={options} ariaLabel="Choice" onChange={() => undefined} />,
    );
    const group = container.querySelector('[data-component="segmented"]')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Choice');
    const buttons = [...group.querySelectorAll('button')];
    expect(buttons.map((button) => button.textContent)).toEqual(['Option A', 'Option B']);
  });

  it('marks the active option with data-state and aria-pressed', () => {
    const { container } = render(
      <Segmented value="b" options={options} ariaLabel="Choice" onChange={() => undefined} />,
    );
    const [first, second] = container.querySelectorAll('[data-component="segmented"] button');
    expect(first!.getAttribute('data-state')).toBe('inactive');
    expect(first!.getAttribute('aria-pressed')).toBe('false');
    expect(second!.getAttribute('data-state')).toBe('active');
    expect(second!.getAttribute('aria-pressed')).toBe('true');
  });

  it('calls onChange with the clicked option value', () => {
    const onChange = vi.fn();
    const { container } = render(
      <Segmented value="a" options={options} ariaLabel="Choice" onChange={onChange} />,
    );
    const [, second] = container.querySelectorAll('[data-component="segmented"] button');
    click(second!);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('b');
  });
});
