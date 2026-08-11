// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelMenu, type ModelMenuOption } from '../src/index.js';
import { click, cleanup, pressKey, q, qa, render, settle } from './helpers.js';

afterEach(cleanup);

const OPTIONS: ModelMenuOption[] = [
  { value: 'gpt-4o', label: 'GPT-4o', contextLimit: 128_000 },
  { value: 'claude-opus', label: 'Claude Opus', contextLimit: 200_000 },
  { value: 'local-fallback', label: 'Local Fallback' },
];

const STATUS = '[data-part="status"]';
const INPUT = '[data-component="combobox-input"]';
const CONTENT = '[data-component="combobox-content"]';
const OPTIONS_SEL = '[data-component="combobox-option"]';
const EMPTY = '[data-component="combobox-empty"]';
const BUTTON = '[data-component="button"]';

/** React-friendly value setter (React reads input values via the native setter). */
function setInput(input: HTMLInputElement, text: string): void {
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    descriptor?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function Demo(props: {
  value?: string;
  options?: readonly ModelMenuOption[];
  onLoadModels?: () => void;
  loading?: boolean;
  disabled?: boolean;
  hint?: string;
  hintTone?: 'default' | 'error';
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(props.value ?? '');
  return (
    <ModelMenu
      options={props.options ?? OPTIONS}
      value={value}
      onValueChange={(next) => {
        setValue(next);
        props.onChange?.(next);
      }}
      placeholder="Pick a model"
      emptyText="No models loaded"
      noResultsText="No matches"
      loadLabel="Load models"
      aria-label="Model"
      onLoadModels={props.onLoadModels}
      loading={props.loading}
      disabled={props.disabled}
      hint={props.hint}
      hintTone={props.hintTone}
    />
  );
}

describe('ModelMenu', () => {
  it('renders a searchable input with the aria-label and a hint line', () => {
    render(<Demo value="gpt-4o" hint="3 models available" />);
    const input = q(INPUT) as HTMLInputElement;
    expect(input.getAttribute('aria-label')).toBe('Model');
    expect(input.value).toMatch(/^GPT-4o \(\d[\d.,\s]*\)$/);
    const status = q(STATUS);
    expect(status?.textContent).toBe('3 models available');
    expect(status?.getAttribute('data-tone')).toBe('default');
  });

  it('shows the load button only when onLoadModels is provided and fires it', async () => {
    const onLoadModels = vi.fn();
    const { rerender } = render(<Demo onLoadModels={onLoadModels} />);
    expect(qa(BUTTON)).toHaveLength(1);
    click(q(BUTTON)!);
    expect(onLoadModels).toHaveBeenCalledTimes(1);

    rerender(<Demo />);
    expect(qa(BUTTON)).toHaveLength(0);
  });

  it('disables the input and the load button while loading', () => {
    const onLoadModels = vi.fn();
    const { rerender } = render(<Demo onLoadModels={onLoadModels} loading />);
    expect((q(INPUT) as HTMLInputElement).disabled).toBe(true);
    expect((q(BUTTON) as HTMLButtonElement).disabled).toBe(true);

    rerender(<Demo onLoadModels={onLoadModels} loading={false} />);
    expect((q(INPUT) as HTMLInputElement).disabled).toBe(false);
    expect((q(BUTTON) as HTMLButtonElement).disabled).toBe(false);
  });

  it('lists options with their context limit and commits a pick on click', async () => {
    const onChange = vi.fn();
    render(<Demo onChange={onChange} />);
    pressKey(q(INPUT)!, 'ArrowDown');
    await settle();
    const options = qa(OPTIONS_SEL);
    expect(options.map((option) => option.textContent)).toEqual([
      `GPT-4o (${(128_000).toLocaleString()})`,
      `Claude Opus (${(200_000).toLocaleString()})`,
      'Local Fallback',
    ]);
    const target = options.find((option) => option.textContent === 'Local Fallback')!;
    click(target);
    expect(onChange).toHaveBeenCalledWith('local-fallback');
    await settle();
    expect(q(CONTENT)).toBeNull();
  });

  it('commits free text on Enter when nothing matches', async () => {
    const onChange = vi.fn();
    render(<Demo onChange={onChange} />);
    const input = q(INPUT) as HTMLInputElement;
    pressKey(input, 'ArrowDown');
    await settle();
    setInput(input, 'custom-model-xyz');
    await settle();
    expect(qa(OPTIONS_SEL)).toEqual([]);
    pressKey(input, 'Enter');
    expect(onChange).toHaveBeenCalledWith('custom-model-xyz');
  });

  it('shows the empty state when no options are loaded', async () => {
    render(<Demo options={[]} />);
    pressKey(q(INPUT)!, 'ArrowDown');
    await settle();
    expect(q(EMPTY)?.textContent).toBe('No models loaded');
  });

  it('shows the no-results state when the filter matches nothing', async () => {
    render(<Demo />);
    const input = q(INPUT) as HTMLInputElement;
    pressKey(input, 'ArrowDown');
    await settle();
    setInput(input, 'zzz-no-such-model');
    await settle();
    expect(q(EMPTY)?.textContent).toBe('No matches');
  });

  it('honours the disabled state for both controls', () => {
    const onLoadModels = vi.fn();
    render(<Demo onLoadModels={onLoadModels} disabled />);
    expect((q(INPUT) as HTMLInputElement).disabled).toBe(true);
    expect((q(BUTTON) as HTMLButtonElement).disabled).toBe(true);
    pressKey(q(INPUT)!, 'ArrowDown');
    expect(q(CONTENT)).toBeNull();
  });

  it('renders an error-toned hint', () => {
    render(<Demo hint="Discovery unavailable" hintTone="error" />);
    expect(q(STATUS)?.getAttribute('data-tone')).toBe('error');
  });
});
