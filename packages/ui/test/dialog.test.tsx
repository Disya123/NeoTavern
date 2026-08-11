// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Dialog, DialogTrigger, DialogClose, DialogContent } from '../src/index.js';
import { render, cleanup, click, pressKey, q, settle } from './helpers.js';

afterEach(cleanup);

function Demo({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  return (
    <Dialog onOpenChange={onOpenChange}>
      <DialogTrigger>Open dialog</DialogTrigger>
      <DialogContent title="Confirm action" description="This cannot be undone.">
        <DialogClose>Close dialog</DialogClose>
      </DialogContent>
    </Dialog>
  );
}

const CONTENT = '[data-component="dialog-content"]';

describe('Dialog', () => {
  it('renders only the trigger while closed', () => {
    render(<Demo />);
    expect(q(CONTENT)).toBeNull();
    expect(q('[data-component="dialog-overlay"]')).toBeNull();
  });

  it('opens on trigger click and portals content into document.body', () => {
    const { container } = render(<Demo />);
    click(container.querySelector('button')!);
    const content = q(CONTENT);
    expect(content).not.toBeNull();
    // Portaled: visible in the document but outside the render container.
    expect(container.querySelector(CONTENT)).toBeNull();
    expect(content!.getAttribute('role')).toBe('dialog');
    expect(q('[data-component="dialog-overlay"]')).not.toBeNull();
    const title = q('[data-component="dialog-title"]')!;
    expect(title.textContent).toBe('Confirm action');
    // The content must point at its title for screen readers.
    expect(content!.getAttribute('aria-labelledby')).toBe(title.id);
    expect(q('[data-component="dialog-description"]')!.textContent).toBe('This cannot be undone.');
  });

  it('closes via the DialogClose button', () => {
    const onOpenChange = vi.fn();
    const { container } = render(<Demo onOpenChange={onOpenChange} />);
    click(container.querySelector('button')!);
    expect(q(CONTENT)).not.toBeNull();
    click(q('[data-component="dialog-content"] button')!);
    expect(q(CONTENT)).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('closes on Escape and reports the close request', async () => {
    const onOpenChange = vi.fn();
    const { container } = render(<Demo onOpenChange={onOpenChange} />);
    click(container.querySelector('button')!);
    await settle();
    pressKey(document.body, 'Escape');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(q(CONTENT)).toBeNull();
  });

  it('respects a controlled open prop', () => {
    render(
      <Dialog open>
        <DialogContent title="Controlled" description="Always on">
          body
        </DialogContent>
      </Dialog>,
    );
    expect(q(CONTENT)).not.toBeNull();
    expect(q('[data-component="dialog-title"]')!.textContent).toBe('Controlled');
  });

  it('removes every portaled node on unmount', () => {
    const view = render(<Demo />);
    click(view.container.querySelector('button')!);
    expect(q(CONTENT)).not.toBeNull();
    view.unmount();
    expect(q(CONTENT)).toBeNull();
    expect(q('[data-component="dialog-overlay"]')).toBeNull();
    expect(document.body.children.length).toBe(0);
  });
});
