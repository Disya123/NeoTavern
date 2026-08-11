// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '../src/index.js';
import { render, cleanup, pointerDown, pressKey, q, qa, settle } from './helpers.js';

afterEach(cleanup);

function Demo({ onSelectProfile }: { onSelectProfile?: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={onSelectProfile}>Profile</DropdownMenuItem>
        <DropdownMenuItem onSelect={vi.fn()} disabled>
          Danger zone
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const CONTENT = '[data-component="menu-content"]';
const ITEMS = '[data-component="menu-item"]';

async function openMenu() {
  const view = render(<Demo />);
  pointerDown(document.body.querySelector('button')!);
  await settle();
  return view;
}

describe('DropdownMenu', () => {
  it('renders nothing but the trigger while closed', () => {
    render(<Demo />);
    expect(q(CONTENT)).toBeNull();
    expect(document.body.textContent).toContain('Actions');
    expect(document.body.textContent).not.toContain('Profile');
  });

  it('opens on trigger pointerdown and portals its items', async () => {
    await openMenu();
    const content = q(CONTENT);
    expect(content).not.toBeNull();
    expect(qa(ITEMS).map((item) => item.textContent)).toEqual([
      'Profile',
      'Danger zone',
      'Sign out',
    ]);
    expect(q('[data-component="menu-separator"]')).not.toBeNull();
    expect(qa(ITEMS)[1].getAttribute('data-disabled')).toBe('');
    expect(qa(ITEMS)[1].getAttribute('aria-disabled')).toBe('true');
  });

  it('closes when the trigger is toggled again', async () => {
    await openMenu();
    pointerDown(document.body.querySelector('button')!);
    expect(q(CONTENT)).toBeNull();
  });

  it('selects an item with the keyboard and closes', async () => {
    const onSelectProfile = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onSelectProfile}>Profile</DropdownMenuItem>
          <DropdownMenuItem>Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    pointerDown(document.body.querySelector('button')!);
    await settle();
    const content = q(CONTENT)!;
    // Move highlight to the first item, then activate it.
    pressKey(content, 'ArrowDown');
    expect(qa(ITEMS)[0].getAttribute('data-highlighted')).toBe('');
    pressKey(qa(ITEMS)[0], 'Enter');
    expect(onSelectProfile).toHaveBeenCalledTimes(1);
    expect(q(CONTENT)).toBeNull();
  });

  it('does not select a disabled item', async () => {
    const onSelectProfile = vi.fn();
    render(<Demo onSelectProfile={onSelectProfile} />);
    pointerDown(document.body.querySelector('button')!);
    await settle();
    const disabled = qa(ITEMS)[1];
    pressKey(disabled, 'Enter');
    // Menu stays open and no selection is reported.
    expect(q(CONTENT)).not.toBeNull();
    expect(onSelectProfile).not.toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    await openMenu();
    pressKey(document.body, 'Escape');
    expect(q(CONTENT)).toBeNull();
  });

  it('tears the portal down on unmount', async () => {
    const view = await openMenu();
    expect(q(CONTENT)).not.toBeNull();
    view.unmount();
    expect(q(CONTENT)).toBeNull();
    expect(document.body.children.length).toBe(0);
  });
});
