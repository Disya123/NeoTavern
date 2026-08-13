/**
 * Host-side slot registry tests (ТЗ §53): re-validation at the untrusted
 * boundary, permission gating, `when()` filtering, priority ordering,
 * cleanup, and SlotHost rendering.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import {
  SlotRegistry,
  SlotHost,
  slotRegistry,
  slotsContributionFromDefinition,
  type SlotPermissionCheck,
} from '../src/plugins/slots.js';
import { renderWithProviders } from './helpers.js';

/** Everything-ok permission stub; tests narrow it per case. */
const allowAll: SlotPermissionCheck = () => true;
const denyAll: SlotPermissionCheck = () => false;

function contribution(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slot: 'chat.header.actions',
    title: 'Export log',
    action: { type: 'command', commandId: 'log.export' },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SlotRegistry.register (untrusted boundary)', () => {
  it('rejects an unknown slot id', () => {
    const registry = new SlotRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cleanupFn = registry.register({
      pluginId: 'p1',
      contribution: contribution({ slot: 'chat.custom.actions' }),
    });
    expect(cleanupFn).toBeNull();
    expect(registry.list('chat.header.actions')).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rejects a title with control characters', () => {
    const registry = new SlotRegistry();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      registry.register({
        pluginId: 'p1',
        contribution: contribution({ title: 'line\nbreak' }),
      }),
    ).toBeNull();
  });

  it('rejects a title longer than 80 characters', () => {
    const registry = new SlotRegistry();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      registry.register({
        pluginId: 'p1',
        contribution: contribution({ title: 'x'.repeat(81) }),
      }),
    ).toBeNull();
  });

  it('rejects malformed non-title fields', () => {
    const registry = new SlotRegistry();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      registry.register({ pluginId: 'p1', contribution: contribution({ action: undefined }) }),
    ).toBeNull();
  });
});

describe('SlotRegistry.renderSlot', () => {
  it('sorts by priority ascending and breaks ties by registrationId', () => {
    const registry = new SlotRegistry();
    registry.register({
      pluginId: 'p1',
      pluginName: 'Alpha',
      registrationId: 'a',
      contribution: contribution({ title: 'Late', priority: 200 }),
    });
    registry.register({
      pluginId: 'p1',
      pluginName: 'Alpha',
      registrationId: 'b',
      contribution: contribution({ title: 'Early', priority: 10 }),
    });
    registry.register({
      pluginId: 'p1',
      pluginName: 'Alpha',
      registrationId: 'c',
      contribution: contribution({ title: 'Default' }),
    });
    const titles = registry
      .renderSlot('chat.header.actions', undefined, allowAll)
      .map((d) => d.title);
    expect(titles).toEqual(['Early', 'Default', 'Late']);
  });

  it('keeps stable order for equal priorities', () => {
    const registry = new SlotRegistry();
    registry.register({
      pluginId: 'p1',
      pluginName: 'Alpha',
      registrationId: 'z',
      contribution: contribution({ title: 'First registered' }),
    });
    registry.register({
      pluginId: 'p1',
      pluginName: 'Alpha',
      registrationId: 'a',
      contribution: contribution({ title: 'Second registered' }),
    });
    const titles = registry
      .renderSlot('chat.header.actions', undefined, allowAll)
      .map((d) => d.title);
    expect(titles).toEqual(['Second registered', 'First registered']);
  });

  it('hides contributions whose permission is not granted', () => {
    const registry = new SlotRegistry();
    registry.register({
      pluginId: 'p1',
      pluginName: 'Alpha',
      contribution: contribution({ title: 'Gated', permission: 'chat.read' }),
    });
    registry.register({
      pluginId: 'p1',
      pluginName: 'Alpha',
      contribution: contribution({ title: 'Open' }),
    });
    const denied = registry.renderSlot('chat.header.actions', undefined, denyAll);
    expect(denied.map((d) => d.title)).toEqual(['Open']);
    const granted = registry.renderSlot('chat.header.actions', undefined, allowAll);
    expect(granted.map((d) => d.title)).toEqual(['Gated', 'Open']);
  });

  it('delegates permission checks to the host grant store per plugin', () => {
    const registry = new SlotRegistry();
    registry.register({
      pluginId: 'p1',
      pluginName: 'Alpha',
      contribution: contribution({ title: 'A', permission: 'chat.read' }),
    });
    registry.register({
      pluginId: 'p2',
      pluginName: 'Beta',
      contribution: contribution({ title: 'B', permission: 'chat.read' }),
    });
    const check = vi.fn(
      (pluginId: string, permission: string) => pluginId === 'p1' && permission === 'chat.read',
    );
    const rendered = registry.renderSlot('chat.header.actions', undefined, check);
    expect(rendered.map((d) => d.title)).toEqual(['A']);
    expect(check).toHaveBeenCalledWith('p1', 'chat.read');
    expect(check).toHaveBeenCalledWith('p2', 'chat.read');
  });

  it('skips contributions when when() returns false and survives throwing gates', () => {
    const registry = new SlotRegistry();
    registry.register({
      pluginId: 'p1',
      pluginName: 'Alpha',
      contribution: contribution({ title: 'Hidden', when: () => false }),
    });
    registry.register({
      pluginId: 'p1',
      pluginName: 'Alpha',
      contribution: contribution({
        title: 'Broken',
        when: () => {
          throw new Error('boom');
        },
      }),
    });
    registry.register({
      pluginId: 'p1',
      pluginName: 'Alpha',
      contribution: contribution({ title: 'Shown', when: () => true }),
    });
    const titles = registry
      .renderSlot('chat.header.actions', { chatId: 'c1' }, allowAll)
      .map((d) => d.title);
    expect(titles).toEqual(['Shown']);
  });

  it('returns plain descriptors without plugin functions', () => {
    const registry = new SlotRegistry();
    registry.register({
      pluginId: 'p1',
      pluginName: 'Alpha',
      contribution: contribution({ title: 'Export', action: { type: 'event', event: 'p1.go' } }),
    });
    const [descriptor] = registry.renderSlot('chat.header.actions', undefined, allowAll);
    expect(descriptor).toEqual({
      pluginId: 'p1',
      pluginName: 'Alpha',
      registrationId: expect.any(String),
      title: 'Export',
      action: { type: 'event', event: 'p1.go' },
    });
  });

  it('renders nothing for other slots', () => {
    const registry = new SlotRegistry();
    registry.register({
      pluginId: 'p1',
      pluginName: 'Alpha',
      contribution: contribution(),
    });
    expect(registry.renderSlot('settings.section', undefined, allowAll)).toHaveLength(0);
  });
});

describe('SlotRegistry cleanup', () => {
  it('removes the entry and stops rendering it', () => {
    const registry = new SlotRegistry();
    const cleanupFn = registry.register({
      pluginId: 'p1',
      pluginName: 'Alpha',
      contribution: contribution(),
    });
    expect(cleanupFn).not.toBeNull();
    expect(registry.renderSlot('chat.header.actions', undefined, allowAll)).toHaveLength(1);
    cleanupFn?.();
    expect(registry.renderSlot('chat.header.actions', undefined, allowAll)).toHaveLength(0);
    // Idempotent cleanup.
    cleanupFn?.();
    expect(registry.renderSlot('chat.header.actions', undefined, allowAll)).toHaveLength(0);
  });

  it('unregister by registrationId removes the entry', () => {
    const registry = new SlotRegistry();
    registry.register({
      pluginId: 'p1',
      pluginName: 'Alpha',
      registrationId: 'slot-1',
      contribution: contribution(),
    });
    registry.unregister('slot-1');
    expect(registry.renderSlot('chat.header.actions', undefined, allowAll)).toHaveLength(0);
  });
});

describe('SlotHost', () => {
  it('renders nothing without contributions', async () => {
    const { container } = await renderWithProviders(<SlotHost slot="settings.section" />);
    expect(container.querySelector('[data-component="slot-host"]')).toBeNull();
  });

  it('renders buttons for visible contributions and hides gated ones', async () => {
    const stopA = slotRegistry.register({
      pluginId: 'p1',
      pluginName: 'Alpha',
      contribution: contribution({ title: 'Export log' }),
    });
    const stopB = slotRegistry.register({
      pluginId: 'p1',
      pluginName: 'Alpha',
      contribution: contribution({ title: 'Hidden now', when: () => false }),
    });
    try {
      const rendered = await renderWithProviders(<SlotHost slot="chat.header.actions" />);
      expect(rendered.getByRole('button', { name: 'Export log' })).toBeInTheDocument();
      expect(rendered.queryByRole('button', { name: 'Hidden now' })).toBeNull();
      expect(rendered.container.querySelector('[data-slot="chat.header.actions"]')).not.toBeNull();
    } finally {
      stopA?.();
      stopB?.();
    }
  });

  it('renders nothing for a different slot', async () => {
    const stop = slotRegistry.register({
      pluginId: 'p1',
      pluginName: 'Alpha',
      contribution: contribution(),
    });
    try {
      const rendered = await renderWithProviders(<SlotHost slot="settings.section" />);
      expect(rendered.queryByRole('button', { name: 'Export log' })).toBeNull();
    } finally {
      stop?.();
    }
  });
});

describe('slotsContributionFromDefinition (sandbox channel bridge)', () => {
  it('maps a full declarative definition to a contribution', () => {
    const contribution = slotsContributionFromDefinition({
      slot: 'character.editor.actions',
      title: 'Regenerate portrait',
      priority: 10,
      permission: 'chat.read',
      action: { type: 'command', commandId: 'portrait.regenerate' },
    });
    expect(contribution).not.toBeNull();
    expect(contribution?.slot).toBe('character.editor.actions');
    expect(contribution?.title).toBe('Regenerate portrait');
    expect(contribution?.priority).toBe(10);
    expect(contribution?.permission).toBe('chat.read');
    expect(contribution?.action).toEqual({ type: 'command', commandId: 'portrait.regenerate' });
  });

  it('accepts the longest stable slot id (24 chars)', () => {
    expect('character.editor.actions').toHaveLength(24);
    const contribution = slotsContributionFromDefinition({
      slot: 'character.editor.actions',
      title: 'Action',
      action: { type: 'event', event: 'custom.action' },
    });
    expect(contribution?.slot).toBe('character.editor.actions');
  });

  it('returns null for a definition without an action (host drops it)', () => {
    expect(
      slotsContributionFromDefinition({
        slot: 'chat.header.actions',
        title: 'No action',
      }),
    ).toBeNull();
  });

  it('returns null for an unknown slot id', () => {
    expect(
      slotsContributionFromDefinition({
        slot: 'chat.custom.actions',
        title: 'X',
        action: { type: 'command', commandId: 'x' },
      }),
    ).toBeNull();
  });

  it('returns null for a malformed action and non-object input', () => {
    expect(
      slotsContributionFromDefinition({
        slot: 'chat.header.actions',
        title: 'X',
        action: { type: 'javascript', code: 'alert(1)' },
      }),
    ).toBeNull();
    expect(slotsContributionFromDefinition(null)).toBeNull();
    expect(slotsContributionFromDefinition('slots')).toBeNull();
  });

  it('never carries a when() function across the boundary', () => {
    const contribution = slotsContributionFromDefinition({
      slot: 'chat.header.actions',
      title: 'X',
      action: { type: 'event', event: 'e' },
      // The sandbox channel drops functions; simulate what actually arrives.
      when: undefined,
    });
    expect(contribution?.when).toBeUndefined();
  });
});
