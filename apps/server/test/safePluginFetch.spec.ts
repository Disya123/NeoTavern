/**
 * SEC-03 resolved-IP policy for the legacy plugin `network.fetch`
 * (`apps/server/src/lib/safePluginFetch.ts`): IP classification, DNS
 * all-answers verification, verified-IP connection, post-connect
 * remoteAddress check, redirect re-policing and bounded bodies.
 */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import type { AppContext } from '../src/types.js';
import type { BackendPluginHost, BackendProcess } from '../src/plugin/backendHost.js';
import {
  classifyIpAddress,
  resolveVerifiedAddresses,
  safePluginFetch,
  type LookupFn,
} from '../src/lib/safePluginFetch.js';

/** Sequential DNS script: each call consumes the next answer list. */
function lookupScript(...batches: string[][]): LookupFn {
  let calls = 0;
  return vi.fn(async (hostname: string) => {
    const batch = batches[calls];
    calls += 1;
    if (batch === undefined) throw new Error(`unexpected lookup: ${hostname}`);
    return batch;
  });
}

interface RecordedRequest {
  options: RequestOptions;
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  /** remoteAddress the fake socket reports after connect. */
  remoteAddress: string;
}

/**
 * Injectable http(s).request: records the request options, emits a fake
 * socket (EventEmitter with `remoteAddress`) that reports 'connect', then
 * (on end()) emits the scripted response.
 */
function fakeTransport(
  records: RecordedRequest[],
): (options: RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest {
  let consumed = 0;
  return ((options: RequestOptions, onResponse: (res: IncomingMessage) => void) => {
    const record = records[consumed];
    if (record !== undefined) record.options = options;
    const request = {
      errorListener: undefined as ((error: unknown) => void) | undefined,
      listeners: {} as Record<string, ((data: unknown) => void) | undefined>,
      on(event: string, fn: (data?: unknown) => void) {
        if (event === 'error') this.errorListener = fn as (error: unknown) => void;
        else this.listeners[event] = fn as (data: unknown) => void;
        return this;
      },
      once(event: string, fn: (data?: unknown) => void) {
        return this.on(event, fn);
      },
      write() {
        return true;
      },
      end() {
        const active = records[consumed];
        consumed += 1;
        if (active === undefined) return; // unexpected extra request: stay pending
        const socket = new EventEmitter() as EventEmitter & { remoteAddress: string };
        Object.defineProperty(socket, 'remoteAddress', { value: active.remoteAddress });
        this.emitNow('socket', socket);
        queueMicrotask(() => socket.emit('connect'));
        queueMicrotask(() => {
          const message = Readable.from([Buffer.from(active.body)]) as IncomingMessage;
          (message as { statusCode: number }).statusCode = active.statusCode;
          (message as { headers: Record<string, string | string[]> }).headers = active.headers;
          onResponse(message);
        });
      },
      emitNow(event: string, data: unknown) {
        const fn = this.listeners[event];
        if (fn !== undefined) fn(data);
        return true;
      },
      destroy(error?: unknown) {
        if (error !== undefined && this.errorListener !== undefined) {
          queueMicrotask(() => this.errorListener?.(error));
        }
        return this;
      },
    } as unknown as ClientRequest & {
      emitNow(event: string, data: unknown): boolean;
      listeners: Record<string, ((data: unknown) => void) | undefined>;
    };
    return request;
  }) as unknown as (
    options: RequestOptions,
    callback: (res: IncomingMessage) => void,
  ) => ClientRequest;
}

const makeOptions = (
  records: RecordedRequest[],
  overrides: { lookupImpl?: LookupFn; maxBytes?: number; timeoutMs?: number } = {},
) => {
  const transport = fakeTransport(records);
  return {
    ...overrides,
    maxBytes: overrides.maxBytes ?? 1024,
    lookupImpl: overrides.lookupImpl ?? (async () => ['1.1.1.1']),
    httpRequestImpl: transport,
    httpsRequestImpl: transport,
  };
};

describe('classifyIpAddress (SEC-03)', () => {
  it('classifies forbidden ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '127.8.9.10',
      '0.0.0.0',
      '169.254.169.254',
      '169.254.1.2',
      '224.0.0.1',
      '239.255.255.250',
      '255.255.255.255',
      '::',
      '::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      // URL-normalized hex spelling of the same mapped loopback ranges
      // (`new URL('http://[::ffff:127.0.0.1]/').hostname` → `[::ffff:7f00:1]`).
      '::ffff:7f00:1',
      '::ffff:7f00:1.0',
      '::ffff:a9fe:a9fe',
    ]) {
      expect(classifyIpAddress(ip), ip).toBe('forbidden');
    }
  });

  it('classifies private ranges as allowed LAN destinations', () => {
    for (const ip of [
      '10.0.0.5',
      '172.16.4.1',
      '172.31.255.255',
      '192.168.1.5',
      '100.64.0.1',
      'fc00::1',
      'fd00::1',
      '::ffff:10.0.0.5',
    ]) {
      expect(classifyIpAddress(ip), ip).toBe('private');
    }
  });

  it('classifies public addresses', () => {
    for (const ip of [
      '93.184.216.34',
      '8.8.8.8',
      '1.1.1.1',
      '2606:4700::1111',
      '2001:4860:4860::8888',
      '::ffff:5db8:d822', // hex spelling of 93.184.216.34
      '::ffff:0a00:0005', // hex spelling of 10.0.0.5 → private
    ]) {
      if (ip === '::ffff:0a00:0005') {
        expect(classifyIpAddress(ip), ip).toBe('private');
      } else {
        expect(classifyIpAddress(ip), ip).toBe('public');
      }
    }
  });

  it('fails closed on hostnames and junk', () => {
    expect(classifyIpAddress('example.com')).toBe('forbidden');
    expect(classifyIpAddress('')).toBe('forbidden');
    expect(classifyIpAddress('999.1.1.1')).toBe('forbidden');
  });
});

describe('resolveVerifiedAddresses (SEC-03 all-answers)', () => {
  it('accepts public IP literals (plain, bracketed IPv6, IPv4-mapped)', async () => {
    await expect(resolveVerifiedAddresses('93.184.216.34', lookupScript())).resolves.toEqual([
      '93.184.216.34',
    ]);
    await expect(resolveVerifiedAddresses('[2606:4700::1111]', lookupScript())).resolves.toEqual([
      '2606:4700::1111',
    ]);
    await expect(resolveVerifiedAddresses('::ffff:93.184.216.34', lookupScript())).resolves.toEqual(
      ['::ffff:93.184.216.34'],
    );
  });

  it('rejects forbidden IP literals without any DNS call', async () => {
    const lookup = lookupScript();
    await expect(resolveVerifiedAddresses('127.0.0.1', lookup)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      params: { reason: 'DESTINATION_DENIED', ip: '127.0.0.1' },
    });
    await expect(resolveVerifiedAddresses('[::1]', lookup)).rejects.toMatchObject({
      params: { reason: 'DESTINATION_DENIED' },
    });
    await expect(resolveVerifiedAddresses('::ffff:127.0.0.1', lookup)).rejects.toMatchObject({
      params: { reason: 'DESTINATION_DENIED' },
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('fails closed when ANY DNS answer is forbidden (rebinding-safe)', async () => {
    await expect(
      resolveVerifiedAddresses('mixed.example', lookupScript(['93.184.216.34', '127.0.0.1'])),
    ).rejects.toMatchObject({ params: { reason: 'DESTINATION_DENIED', ip: '127.0.0.1' } });
  });

  it('accepts all-public answers and rejects empty/failed lookups', async () => {
    await expect(
      resolveVerifiedAddresses('ok.example', lookupScript(['93.184.216.34', '8.8.8.8'])),
    ).resolves.toEqual(['93.184.216.34', '8.8.8.8']);

    await expect(resolveVerifiedAddresses('empty.example', lookupScript([]))).rejects.toMatchObject(
      { params: { reason: 'DNS_EMPTY' } },
    );

    const failing: LookupFn = async () => {
      throw new Error('EAI_AGAIN');
    };
    await expect(resolveVerifiedAddresses('boom.example', failing)).rejects.toMatchObject({
      params: { reason: 'DNS_FAILED' },
    });
  });
});

describe('safePluginFetch (SEC-03 transport)', () => {
  it('refuses a forbidden initial URL without connecting', async () => {
    const records: RecordedRequest[] = [];
    await expect(
      safePluginFetch(new URL('http://127.0.0.1:9999/secret'), makeOptions(records)),
    ).rejects.toMatchObject({ params: { reason: 'DESTINATION_DENIED' } });
    expect(records).toHaveLength(0);
  });

  it('connects to the pre-verified IP and keeps the hostname for Host/SNI only', async () => {
    const records: RecordedRequest[] = [
      { options: {}, statusCode: 200, headers: {}, body: 'hello', remoteAddress: '93.184.216.34' },
    ];
    const lookup = lookupScript(['93.184.216.34']);
    const result = await safePluginFetch(
      new URL('https://api.example.com/v1'),
      makeOptions(records, { lookupImpl: lookup, maxBytes: 1024 }),
    );
    expect(result).toEqual({ ok: true, status: 200, body: 'hello' });
    const options = records[0]?.options;
    expect(options).toBeDefined();
    expect(options?.hostname).toBe('93.184.216.34'); // connection to the verified IP
    expect((options?.headers as Record<string, string>)['host']).toBe('api.example.com');
    expect(options?.servername).toBe('api.example.com'); // SNI keeps the hostname

    const lookupFn = options?.lookup as unknown as (
      _h: string,
      _o: unknown,
      cb: (err: Error | null, address: string, family: number) => void,
    ) => void;
    const resolved: string[] = [];
    lookupFn('api.example.com', {}, (err, address, family) => {
      if (!err) resolved.push(address);
      expect(family).toBe(4);
    });
    expect(resolved).toEqual(['93.184.216.34']);
  });

  it('destroys the request when the connected socket reports a forbidden remoteAddress', async () => {
    const records: RecordedRequest[] = [];
    const racingLookup: LookupFn = async () => ['93.184.216.34'];
    // Custom transport whose socket lands on loopback despite the verified IP.
    const raceTransport = ((
      _options: RequestOptions,
      _onResponse: (res: IncomingMessage) => void,
    ) => {
      const request = {
        errorListener: undefined as ((error: unknown) => void) | undefined,
        listeners: {} as Record<string, ((data: unknown) => void) | undefined>,
        on(event: string, fn: (data?: unknown) => void) {
          if (event === 'error') this.errorListener = fn as (error: unknown) => void;
          else this.listeners[event] = fn as (data: unknown) => void;
          return this;
        },
        once(event: string, fn: (data?: unknown) => void) {
          return this.on(event, fn);
        },
        write() {
          return true;
        },
        end() {
          const socket = new EventEmitter() as EventEmitter & { remoteAddress: string };
          Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
          this.emitNow('socket', socket);
          queueMicrotask(() => socket.emit('connect'));
          // Never emits a response: the post-connect check must destroy first.
        },
        emitNow(event: string, data: unknown) {
          const fn = this.listeners[event];
          if (fn !== undefined) fn(data);
          return true;
        },
        destroy(error?: unknown) {
          if (error !== undefined && this.errorListener !== undefined) {
            queueMicrotask(() => this.errorListener?.(error));
          }
          return this;
        },
      } as unknown as ClientRequest & {
        emitNow(event: string, data: unknown): boolean;
        listeners: Record<string, ((data: unknown) => void) | undefined>;
      };
      return request;
    }) as unknown as (
      options: RequestOptions,
      callback: (res: IncomingMessage) => void,
    ) => ClientRequest;

    await expect(
      safePluginFetch(new URL('https://api.example.com/'), {
        maxBytes: 1024,
        lookupImpl: racingLookup,
        httpRequestImpl: raceTransport,
        httpsRequestImpl: raceTransport,
      }),
    ).rejects.toMatchObject({ params: { reason: 'DESTINATION_DENIED' } });
    expect(records).toHaveLength(0);
  });

  it('re-policies every redirect hop and caps the hop count', async () => {
    const records: RecordedRequest[] = [
      {
        options: {},
        statusCode: 302,
        headers: { location: 'https://next.example/step' },
        body: '',
        remoteAddress: '93.184.216.34',
      },
      { options: {}, statusCode: 200, headers: {}, body: 'final', remoteAddress: '93.184.216.34' },
    ];
    const lookup = lookupScript(['93.184.216.34'], ['93.184.216.34']);
    const result = await safePluginFetch(
      new URL('https://start.example/'),
      makeOptions(records, { lookupImpl: lookup, maxBytes: 1024 }),
    );
    expect(result).toEqual({ ok: true, status: 200, body: 'final' });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('denies a redirect hop whose hostname resolves to a forbidden address', async () => {
    const records: RecordedRequest[] = [
      {
        options: {},
        statusCode: 301,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        body: '',
        remoteAddress: '93.184.216.34',
      },
    ];
    await expect(
      safePluginFetch(
        new URL('https://start.example/'),
        makeOptions(records, { lookupImpl: lookupScript(['93.184.216.34']) }),
      ),
    ).rejects.toMatchObject({ params: { reason: 'DESTINATION_DENIED' } });
  });

  it('tears down oversized bodies (SEC-04)', async () => {
    const records: RecordedRequest[] = [
      {
        options: {},
        statusCode: 200,
        headers: {},
        body: 'x'.repeat(200),
        remoteAddress: '1.1.1.1',
      },
    ];
    await expect(
      safePluginFetch(
        new URL('https://api.example.com/big'),
        makeOptions(records, { maxBytes: 100 }),
      ),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('propagates non-redirect status codes with a bounded body', async () => {
    const records: RecordedRequest[] = [
      {
        options: {},
        statusCode: 404,
        headers: {},
        body: 'not found',
        remoteAddress: '1.1.1.1',
      },
    ];
    const result = await safePluginFetch(
      new URL('https://api.example.com/missing'),
      makeOptions(records),
    );
    expect(result).toEqual({ ok: false, status: 404, body: 'not found' });
  });
});

describe('BackendPluginHost.fetchRpc (legacy network.fetch, SEC-03)', () => {
  it('refuses loopback, link-local and mapped destinations even with network:*', async () => {
    const { host, process } = await makeFetchRpcHarness(['network:*']);
    try {
      for (const url of [
        'http://127.0.0.1:9999/x',
        'http://[::1]:9999/x',
        'http://[::ffff:127.0.0.1]:9999/x',
        'http://169.254.169.254/latest/meta-data/',
      ]) {
        await expect(host.fetchRpc(process, { url })).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          params: { reason: 'DESTINATION_DENIED' },
        });
      }
    } finally {
      await host.close();
    }
  });

  it('refuses a hostname that resolves into a forbidden range', async () => {
    const { host, process } = await makeFetchRpcHarness(['network:*']);
    try {
      // `localhost` resolves to loopback (127.0.0.1 / ::1) on every platform;
      // the all-answers policy must deny it before any connection.
      await expect(host.fetchRpc(process, { url: 'https://localhost/x' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        params: { reason: 'DESTINATION_DENIED' },
      });
    } finally {
      await host.close();
    }
  });

  it('still enforces the host allowlist and keeps transport validation', async () => {
    const { host, process } = await makeFetchRpcHarness([]);
    try {
      await expect(
        host.fetchRpc(process, { url: 'https://api.example.com/' }),
      ).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION_DENIED' });
      await expect(host.fetchRpc(process, { url: 'file:///etc/passwd' })).rejects.toMatchObject({
        params: { reason: 'URL_SCHEME_NOT_ALLOWED' },
      });
    } finally {
      await host.close();
    }

    const granted = await makeFetchRpcHarness(['network:api.example.com']);
    try {
      // Method validation happens after the allowlist passes.
      await expect(
        granted.host.fetchRpc(granted.process, {
          url: 'https://api.example.com/',
          method: 'TRACE',
        }),
      ).rejects.toMatchObject({ params: { reason: 'METHOD_INVALID' } });
    } finally {
      await granted.host.close();
    }
  });
});

// ---- fetchRpc harness (no network required for the denied paths) ------------

async function makeFetchRpcHarness(permissions: string[]): Promise<{
  host: BackendPluginHost;
  process: BackendProcess;
}> {
  const { createAppDatabase } = await import('@neotavern/db');
  const { EventBus } = await import('@neotavern/plugin-sdk');
  const { createLogger } = await import('@neotavern/shared');
  const { createAppInstance } = await import('../src/types.js');
  const { BackendPluginHost, BackendProcess } = await import('../src/plugin/backendHost.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const database = createAppDatabase(':memory:');
  const bus = new EventBus();
  const logger = createLogger({ level: 'error' });
  const dataDir = mkdtempSync(join(tmpdir(), 'neotavern-fetchrpc-'));
  const app = createAppInstance();
  const ctx = {
    database,
    events: bus,
    logger,
    config: { pluginNodePath: process.execPath },
    paths: { plugins: dataDir, cache: join(dataDir, 'cache') },
  } as unknown as AppContext;
  const host = new BackendPluginHost(app, ctx);
  await app.ready();

  const child = {
    listeners: [] as Array<[string, (data: unknown) => void]>,
    on() {
      return child;
    },
    once() {
      return child;
    },
    send() {
      return true;
    },
    kill() {},
  } as unknown as ChildProcess;

  const pluginProcess = new BackendProcess('test.fetchrpc', permissions, child, {
    logPluginMessage: () => undefined,
    logWorkerOutput: () => undefined,
  } as never);

  return { host, process: pluginProcess };
}
