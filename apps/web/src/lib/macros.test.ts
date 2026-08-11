import { describe, expect, it } from 'vitest';
import { buildMacroContext, resolveActivePersona } from './macros.js';

describe('resolveActivePersona', () => {
  const personas = [
    {
      id: 'p-chat',
      name: 'Chat Persona',
      description: '',
      avatar: null,
      isDefault: false,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: 'p-default',
      name: 'Default Persona',
      description: '',
      avatar: null,
      isDefault: true,
      createdAt: 0,
      updatedAt: 0,
    },
  ];

  it('prefers the chat persona over the settings default', () => {
    expect(resolveActivePersona(personas, 'p-chat', 'p-default')?.name).toBe('Chat Persona');
  });

  it('falls back to the settings default persona', () => {
    expect(resolveActivePersona(personas, null, 'p-default')?.name).toBe('Default Persona');
  });

  it('falls back to the default persona when no ids are set', () => {
    expect(resolveActivePersona(personas, null, null)?.name).toBe('Default Persona');
  });
});

describe('buildMacroContext', () => {
  it('expands user and char names for display', () => {
    const context = buildMacroContext({ userName: 'Aster', charName: 'Seraphina' });
    expect(context.userName).toBe('Aster');
    expect(context.charName).toBe('Seraphina');
  });
});
