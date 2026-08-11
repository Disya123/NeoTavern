import { describe, it, expect } from 'vitest';
import {
  hasPermission,
  parsePermission,
  diffPermissions,
  validatePermissions,
  Disposables,
  EventBus,
  validateManifest,
  definePlugin,
  activateServerPlugin,
  PluginRuntime,
  type ServerPluginApi,
} from '../src/index.js';

describe('permissions', () => {
  it('parses kind and scope', () => {
    expect(parsePermission('chat.read')).toEqual({ kind: 'chat.read' });
    expect(parsePermission('network:api.example.com')).toEqual({
      kind: 'network',
      scope: 'api.example.com',
    });
  });

  it('checks exact and wildcard network grants', () => {
    expect(hasPermission(['chat.read'], 'chat.read')).toBe(true);
    expect(hasPermission(['chat.read'], 'chat.write')).toBe(false);
    expect(hasPermission(['network:*'], 'network:api.example.com')).toBe(true);
    expect(hasPermission(['network:a.com'], 'network:b.com')).toBe(false);
  });

  it('diffs permissions across versions', () => {
    const diff = diffPermissions(['chat.read', 'ui.toolbar'], ['chat.read', 'chat.write']);
    expect(diff.added).toEqual(['chat.write']);
    expect(diff.removed).toEqual(['ui.toolbar']);
  });

  it('validates permission strings', () => {
    expect(validatePermissions(['chat.read', 'network:example.com'])).toEqual([]);
    expect(validatePermissions(['network:']).length).toBeGreaterThan(0);
    expect(validatePermissions(['files:weird']).length).toBeGreaterThan(0);
    expect(validatePermissions(['unknown.capability']).length).toBeGreaterThan(0);
    expect(validatePermissions(['network:https://example.com']).length).toBeGreaterThan(0);
    expect(validatePermissions(['chat.read', 'chat.read']).length).toBeGreaterThan(0);
  });
});

describe('Disposables', () => {
  it('runs cleanups in reverse order and is idempotent', () => {
    const order: number[] = [];
    const d = new Disposables();
    d.add(() => order.push(1));
    d.add(() => order.push(2));
    d.dispose();
    d.dispose();
    expect(order).toEqual([2, 1]);
  });

  it('runs cleanup immediately if already disposed', () => {
    const d = new Disposables();
    d.dispose();
    let ran = false;
    d.add(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('continues past a throwing cleanup', () => {
    const d = new Disposables();
    let second = false;
    d.add(() => {
      second = true;
    });
    d.add(() => {
      throw new Error('boom');
    });
    expect(() => d.dispose()).not.toThrow();
    expect(second).toBe(true);
  });
});

describe('EventBus', () => {
  interface Events {
    ping: { n: number };
    [key: string]: unknown;
  }

  it('delivers payloads and supports unsubscribe', () => {
    const bus = new EventBus<Events>();
    const received: number[] = [];
    const off = bus.on('ping', (p) => received.push(p.n));
    bus.emit('ping', { n: 1 });
    bus.emit('ping', { n: 2 });
    off();
    bus.emit('ping', { n: 3 });
    expect(received).toEqual([1, 2]);
  });

  it('isolates a throwing subscriber', () => {
    const bus = new EventBus<Events>();
    const ok: number[] = [];
    bus.on('ping', () => {
      throw new Error('bad subscriber');
    });
    bus.on('ping', (p) => ok.push(p.n));
    expect(() => bus.emit('ping', { n: 5 })).not.toThrow();
    expect(ok).toEqual([5]);
  });
});

describe('manifest validation', () => {
  it('accepts a valid manifest', () => {
    const result = validateManifest({
      id: 'author.example',
      name: 'Example',
      version: '1.0.0',
      apiVersion: 2,
      permissions: ['chat.read', 'network:api.example.com'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe('author.example');
  });

  it('rejects a bad id and missing fields', () => {
    const result = validateManifest({ id: 'no-dots', version: 'x' });
    expect(result.ok).toBe(false);
  });

  it('rejects an apiVersion newer than supported', () => {
    const result = validateManifest({
      id: 'a.b',
      name: 'x',
      version: '1.0.0',
      apiVersion: 99,
    });
    expect(result.ok).toBe(false);
  });

  it('accepts apiVersion 3 (vNext runtime, ADR-0027)', () => {
    const result = validateManifest({
      id: 'a.b',
      name: 'x',
      version: '1.0.0',
      apiVersion: 3,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.apiVersion).toBe(3);
  });

  it('rejects an apiVersion above the current 3', () => {
    const result = validateManifest({
      id: 'a.b',
      name: 'x',
      version: '1.0.0',
      apiVersion: 4,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects traversal entry paths and invalid API versions', () => {
    const base = {
      id: 'author.example',
      name: 'Example',
      version: '1.0.0',
      apiVersion: 2,
    };
    expect(validateManifest({ ...base, frontend: '../outside.js' }).ok).toBe(false);
    expect(validateManifest({ ...base, i18n: { en: '/absolute.json' } }).ok).toBe(false);
    expect(validateManifest({ ...base, apiVersion: 1.5 }).ok).toBe(false);
    expect(validateManifest({ ...base, frontend: 'frontend.ts' }).ok).toBe(false);
    expect(validateManifest({ ...base, styles: 'styles.js' }).ok).toBe(false);
    expect(validateManifest({ ...base, i18n: { english: 'en.json' } }).ok).toBe(false);
  });

  it('requires explicit trusted consent for legacy entry points', () => {
    const base = {
      id: 'author.legacy',
      name: 'Legacy extension',
      version: '1.0.0',
      apiVersion: 2,
      legacy: { frontend: 'legacy/index.js', backend: 'legacy/server.mjs' },
    };
    expect(validateManifest(base).ok).toBe(false);
    const result = validateManifest({ ...base, permissions: ['legacy.trusted'] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.legacy).toEqual(base.legacy);
    }
    expect(
      validateManifest({
        ...base,
        permissions: ['legacy.trusted'],
        legacy: { frontend: '../outside.js' },
      }).ok,
    ).toBe(false);
  });

  it('validates authClients endpoints and entries', () => {
    const base = {
      id: 'author.example',
      name: 'Example',
      version: '1.0.0',
      apiVersion: 2,
      authClients: [
        {
          serviceId: 'com.example.api',
          name: 'Example API',
          authorizationUrl: 'https://api.example.com/oauth/authorize',
          tokenUrl: 'https://api.example.com/oauth/token',
          clientId: 'public-client',
          scopes: ['profile.read', 'profile.write'],
        },
      ],
    };
    expect(validateManifest(base).ok).toBe(true);

    const withScopes = {
      ...base,
      authClients: [{ ...base.authClients[0], scopes: ['profile.read'] }],
    };
    expect(validateManifest(withScopes).ok).toBe(true);

    const cases: Array<[string, unknown, string]> = [
      ['http remote service', 'http://api.example.com/oauth/authorize', 'authorizationUrl'],
      ['plain hostname', 'api.example.com/oauth/authorize', 'authorizationUrl'],
      ['ftp scheme', 'ftp://api.example.com/oauth', 'authorizationUrl'],
      ['empty scopes', 'https://api.example.com/oauth/authorize', 'scopes'],
    ];
    for (const [label, authorizationUrl, expectedField] of cases) {
      const entry = {
        ...base.authClients[0],
        ...(expectedField === 'scopes'
          ? { scopes: [] }
          : { authorizationUrl, tokenUrl: 'https://api.example.com/oauth/token' }),
      };
      expect(
        validateManifest({ ...base, authClients: [entry] }).ok,
        `${label} must be rejected`,
      ).toBe(false);
    }
  });

  it('allows plain-http loopback OAuth endpoints for local development', () => {
    const base = {
      id: 'author.example',
      name: 'Example',
      version: '1.0.0',
      apiVersion: 2,
    };
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(
        validateManifest({
          ...base,
          authClients: [
            {
              serviceId: 'local.dev',
              name: 'Local IdP',
              authorizationUrl: `http://${host}:8080/authorize`,
              tokenUrl: `http://${host}:8080/token`,
              clientId: 'local-client',
              scopes: ['profile.read'],
            },
          ],
        }).ok,
        `${host} loopback must be accepted`,
      ).toBe(true);
    }
  });

  it('rejects duplicate authClients serviceIds and malformed entries', () => {
    const base = {
      id: 'author.example',
      name: 'Example',
      version: '1.0.0',
      apiVersion: 2,
      authClients: [
        {
          serviceId: 'com.example.api',
          name: 'Example API',
          authorizationUrl: 'https://api.example.com/oauth/authorize',
          tokenUrl: 'https://api.example.com/oauth/token',
          clientId: 'public-client',
          scopes: ['profile.read'],
        },
      ],
    };
    expect(
      validateManifest({ ...base, authClients: [...base.authClients, ...base.authClients] }).ok,
    ).toBe(false);
    expect(validateManifest({ ...base, authClients: [{ serviceId: 'com.example.api' }] }).ok).toBe(
      false,
    );
  });

  it('validates the workers allowlist', () => {
    const base = { id: 'author.example', name: 'Example', version: '1.0.0', apiVersion: 2 };
    const result = validateManifest({
      ...base,
      workers: ['workers/double.js', 'workers/util.js'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.workers).toEqual(['workers/double.js', 'workers/util.js']);
    }
    // Absent allowlist stays absent.
    const absent = validateManifest(base);
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.value.workers).toBeUndefined();
    for (const workers of [
      'not-an-array',
      ['../outside.mjs'],
      ['/abs.mjs'],
      ['workers/entry.txt'],
      ['workers/entry.ts'],
      [42],
    ]) {
      expect(
        validateManifest({ ...base, workers }).ok,
        `${JSON.stringify(workers)} must be rejected`,
      ).toBe(false);
    }
  });
});

describe('definePlugin', () => {
  it('returns the definition unchanged', () => {
    const def = definePlugin({ activate: () => undefined });
    expect(typeof def.activate).toBe('function');
  });
});

describe('PluginRuntime', () => {
  function createServerApi(cleanups: string[]): ServerPluginApi {
    const route = (kind: string) => () => {
      cleanups.push(kind);
    };
    return {
      pluginId: 'author.example',
      routes: {
        get: () => route('route:get'),
        post: () => route('route:post'),
        put: () => route('route:put'),
        delete: () => route('route:delete'),
      },
      storage: {
        get: async () => undefined,
        set: async () => undefined,
        delete: async () => undefined,
        keys: async () => [],
      },
      events: new EventBus(),
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => null,
      }),
      providers: {
        register: () => route('provider'),
        registerTokenizer: () => route('tokenizer'),
      },
      contextStrategies: {
        register: () => route('context-strategy'),
      },
      postProcessors: {
        register: () => route('post-processor'),
      },
      files: {
        read: async () => '',
        write: async () => undefined,
        list: async () => [],
        delete: async () => undefined,
      },
    };
  }

  it('automatically tears down ignored registrations in reverse order', async () => {
    const cleanups: string[] = [];
    const runtime = new PluginRuntime();
    const api = createServerApi(cleanups);

    await activateServerPlugin(
      runtime,
      {
        activate(scopedApi) {
          scopedApi.routes.get('/status', () => ({ body: {} }));
          scopedApi.providers.register('example', {});
          scopedApi.providers.registerTokenizer({
            id: 'example-tokenizer',
            approximate: false,
            matches: () => true,
            count: (text) => text.length,
          });
          scopedApi.contextStrategies.register({
            id: 'example-strategy',
            shift: ({ messages }) => ({
              kept: messages,
              excluded: [],
              estimatedTokens: 0,
              truncated: false,
              fitsBudget: true,
            }),
          });
          scopedApi.postProcessors.register({
            id: 'example-post-processor',
            process: (text) => text,
          });
          scopedApi.events.on('chat.created', () => undefined);
        },
        deactivate() {
          cleanups.push('deactivate');
        },
      },
      api,
    );

    expect(runtime.state).toBe('active');
    await runtime.deactivate();
    expect(cleanups).toEqual([
      'deactivate',
      'post-processor',
      'context-strategy',
      'tokenizer',
      'provider',
      'route:get',
    ]);
    expect(runtime.state).toBe('idle');
  });

  it('rolls back registrations when activation fails', async () => {
    const cleanups: string[] = [];
    const runtime = new PluginRuntime();

    await expect(
      activateServerPlugin(
        runtime,
        {
          activate(api) {
            api.routes.post('/broken', () => ({ body: {} }));
            throw new Error('activation failed');
          },
        },
        createServerApi(cleanups),
      ),
    ).rejects.toThrow('activation failed');

    expect(cleanups).toEqual(['route:post']);
    expect(runtime.state).toBe('idle');
  });

  it('still cleans up when explicit deactivate fails', async () => {
    const cleanups: string[] = [];
    const runtime = new PluginRuntime();
    await activateServerPlugin(
      runtime,
      {
        activate(api) {
          api.routes.delete('/resource', () => ({ body: {} }));
        },
        deactivate() {
          throw new Error('deactivate failed');
        },
      },
      createServerApi(cleanups),
    );

    await expect(runtime.deactivate()).rejects.toThrow('deactivate failed');
    expect(cleanups).toEqual(['route:delete']);
    expect(runtime.state).toBe('idle');
  });
});
