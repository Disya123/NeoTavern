// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Combobox, type ComboboxOption } from '../src/index.js';
import { click, cleanup, mouseDown, pressKey, q, qa, render, settle } from './helpers.js';

afterEach(cleanup);

const OPTIONS: ComboboxOption[] = [
  { value: 'gpt-4o', label: 'GPT-4o' },
  { value: 'gpt-4o-mini', label: 'GPT-4o mini' },
  { value: 'claude-opus', label: 'Claude Opus' },
];

const INPUT = '[data-component="combobox-input"]';
const CONTENT = '[data-component="combobox-content"]';
const OPTIONS_SEL = '[data-component="combobox-option"]';
const EMPTY = '[data-component="combobox-empty"]';

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
  options?: readonly ComboboxOption[];
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(props.value ?? '');
  return (
    <Combobox
      options={props.options ?? OPTIONS}
      value={value}
      onValueChange={(next) => {
        setValue(next);
        props.onChange?.(next);
      }}
      placeholder="Pick a model"
      emptyText="No models loaded"
      noResultsText="No matches"
      aria-label="Model"
    />
  );
}

describe('Combobox', () => {
  it('shows the committed label and keeps the list closed initially', () => {
    render(<Demo value="gpt-4o" />);
    const input = q(INPUT) as HTMLInputElement;
    expect(input.value).toBe('GPT-4o');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(q(CONTENT)).toBeNull();
  });

  it('opens with the keyboard and lists every option, marking the selected one', async () => {
    render(<Demo value="claude-opus" />);
    const input = q(INPUT)!;
    pressKey(input, 'ArrowDown');
    await settle();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const options = qa(OPTIONS_SEL);
    expect(options.map((option) => option.textContent)).toEqual([
      'GPT-4o',
      'GPT-4o mini',
      'Claude Opus',
    ]);
    expect(options[2]?.getAttribute('aria-selected')).toBe('true');
    expect(options[2]?.getAttribute('data-state')).toBe('selected');
  });

  it('filters options as the user types', async () => {
    render(<Demo />);
    const input = q(INPUT) as HTMLInputElement;
    pressKey(input, 'ArrowDown');
    await settle();
    setInput(input, 'mini');
    await settle();
    const options = qa(OPTIONS_SEL);
    expect(options.map((option) => option.textContent)).toEqual(['GPT-4o mini']);
  });

  it('commits an option on click', async () => {
    const onChange = vi.fn();
    render(<Demo onChange={onChange} />);
    const input = q(INPUT)!;
    pressKey(input, 'ArrowDown');
    await settle();
    const option = qa(OPTIONS_SEL)[1]!;
    mouseDown(option);
    click(option);
    expect(onChange).toHaveBeenCalledWith('gpt-4o-mini');
    await settle();
    expect(q(CONTENT)).toBeNull();
  });

  it('selects the highlighted option with Enter', async () => {
    const onChange = vi.fn();
    render(<Demo onChange={onChange} />);
    const input = q(INPUT)!;
    pressKey(input, 'ArrowDown'); // open, highlight index 0
    await settle();
    pressKey(input, 'ArrowDown'); // highlight index 1
    pressKey(input, 'Enter');
    expect(onChange).toHaveBeenCalledWith('gpt-4o-mini');
  });

  it('commits free text on Enter when nothing is highlighted', async () => {
    const onChange = vi.fn();
    render(<Demo onChange={onChange} />);
    const input = q(INPUT) as HTMLInputElement;
    pressKey(input, 'ArrowDown');
    await settle();
    setInput(input, 'custom-model-xyz');
    await settle();
    expect(qa(OPTIONS_SEL)).toEqual([]); // filtered to nothing
    pressKey(input, 'Enter');
    expect(onChange).toHaveBeenCalledWith('custom-model-xyz');
  });

  it('shows the empty and no-results states', async () => {
    const { rerender } = render(<Demo options={[]} />);
    const input = q(INPUT)!;
    pressKey(input, 'ArrowDown');
    await settle();
    expect(q(EMPTY)?.textContent).toBe('No models loaded');

    rerender(
      <Combobox
        options={OPTIONS}
        value=""
        onValueChange={() => {}}
        emptyText="No models loaded"
        noResultsText="No matches"
        aria-label="Model"
      />,
    );
    await settle();
    setInput(q(INPUT) as HTMLInputElement, 'zzzzz');
    await settle();
    expect(q(EMPTY)?.getAttribute('data-part')).toBe('no-results');
  });

  it('closes on Escape', async () => {
    render(<Demo />);
    const input = q(INPUT)!;
    pressKey(input, 'ArrowDown');
    await settle();
    expect(q(CONTENT)).not.toBeNull();
    pressKey(input, 'Escape');
    await settle();
    expect(q(CONTENT)).toBeNull();
  });
});
