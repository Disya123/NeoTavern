// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRef } from 'react';
import { TextField, TextArea } from '../src/index.js';
import { render, cleanup } from './helpers.js';
import { act } from 'react';

afterEach(cleanup);

function type(target: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  // React tracks value assignments on each node; using the native prototype
  // setter is what makes React see the change as user input.
  const proto =
    target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    nativeSetter.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('TextField', () => {
  it('associates the label with an auto-generated input id', () => {
    const { container } = render(<TextField label="Display name" />);
    const label = container.querySelector('[data-component="field-label"]')!;
    const input = container.querySelector('input')!;
    expect(input.id).not.toBe('');
    expect(label.getAttribute('for')).toBe(input.id);
    expect(label.textContent).toBe('Display name');
  });

  it('uses an explicit id when provided', () => {
    const { container } = render(<TextField label="Email" id="user-email" />);
    const input = container.querySelector('input')!;
    expect(input.id).toBe('user-email');
    expect(container.querySelector('label')!.getAttribute('for')).toBe('user-email');
  });

  it('renders no label element when none is given', () => {
    const { container } = render(<TextField placeholder="bare" />);
    expect(container.querySelector('[data-component="field-label"]')).toBeNull();
    expect(container.querySelector('input')).not.toBeNull();
  });

  it('reports typing through onChange', () => {
    const onChange = vi.fn();
    const { container } = render(<TextField label="Name" onChange={onChange} />);
    type(container.querySelector('input')!, 'Ada');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].target.value).toBe('Ada');
  });

  it('forwards its ref and data hooks', () => {
    const ref = createRef<HTMLInputElement>();
    const { container } = render(<TextField ref={ref} label="Name" className="wide" />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
    const input = container.querySelector('input')!;
    expect(input.getAttribute('data-component')).toBe('input');
    expect(input.classList.contains('st-input')).toBe(true);
    expect(input.classList.contains('wide')).toBe(true);
  });
});

describe('TextArea', () => {
  it('associates its label and reports typing', () => {
    const onChange = vi.fn();
    const { container } = render(<TextArea label="Bio" onChange={onChange} />);
    const area = container.querySelector('textarea')!;
    const label = container.querySelector('[data-component="field-label"]')!;
    expect(label.getAttribute('for')).toBe(area.id);
    expect(area.getAttribute('data-component')).toBe('textarea');
    type(area, 'hello world');
    expect(onChange.mock.calls[0][0].target.value).toBe('hello world');
  });
});
