import { beforeEach, describe, expect, it, vi } from 'vitest';
import { kernel } from '@neotavern/plugin-sdk';
import type { PluginUiRegistration } from '../runtime.js';
import { attachCommands, runPluginCommand, runPluginSurface } from './commands.js';
import type { KernelHostContext } from './types.js';

const { KernelErrorCode } = kernel;

function fakeContext(capabilities: ReadonlySet<string> = new Set(['ui.commands', 'ui.surfaces'])) {
  const handlers = new Map<string, (ctx: { params: unknown }) => unknown>();
  const session = {
    handle: vi.fn((method: string, handler: (ctx: { params: unknown }) => unknown) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    call: vi.fn(async () => ({})),
  };
  const runtime = {
    kernelAddRegistration: vi.fn(),
    kernelRemoveRegistration: vi.fn(),
  };
  const ctx = {
    pluginId: 'test.commands',
    frame: { plugin: { name: 'Commands Test' } },
    session,
    runtime,
    hasCapability: (name: string) => capabilities.has(name),
    currentChatId: () => null,
  } as unknown as KernelHostContext;
  return { ctx, handlers, session, runtime };
}

function invoke(
  handlers: Map<string, (ctx: { params: unknown }) => unknown>,
  method: string,
  params: unknown,
) {
  const handler = handlers.get(method);
  if (!handler) throw new Error(`no handler for ${method}`);
  return handler({ params });
}

describe('kernel commands + surfaces', () => {
  let fake: ReturnType<typeof fakeContext>;

  beforeEach(() => {
    fake = fakeContext();
    attachCommands(fake.ctx);
  });

  it('registers all four wire methods', () => {
    expect([...fake.handlers.keys()]).toEqual([
      'commands.register',
      'commands.unregister',
      'surfaces.register',
      'surfaces.unregister',
    ]);
  });

  it('commands.register bridges into the v2 runtime registry', () => {
    const result = invoke(fake.handlers, 'commands.register', {
      id: 'greet',
      title: 'Greet',
      description: 'Say hi',
      category: 'demo',
    }) as { commandId: string };

    expect(result.commandId).toBe('cmd:greet');
    expect(fake.runtime.kernelAddRegistration).toHaveBeenCalledWith({
      pluginId: 'test.commands',
      pluginName: 'Commands Test',
      registrationId: 'cmd:greet',
      kind: 'commands',
      definition: { id: 'greet', title: 'Greet', description: 'Say hi' },
      kernel: false,
    });
  });

  it('commands.register rejects without the ui.commands capability', () => {
    const denied = fakeContext(new Set(['ui.surfaces']));
    attachCommands(denied.ctx);
    expect(() =>
      invoke(denied.handlers, 'commands.register', { id: 'x', title: 'X' }),
    ).toThrowError(expect.objectContaining({ code: KernelErrorCode.CAPABILITY_DENIED }));
    expect(denied.runtime.kernelAddRegistration).not.toHaveBeenCalled();
  });

  it('commands.register validates params', () => {
    expect(() => invoke(fake.handlers, 'commands.register', { title: 'No id' })).toThrowError(
      expect.objectContaining({ code: KernelErrorCode.VALIDATION_FAILED }),
    );
    expect(() => invoke(fake.handlers, 'commands.register', null)).toThrowError(
      expect.objectContaining({ code: KernelErrorCode.VALIDATION_FAILED }),
    );
  });

  it('commands.unregister removes the registration', () => {
    invoke(fake.handlers, 'commands.register', { id: 'greet', title: 'Greet' });
    const result = invoke(fake.handlers, 'commands.unregister', { commandId: 'cmd:greet' });
    expect(result).toEqual({});
    expect(fake.runtime.kernelRemoveRegistration).toHaveBeenCalledWith('cmd:greet');
  });

  it('commands.register forwards the kernel flag', () => {
    invoke(fake.handlers, 'commands.register', { id: 'k', title: 'K', kernel: true });
    expect(fake.runtime.kernelAddRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ registrationId: 'cmd:k', kernel: true }),
    );
  });

  it('surfaces.register issues a host token and registers under the given kind', () => {
    const result = invoke(fake.handlers, 'surfaces.register', {
      kind: 'toolbarActions',
      definition: { title: 'Do thing', icon: 'sparkle' },
    }) as { surfaceId: string; registrationId: string };

    expect(result.surfaceId).toBe(result.registrationId);
    expect(result.surfaceId).toMatch(/^surf:/);
    const added = fake.runtime.kernelAddRegistration.mock.calls[0]![0] as PluginUiRegistration;
    expect(added.kind).toBe('toolbarActions');
    expect(added.registrationId).toBe(result.surfaceId);
    expect(added.definition.id).toBe(result.surfaceId);
    expect(added.definition.title).toBe('Do thing');
  });
  it('surfaces.register forwards the kernel flag', () => {
    const flagged = fakeContext();
    attachCommands(flagged.ctx);
    invoke(flagged.handlers, 'surfaces.register', {
      kind: 'settingsPanels',
      definition: { title: 'Panel' },
      kernel: true,
    });
    const kernelAdded = flagged.runtime.kernelAddRegistration.mock
      .calls[0]![0] as PluginUiRegistration;
    expect(kernelAdded.kernel).toBe(true);
  });

  it('surfaces.register rejects unknown kinds and missing capability', () => {
    expect(() =>
      invoke(fake.handlers, 'surfaces.register', { kind: 'interceptors', definition: {} }),
    ).toThrowError(expect.objectContaining({ code: KernelErrorCode.VALIDATION_FAILED }));
    const denied = fakeContext(new Set(['ui.commands']));
    attachCommands(denied.ctx);
    expect(() =>
      invoke(denied.handlers, 'surfaces.register', { kind: 'pages', definition: {} }),
    ).toThrowError(expect.objectContaining({ code: KernelErrorCode.CAPABILITY_DENIED }));
  });

  it('surfaces.unregister removes the registration', () => {
    const { surfaceId } = invoke(fake.handlers, 'surfaces.register', {
      kind: 'pages',
      definition: { title: 'Page' },
    }) as { surfaceId: string };
    invoke(fake.handlers, 'surfaces.unregister', { surfaceId });
    expect(fake.runtime.kernelRemoveRegistration).toHaveBeenCalledWith(surfaceId);
  });

  it('run helpers forward to the plugin over session.call', async () => {
    await runPluginCommand(fake.ctx, 'cmd:greet', { source: 'palette' });
    expect(fake.session.call).toHaveBeenCalledWith(
      'commands.run',
      { commandId: 'cmd:greet', context: { source: 'palette' } },
      expect.objectContaining({ deadlineMs: expect.any(Number) }),
    );
    await runPluginSurface(fake.ctx, 'surf:abc', null);
    expect(fake.session.call).toHaveBeenCalledWith(
      'surfaces.run',
      { surfaceId: 'surf:abc', context: null },
      expect.objectContaining({ deadlineMs: expect.any(Number) }),
    );
  });
});
