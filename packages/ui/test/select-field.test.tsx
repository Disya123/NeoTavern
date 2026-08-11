// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { SelectField } from '../src/index.js';
import { render, cleanup } from './helpers.js';

afterEach(cleanup);

describe('SelectField', () => {
  it('associates the label with the native select', () => {
    const { container } = render(
      <SelectField label="Role">
        <option value="system">System</option>
        <option value="user">User</option>
      </SelectField>,
    );
    const select = container.querySelector('select')!;
    const label = container.querySelector('[data-component="field-label"]')!;
    expect(label.getAttribute('for')).toBe(select.id);
    expect(label.textContent).toBe('Role');
    expect(select.getAttribute('data-component')).toBe('select');
    expect(select.querySelectorAll('option')).toHaveLength(2);
  });

  it('renders the description announced with the control', () => {
    const { container } = render(
      <SelectField label="Role" description="Pick one">
        <option value="system">System</option>
      </SelectField>,
    );
    const description = container.querySelector('[data-component="field-description"]')!;
    expect(description.textContent).toBe('Pick one');
    const select = container.querySelector('select')!;
    expect(select.getAttribute('aria-describedby')).toBe(description.id);
  });

  it('forwards value and disabled', () => {
    const { container } = render(
      <SelectField label="Role" value="user" disabled>
        <option value="system">System</option>
        <option value="user">User</option>
      </SelectField>,
    );
    const select = container.querySelector('select')!;
    expect(select.value).toBe('user');
    expect(select.disabled).toBe(true);
  });

  it('reports selection through onChange', () => {
    const onChange = vi.fn();
    const { container } = render(
      <SelectField label="Role" onChange={onChange}>
        <option value="system">System</option>
        <option value="user">User</option>
      </SelectField>,
    );
    const select = container.querySelector('select')!;
    // Uncontrolled dispatch: for a controlled select React restores the prop
    // value before the handler reads it in jsdom, so the forwarding contract
    // is asserted on the uncontrolled path (browser behavior parity).
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )!.set!;
    act(() => {
      nativeSetter.call(select, 'system');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].target.value).toBe('system');
  });

  it('renders the field wrapper data hooks', () => {
    const { container } = render(
      <SelectField label="Role">
        <option value="system">System</option>
      </SelectField>,
    );
    expect(container.querySelector('[data-component="field"]')).not.toBeNull();
  });
});
