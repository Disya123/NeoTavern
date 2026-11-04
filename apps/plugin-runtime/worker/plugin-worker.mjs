/**
 * Capability bridge for an untrusted backend plugin process.
 *
 * The parent starts this file with Node's Permission Model. Plugin callbacks
 * stay in this process; only JSON-safe requests cross the IPC boundary.
 */
import { pathToFileURL } from 'node:url';

const [, , entryPath, pluginId, permissionsJson] = process.argv;
if (!entryPath || !pluginId || !permissionsJson || typeof process.send !== 'function') {
  throw new Error('Plugin worker requires an IPC parent and startup arguments');
}

const permissions = JSON.parse(permissionsJson);
const permissionSet = new Set(Array.isArray(permissions) ? permissions : []);
const pending = new Map();
const routeHandlers = new Map();
const eventHandlers = new Map();
const providerFactories = new Map();
const tokenizerProfiles = new Map();
const contextStrategies = new Map();
const postProcessors = new Map();
const startupRegistrations = [];
const maxEventSubscriptions = 128;
let sequence = 0;
// rev4 §D: streamed route bodies. The worker only transmits chunks within
// the credit window below; the host grants more via `route.body.ack` as its
// HTTP consumer drains, so a slow client stalls the pump instead of growing
// either process's memory (invariant 5). Chunks are sliced to CHUNK_SIZE and
// base64-encoded — JSON IPC is the only worker↔host transport.
const STREAM_WINDOW_BYTES = 2 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 256 * 1024;
const activeStreams = new Map();

let definition;

for (const property of ['binding', '_linkedBinding', 'dlopen', 'getBuiltinModule']) {
  if (property in process) {
    try {
      Object.defineProperty(process, property, {
        value: undefined,
        writable: false,
        configurable: false,
      });
    } catch {
      // Node versions differ; the ESM loader remains the primary import boundary.
    }
  }
}
for (const property of ['fetch', 'WebSocket', 'EventSource', 'Worker']) {
  try {
    Object.defineProperty(globalThis, property, {
      value: undefined,
      writable: false,
      configurable: false,
    });
  } catch {
    // Ignore globals absent in this Node build.
  }
}

function send(message) {
  process.send?.(message);
}

const USAGE_REPORT_INTERVAL_MS = 2_000;

/**
 * Cooperative usage reports for the host's Resource Governor (ТЗ RES-02,
 * ADR-0026). The host prefers `/proc` sampling on Linux; this is the
 * fallback source on other platforms and a cross-check everywhere. The
 * interval is unref'd so it never keeps the worker alive by itself.
 */
function startUsageReports() {
  const startedAt = Date.now();
  const report = () => {
    const usage = process.memoryUsage();
    const cpu = process.cpuUsage();
    send({
      type: 'usage',
      usage: {
        heapUsed: usage.heapUsed,
        rss: usage.rss,
        cpuMs: (cpu.user + cpu.system) / 1000,
        uptimeMs: Date.now() - startedAt,
      },
    });
  };
  const timer = setInterval(report, USAGE_REPORT_INTERVAL_MS);
  timer.unref();
  report();
}

function call(method, args) {
  const requestId = `${pluginId}:${++sequence}`;
  return new Promise((resolve, reject) => {
    // Must outlast the longest host-side operation this RPC maps to (plugin
    // fetch waits 30s on the host): a shorter worker deadline used to fail
    // fetches the host would have completed (PLUG-59 L4).
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Host RPC timed out: ${method}`));
    }, 35_000);
    timer.unref();
    pending.set(requestId, { resolve, reject, timer });
    send({ type: 'rpc', requestId, method, args });
  });
}

function registerWithHost(method, args, rollback) {
  const registration = call(method, args).catch((error) => {
    rollback();
    throw error;
  });
  startupRegistrations.push(registration);
  return registration;
}

function requirePermission(permission) {
  if (!permissionSet.has(permission)) {
    const error = new Error(`Plugin permission denied: ${permission}`);
    error.code = 'PLUGIN_PERMISSION_DENIED';
    throw error;
  }
}

function makeRouter() {
  const register = (method, path, handler) => {
    requirePermission('server.routes');
    if (typeof handler !== 'function') throw new TypeError('Route handler must be a function');
    const routeId = `${pluginId}:route:${++sequence}`;
    routeHandlers.set(routeId, handler);
    void registerWithHost('route.register', { routeId, method, path }, () =>
      routeHandlers.delete(routeId),
    ).catch((error) => {
      send({ type: 'workerError', code: error?.code ?? 'PLUGIN_LOAD_FAILED' });
    });
    return () => {
      routeHandlers.delete(routeId);
      void call('route.unregister', { routeId }).catch(() => undefined);
    };
  };
  return {
    get: (path, handler) => register('GET', path, handler),
    post: (path, handler) => register('POST', path, handler),
    put: (path, handler) => register('PUT', path, handler),
    delete: (path, handler) => register('DELETE', path, handler),
  };
}

function networkAllowed(hostname) {
  return permissionSet.has('network:*') || permissionSet.has(`network:${hostname.toLowerCase()}`);
}

const api = {
  pluginId,
  routes: makeRouter(),
  storage: {
    get: (key) => call('storage.get', { key }),
    set: (key, value) => call('storage.set', { key, value }),
    delete: (key) => call('storage.delete', { key }),
    keys: () => call('storage.keys', {}),
  },
  events: {
    on(event, handler) {
      if (typeof event !== 'string' || typeof handler !== 'function') {
        throw new TypeError('Event subscription requires an event and handler');
      }
      if (!eventHandlers.has(event) && eventHandlers.size >= maxEventSubscriptions) {
        throw new RangeError('Event subscription limit reached');
      }
      const handlers = eventHandlers.get(event) ?? new Set();
      const firstHandler = handlers.size === 0;
      handlers.add(handler);
      eventHandlers.set(event, handlers);
      if (firstHandler) {
        void registerWithHost('event.subscribe', { event }, () =>
          eventHandlers.delete(event),
        ).catch((error) => {
          send({ type: 'workerError', code: error?.code ?? 'PLUGIN_LOAD_FAILED' });
        });
      }
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) {
          eventHandlers.delete(event);
          void call('event.unsubscribe', { event }).catch(() => undefined);
        }
      };
    },
    off(event, handler) {
      const handlers = eventHandlers.get(event);
      handlers?.delete(handler);
      if (handlers?.size === 0) {
        eventHandlers.delete(event);
        void call('event.unsubscribe', { event }).catch(() => undefined);
      }
    },
    emit(event, payload) {
      return call('event.emit', { event, payload });
    },
    clear() {
      for (const event of eventHandlers.keys()) {
        void call('event.unsubscribe', { event }).catch(() => undefined);
      }
      eventHandlers.clear();
    },
  },
  logger: Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (message, meta) => send({ type: 'log', level, message: String(message), meta }),
    ]),
  ),
  async fetch(url, init = {}) {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new TypeError('Plugin fetch supports HTTP(S) only');
    }
    // Fail-fast convenience check only: the authoritative network:<host>
    // decision is made by the host over RPC, outside this untrusted realm
    // (a plugin could otherwise subvert in-process checks).
    if (!networkAllowed(parsed.hostname)) {
      const error = new Error(`Plugin network permission denied: ${parsed.hostname}`);
      error.code = 'PLUGIN_PERMISSION_DENIED';
      throw error;
    }
    const plainHeaders =
      init.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)
        ? Object.fromEntries(
            Object.entries(init.headers).filter(([, value]) => typeof value === 'string'),
          )
        : undefined;
    const result = await call('fetch.request', {
      url: parsed.href,
      method: init.method,
      headers: plainHeaders,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    const body = String(result?.body ?? '');
    return {
      ok: Boolean(result?.ok),
      status: Number(result?.status ?? 0),
      text: () => Promise.resolve(body),
      json: () => Promise.resolve(JSON.parse(body === '' ? 'null' : body)),
    };
  },
  providers: {
    register(kind, factory, options) {
      requirePermission('providers.register');
      if (typeof kind !== 'string' || typeof factory !== 'function') {
        throw new TypeError('Provider registration requires a kind and factory');
      }
      const registrationId = `${pluginId}:provider:${++sequence}`;
      providerFactories.set(registrationId, factory);
      const capabilities =
        options &&
        typeof options === 'object' &&
        options.capabilities &&
        typeof options.capabilities === 'object'
          ? options.capabilities
          : undefined;
      void registerWithHost('provider.register', { registrationId, kind, capabilities }, () =>
        providerFactories.delete(registrationId),
      ).catch((error) => {
        send({ type: 'workerError', code: error?.code ?? 'PLUGIN_LOAD_FAILED' });
      });
      return () => {
        providerFactories.delete(registrationId);
        void call('provider.unregister', { registrationId }).catch(() => undefined);
      };
    },
    registerTokenizer(profile) {
      requirePermission('providers.register');
      if (
        !profile ||
        typeof profile.id !== 'string' ||
        typeof profile.approximate !== 'boolean' ||
        typeof profile.matches !== 'function' ||
        typeof profile.count !== 'function'
      ) {
        throw new TypeError('Tokenizer registration requires id, approximate, matches and count');
      }
      const registrationId = `${pluginId}:tokenizer:${++sequence}`;
      tokenizerProfiles.set(registrationId, profile);
      void registerWithHost(
        'tokenizer.register',
        {
          registrationId,
          id: profile.id,
          priority: profile.priority,
          approximate: profile.approximate,
        },
        () => tokenizerProfiles.delete(registrationId),
      ).catch((error) => {
        send({ type: 'workerError', code: error?.code ?? 'PLUGIN_LOAD_FAILED' });
      });
      return () => {
        tokenizerProfiles.delete(registrationId);
        void call('tokenizer.unregister', { registrationId }).catch(() => undefined);
      };
    },
  },
  contextStrategies: {
    register(strategy) {
      requirePermission('prompt.modify');
      if (!strategy || typeof strategy.id !== 'string' || typeof strategy.shift !== 'function') {
        throw new TypeError('Context strategy requires id and shift');
      }
      const registrationId = `${pluginId}:context:${++sequence}`;
      contextStrategies.set(registrationId, strategy);
      void registerWithHost(
        'context.register',
        { registrationId, id: strategy.id, priority: strategy.priority },
        () => contextStrategies.delete(registrationId),
      ).catch((error) => {
        send({ type: 'workerError', code: error?.code ?? 'PLUGIN_LOAD_FAILED' });
      });
      return () => {
        contextStrategies.delete(registrationId);
        void call('context.unregister', { registrationId }).catch(() => undefined);
      };
    },
  },
  postProcessors: {
    register(processor) {
      requirePermission('prompt.modify');
      if (
        !processor ||
        typeof processor.id !== 'string' ||
        typeof processor.process !== 'function'
      ) {
        throw new TypeError('Post-processor requires id and process');
      }
      const registrationId = `${pluginId}:postProcess:${++sequence}`;
      postProcessors.set(registrationId, processor);
      void registerWithHost(
        'postProcess.register',
        { registrationId, id: processor.id, priority: processor.priority },
        () => postProcessors.delete(registrationId),
      ).catch((error) => {
        send({ type: 'workerError', code: error?.code ?? 'PLUGIN_LOAD_FAILED' });
      });
      return () => {
        postProcessors.delete(registrationId);
        void call('postProcess.unregister', { registrationId }).catch(() => undefined);
      };
    },
  },
  files: {
    read(path) {
      requirePermission('files:plugin');
      return call('files.read', { path });
    },
    write(path, content) {
      requirePermission('files:plugin');
      return call('files.write', { path, content });
    },
    list(path) {
      requirePermission('files:plugin');
      return call('files.list', { path });
    },
    delete(path) {
      requirePermission('files:plugin');
      return call('files.delete', { path });
    },
  },
};

process.on('message', (message) => {
  void handleMessage(message).catch((error) => {
    send({
      type: 'log',
      level: 'error',
      message: `worker message handling failed: ${error?.message ?? error}`,
    });
  });
});

// Parent process gone — never linger as an orphaned plugin process.
process.on('disconnect', () => {
  process.exit(0);
});

// Surface stray plugin rejections to the host log instead of dying silently
// (the host decides the plugin's fate from its exit event).
process.on('unhandledRejection', (error) => {
  send({
    type: 'log',
    level: 'error',
    message: `unhandled rejection in plugin worker: ${error?.message ?? error}`,
  });
});

async function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'rpcResult') {
    const item = pending.get(message.requestId);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(message.requestId);
    if (message.ok) item.resolve(message.value);
    else {
      const error = new Error(message.error?.message ?? 'Host RPC failed');
      error.code = message.error?.code;
      item.reject(error);
    }
    return;
  }
  if (message.type === 'route.invoke') {
    const handler = routeHandlers.get(message.routeId);
    if (!handler) {
      send({
        type: 'route.result',
        invocationId: message.invocationId,
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Route registration is unavailable' },
      });
      return;
    }
    const controller = new AbortController();
    activeInvocations.set(message.invocationId, controller);
    try {
      const response = await handler({ ...message.request, signal: controller.signal });
      const streamInfo = extractStreamBody(response);
      if (streamInfo) {
        await pumpRouteStream(message.invocationId, streamInfo, controller.signal);
      } else {
        send({ type: 'route.result', invocationId: message.invocationId, ok: true, response });
      }
    } catch (error) {
      send({
        type: 'route.result',
        invocationId: message.invocationId,
        ok: false,
        error: {
          code: error?.code ?? 'PLUGIN_LOAD_FAILED',
          message: String(error?.message ?? error),
        },
      });
    } finally {
      activeInvocations.delete(message.invocationId);
      activeStreams.delete(message.invocationId);
    }
    return;
  }
  if (message.type === 'route.body.ack') {
    const state = activeStreams.get(message.invocationId);
    if (!state) return;
    const bytes = message.bytes;
    if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0) {
      state.inFlight = Math.max(0, state.inFlight - bytes);
      wakeBodyQueue(state);
      state.flush();
    }
    return;
  }
  if (message.type === 'route.abort') {
    activeInvocations.get(message.invocationId)?.abort();
    return;
  }
  if (message.type === 'callback.invoke') {
    const controller = new AbortController();
    activeInvocations.set(message.invocationId, controller);
    try {
      const value = await invokeRegisteredCallback(
        message.registrationId,
        message.operation,
        message.payload,
        controller.signal,
        (event) =>
          send({
            type: 'callback.event',
            invocationId: message.invocationId,
            value: event,
          }),
      );
      send({
        type: 'callback.result',
        invocationId: message.invocationId,
        ok: true,
        value,
      });
    } catch (error) {
      send({
        type: 'callback.result',
        invocationId: message.invocationId,
        ok: false,
        error: {
          code: error?.code ?? 'PLUGIN_LOAD_FAILED',
          message: String(error?.message ?? error),
        },
      });
    } finally {
      activeInvocations.delete(message.invocationId);
    }
    return;
  }
  if (message.type === 'callback.abort') {
    activeInvocations.get(message.invocationId)?.abort();
    return;
  }
  if (message.type === 'event.emit') {
    for (const handler of [...(eventHandlers.get(message.event) ?? [])]) {
      try {
        // Isolate subscribers, but report failures — silent swallowing left
        // broken event handlers with zero telemetry.
        void Promise.resolve(handler(message.payload)).catch((error) => {
          send({
            type: 'log',
            level: 'error',
            message: `event handler failed for ${message.event}: ${error?.message ?? error}`,
          });
        });
      } catch (error) {
        send({
          type: 'log',
          level: 'error',
          message: `event handler threw for ${message.event}: ${error?.message ?? error}`,
        });
      }
    }
    return;
  }
  if (message.type === 'deactivate') {
    let exitCode = 0;
    try {
      await definition?.deactivate?.();
    } catch (error) {
      // A failed deactivate is not a clean shutdown: report it and exit
      // non-zero so the host's exit bookkeeping can distinguish the two.
      exitCode = 1;
      send({
        type: 'log',
        level: 'error',
        message: `deactivate failed: ${error?.message ?? error}`,
      });
    } finally {
      send({ type: 'deactivated' });
      process.exit(exitCode);
    }
  }
}

const activeInvocations = new Map();

/**
 * A route handler may answer with a streaming body: `{status?, headers?, body}`
 * (or a bare ReadableStream / a promise of either). Non-stream answers keep
 * the plain `route.result` path.
 */
function extractStreamBody(response) {
  const isWebStream = (value) =>
    value !== null && typeof value === 'object' && typeof value.getReader === 'function';
  if (isWebStream(response)) return { status: undefined, headers: undefined, stream: response };
  if (response && typeof response === 'object' && isWebStream(response.body)) {
    return { status: response.status, headers: response.headers, stream: response.body };
  }
  return null;
}

async function pumpRouteStream(invocationId, info, signal) {
  send({ type: 'route.body.open', invocationId, status: info.status, headers: info.headers });
  const state = {
    invocationId,
    reader: info.stream.getReader(),

    inFlight: 0,
    seq: 0,
    aborted: false,
    done: false,
    queue: [],
    flushing: false,
    resolveWait: null,
    flush() {
      void drainBodyQueue(this);
    },
  };
  activeStreams.set(invocationId, state);
  const onAbort = () => {
    state.aborted = true;
    state.reader.cancel().catch(() => undefined);
    wakeBodyQueue(state);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await drainBodyQueue(state);
    if (!state.aborted) send({ type: 'route.body.end', invocationId });
  } catch (error) {
    if (!state.aborted) {
      send({
        type: 'route.body.error',
        invocationId,
        message: String(error?.message ?? error),
      });
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    try {
      state.reader.releaseLock();
    } catch {
      // Already released after cancel().
    }
    activeStreams.delete(invocationId);
  }
}

function wakeBodyQueue(state) {
  const resolveWait = state.resolveWait;
  state.resolveWait = null;
  resolveWait?.();
}

async function drainBodyQueue(state) {
  if (state.flushing) return;
  state.flushing = true;
  try {
    for (;;) {
      if (state.aborted) return;
      if (state.queue.length === 0) {
        if (state.done) return;
        let next;
        try {
          next = await state.reader.read();
        } catch (error) {
          if (state.aborted) return;
          throw error;
        }
        if (next.done) {
          state.done = true;
          continue;
        }
        const value = next.value;
        if (!value || value.byteLength === 0) continue;
        if (!(value instanceof Uint8Array)) {
          throw new TypeError('Stream body chunks must be bytes (Uint8Array)');
        }
        for (let offset = 0; offset < value.byteLength; offset += STREAM_CHUNK_BYTES) {
          state.queue.push(value.subarray(offset, offset + STREAM_CHUNK_BYTES));
        }
        continue;
      }
      const chunk = state.queue[0];
      if (state.inFlight + chunk.byteLength > STREAM_WINDOW_BYTES) {
        // Out of credit — stall until the host acks consumed bytes.
        await new Promise((resolveWait) => {
          state.resolveWait = resolveWait;
        });
        continue;
      }
      state.queue.shift();
      state.inFlight += chunk.byteLength;
      state.seq += 1;
      send({
        type: 'route.body.chunk',
        invocationId: state.invocationId,
        seq: state.seq,
        data: Buffer.from(chunk).toString('base64'),
        bytes: chunk.byteLength,
      });
    }
  } finally {
    state.flushing = false;
  }
}

async function invokeRegisteredCallback(registrationId, operation, payload, signal, emit) {
  if (operation.startsWith('tokenizer.')) {
    const profile = tokenizerProfiles.get(registrationId);
    if (!profile) throw new Error('Tokenizer registration is unavailable');
    if (operation === 'tokenizer.matches') {
      return Boolean(await profile.matches(String(payload?.model ?? '')));
    }
    if (operation === 'tokenizer.count') {
      return profile.count(String(payload?.text ?? ''));
    }
  }
  if (operation.startsWith('provider.')) {
    const factory = providerFactories.get(registrationId);
    if (!factory) throw new Error('Provider registration is unavailable');
    const adapter = await factory(payload?.config ?? {});
    if (!adapter || typeof adapter !== 'object') throw new TypeError('Provider factory is invalid');
    if (operation === 'provider.validateConfig') {
      return adapter.validateConfig();
    }
    if (operation === 'provider.listModels') {
      return adapter.listModels(signal);
    }
    if (operation === 'provider.countTokens') {
      if (typeof adapter.countTokens === 'function') {
        return adapter.countTokens(payload?.request);
      }
      const messages = Array.isArray(payload?.request?.messages) ? payload.request.messages : [];
      const tokens = messages.reduce(
        (sum, message) =>
          sum + Math.max(1, Math.ceil(String(message?.content ?? '').length / 4)) + 4,
        0,
      );
      return { tokens, approximate: true };
    }
    if (operation === 'provider.generate') {
      const events = adapter.generate(payload?.request, signal);
      for await (const event of events) emit(event);
      return undefined;
    }
    if (operation === 'provider.speech') {
      if (typeof adapter.speech !== 'function') {
        throw new Error('Provider does not support speech');
      }
      for await (const event of adapter.speech(payload?.request, signal)) emit(event);
      return undefined;
    }
    if (operation === 'provider.image') {
      if (typeof adapter.image !== 'function') {
        throw new Error('Provider does not support image generation');
      }
      for await (const event of adapter.image(payload?.request, signal)) emit(event);
      return undefined;
    }
    if (operation === 'provider.transcribe') {
      if (typeof adapter.transcribe !== 'function') {
        throw new Error('Provider does not support transcription');
      }
      return adapter.transcribe(payload?.request, signal);
    }
  }
  if (operation === 'context.shift') {
    const strategy = contextStrategies.get(registrationId);
    if (!strategy) throw new Error('Context strategy registration is unavailable');
    const tokenCounts = payload?.tokenCounts ?? {};
    const countTokens = (text) => {
      const known = tokenCounts[String(text)];
      return Number.isSafeInteger(known) ? known : Math.max(1, Math.ceil(String(text).length / 4));
    };
    return strategy.shift({
      messages: payload?.messages ?? [],
      budgetTokens: payload?.budgetTokens ?? 0,
      countTokens,
      manualExcludedIds: new Set(payload?.manualExcludedIds ?? []),
    });
  }
  if (operation === 'postProcess.run') {
    const processor = postProcessors.get(registrationId);
    if (!processor) throw new Error('Post-processor registration is unavailable');
    return processor.process(String(payload?.text ?? ''), payload?.context ?? {});
  }
  throw new Error(`Unknown plugin callback operation: ${operation}`);
}

try {
  const loaded = await import(`${pathToFileURL(entryPath).href}?worker=${Date.now()}`);
  definition = loaded.default;
  if (!definition || typeof definition.activate !== 'function') {
    throw new TypeError('Backend entry must default-export a plugin definition');
  }
  await definition.activate(api);
  await Promise.all(startupRegistrations);
  send({ type: 'ready' });
  startUsageReports();
} catch (error) {
  send({
    type: 'activationError',
    code: error?.code ?? 'PLUGIN_LOAD_FAILED',
    message: String(error?.message ?? error),
  });
  // A worker that never became ready has no remaining purpose; exit instead of
  // idling until the host-side ready timeout kills it (PLUG-59 L9).
  process.exit(1);
}
