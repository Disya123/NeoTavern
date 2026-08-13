/**
 * Declarative slot contribution validation (SDK side, ТЗ §53). `contribute()`
 * must enforce these rules before anything crosses to the host; the host
 * registry re-applies the same validation at the untrusted boundary.
 */
import { describe, expect, it } from 'vitest';
import {
  SLOT_IDS,
  SlotContributionError,
  isSlotId,
  validateSlotContribution,
  type SlotContribution,
  type SlotContributionErrorCode,
} from '../src/index.js';

const VALID: SlotContribution = {
  slot: 'chat.header.actions',
  title: 'Export log',
  priority: 50,
  permission: 'chat.read',
  action: { type: 'command', commandId: 'log.export' },
  when: () => true,
};

/** Assert `validateSlotContribution(def)` fails with the given code. */
function expectCode(def: unknown, code: SlotContributionErrorCode): SlotContributionError {
  try {
    validateSlotContribution(def);
  } catch (error) {
    expect(error).toBeInstanceOf(SlotContributionError);
    const typed = error as SlotContributionError;
    expect(typed.code).toBe(code);
    expect(typed.message).toContain(code);
    return typed;
  }
  throw new Error(`expected validation failure ${code}, but contribution was accepted`);
}

describe('SLOT_IDS', () => {
  it('contains exactly the five stable semantic slot ids', () => {
    expect(SLOT_IDS).toEqual([
      'chat.header.actions',
      'chat.message.actions',
      'character.editor.actions',
      'settings.section',
      'generation.controls',
    ]);
  });

  it('isSlotId narrows only the stable ids', () => {
    for (const slot of SLOT_IDS) expect(isSlotId(slot)).toBe(true);
    expect(isSlotId('myplugin.custom.slot')).toBe(false);
    expect(isSlotId(42)).toBe(false);
    expect(isSlotId(undefined)).toBe(false);
  });
});

describe('validateSlotContribution', () => {
  it('accepts a valid contribution and preserves optional fields', () => {
    const result = validateSlotContribution(VALID);
    expect(result).toEqual(VALID);
    expect(result.slot).toBe('chat.header.actions');
    expect(result.priority).toBe(50);
    expect(result.permission).toBe('chat.read');
    expect(result.action).toEqual({ type: 'command', commandId: 'log.export' });
    expect(typeof result.when).toBe('function');
  });

  it('accepts a minimal contribution without optional fields', () => {
    const result = validateSlotContribution({
      slot: 'generation.controls',
      title: 'Boost',
      action: { type: 'event', event: 'myplugin.boost' },
    });
    expect(result.priority).toBeUndefined();
    expect(result.permission).toBeUndefined();
    expect(result.when).toBeUndefined();
  });

  it('rejects an unknown slot id with SLOT_UNKNOWN carrying the id', () => {
    const error = expectCode({ ...VALID, slot: 'chat.custom.actions' }, 'SLOT_UNKNOWN');
    expect(error.params).toEqual({ slot: 'chat.custom.actions' });
  });

  it('rejects a missing slot', () => {
    const missingSlot: Record<string, unknown> = { ...VALID };
    delete missingSlot['slot'];
    expectCode(missingSlot, 'SLOT_UNKNOWN');
  });

  it('rejects a non-string or empty title', () => {
    expectCode({ ...VALID, title: '' }, 'SLOT_TITLE_INVALID');
    expectCode({ ...VALID, title: 42 }, 'SLOT_TITLE_INVALID');
  });

  it('rejects a title longer than 80 characters and accepts exactly 80', () => {
    const error = expectCode({ ...VALID, title: 'x'.repeat(81) }, 'SLOT_TITLE_INVALID');
    expect(error.params).toEqual({ reason: 'too-long', maxLength: 80 });
    expect(validateSlotContribution({ ...VALID, title: 'x'.repeat(80) }).title).toHaveLength(80);
  });

  it('rejects control characters in the title', () => {
    for (const title of ['line\nbreak', 'tab\there', 'bell\u0007', 'delete\u007f']) {
      const error = expectCode({ ...VALID, title }, 'SLOT_TITLE_INVALID');
      expect(error.params).toEqual({ reason: 'control-characters' });
    }
  });

  it('rejects malformed priority', () => {
    for (const priority of [-1, 1.5, '100', Number.NaN]) {
      expectCode({ ...VALID, priority }, 'SLOT_INVALID');
    }
    expect(validateSlotContribution({ ...VALID, priority: 0 }).priority).toBe(0);
  });

  it('rejects malformed permission', () => {
    for (const permission of ['', 7, 'x'.repeat(129)]) {
      expectCode({ ...VALID, permission }, 'SLOT_INVALID');
    }
  });

  it('rejects malformed actions', () => {
    expectCode({ ...VALID, action: undefined }, 'SLOT_INVALID');
    expectCode({ ...VALID, action: { type: 'command', commandId: '' } }, 'SLOT_INVALID');
    expectCode({ ...VALID, action: { type: 'event', event: '' } }, 'SLOT_INVALID');
    expectCode({ ...VALID, action: { type: 'navigate' } }, 'SLOT_INVALID');
  });

  it('rejects a non-function when()', () => {
    expectCode({ ...VALID, when: true }, 'SLOT_INVALID');
  });

  it('rejects non-object definitions', () => {
    for (const def of [null, undefined, 'chat.header.actions', 42, []]) {
      expectCode(def, 'SLOT_INVALID');
    }
  });
});
