/**
 * Rev4 kernel client for the sandboxed frontend plugin (rev4 §A1/A2).
 *
 * Returns plain JavaScript interpolated into the generated sandbox module
 * BEFORE the plugin entry import, so `api` extensions exist when
 * `activate(api)` runs. It runs in the same scope as the v2 bootstrap and
 * reuses `api`, `eventHandlers`, `onCapabilityRevoked`, `mountContainer` and
 * `applyLayout`. It mirrors the wire protocol of
 * `packages/plugin-sdk/src/kernel/session.ts` (envelopes, credit-based
 * streams, deadlines, cancellation) without importing host code — the
 * sandbox must stay self-contained.
 *
 * The bootstrap stores the transferred MessagePort on
 * `globalThis.__neotavernKernelPort` asynchronously (the bootstrap envelope arrives
 * after module evaluation), so this client defers `boot()` until the port is
 * present: immediately when already set, otherwise on the
 * `neotavern-kernel-port-ready` event dispatched by the bootstrap listener.
 *
 * The generated code MUST stay free of backticks, `${` and backslashes
 * because it is interpolated into the outer template literal of
 * `buildSandboxBootstrap`.
 */
export function buildSandboxRev4Client(): string {
  return `
// ── rev4 kernel client (plain JS mirror of kernel/session.ts) ─────────────
(function () {
  function boot() {
    var kport = globalThis.__neotavernKernelPort;
    if (!kport || typeof kport.postMessage !== 'function') return;
    var WIN = 262144;            // streams.maxInFlightBytes default
    var BUF = 2 * 1024 * 1024;   // streams.maxBufferedBytesPerStream default
    var seq = 0;
    function nextId(prefix) { seq += 1; return 'plugin:' + prefix + ':' + seq; }
    function kerr(code, details) {
      var e = new Error(code);
      e.code = code;
      e.retryable = false;
      if (details) e.details = details;
      return e;
    }
    function toWire(error) {
      if (error && typeof error === 'object' && typeof error.code === 'string') {
        var wire = { code: error.code, retryable: Boolean(error.retryable) };
        if (error.retryAfterMs) wire.retryAfterMs = error.retryAfterMs;
        if (error.details) wire.details = error.details;
        return wire;
      }
      return { code: 'INTERNAL', retryable: false, details: { message: String((error && error.message) || error) } };
    }
    function fromWire(wire) {
      var e = new Error((wire && wire.code) || 'INTERNAL');
      e.code = (wire && wire.code) || 'INTERNAL';
      e.retryable = Boolean(wire && wire.retryable);
      if (wire && wire.details) e.details = wire.details;
      return e;
    }

    var K = {
      instanceId: 'rev4:' + Math.random().toString(36).slice(2),
      pending: new Map(),
      handlers: new Map(),
      remote: new Map(),
      outStreams: new Map(),
      inStreams: new Map(),
      openListeners: new Set(),
      revokedListeners: new Set(),
      limits: null,
      features: {},
      grants: [],
      tokens: null,
      disposed: false,
      call: call,
      handle: handle,
      openOutbound: openOutbound,
      readInbound: readInbound,
      onInboundStream: function (listener) { K.openListeners.add(listener); return function () { K.openListeners.delete(listener); }; },
      onRevoked: function (listener) { K.revokedListeners.add(listener); return function () { K.revokedListeners.delete(listener); }; },
      supports: function (name, version) { return (K.features[name] || 0) >= (version == null ? 1 : version); },
    };
    globalThis.__neotavernKernel = K;

    // The bootstrap listener stores the host handshake on the port; when the
    // port arrived before boot we can already read limits/features from it.
    var seed = globalThis.__neotavernHostHandshake;
    if (seed && typeof seed === 'object') applyHandshake(seed);
    function applyHandshake(env) {
      K.limits = env.limits || null;
      K.features = env.supportedFeatures || {};
      K.grants = env.grantedCapabilities || [];
      K.tokens = env.themeTokens || null;
      if (K.limits && K.limits.streams) {
        if (typeof K.limits.streams.maxInFlightBytes === 'number') WIN = K.limits.streams.maxInFlightBytes;
        if (typeof K.limits.streams.maxBufferedBytesPerStream === 'number') BUF = K.limits.streams.maxBufferedBytesPerStream;
      }
    }

    function sendEnv(env) { try { kport.postMessage(env); } catch (e) {} }

    function call(method, params, opts) {
      opts = opts || {};
      return new Promise(function (resolve, reject) {
        if (K.disposed) { reject(kerr('OPERATION_ABORTED')); return; }
        var id = nextId('req');
        var timer = opts.deadlineMs == null ? null : setTimeout(function () {
          K.pending.delete(id);
          reject(kerr('OPERATION_DEADLINE', { method: method }));
        }, Math.max(1, opts.deadlineMs));
        K.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
        var env = { kind: 'rpc.request', id: id, instanceId: K.instanceId, method: method, params: params, deadline: opts.deadlineMs == null ? null : Date.now() + Math.max(1, opts.deadlineMs) };
        if (opts.idempotencyKey != null) env.idempotencyKey = opts.idempotencyKey;
        sendEnv(env);
        if (opts.signal) {
          if (opts.signal.aborted) cancelReq(id);
          else opts.signal.addEventListener('abort', function () { cancelReq(id); }, { once: true });
        }
      });
    }
    function cancelReq(id) {
      var p = K.pending.get(id);
      if (!p) return;
      clearTimeout(p.timer);
      K.pending.delete(id);
      sendEnv({ kind: 'rpc.cancel', id: id });
      p.reject(kerr('OPERATION_ABORTED'));
    }
    function handle(method, fn) {
      if (K.handlers.has(method)) throw kerr('VALIDATION_FAILED', { method: method, reason: 'duplicate-handler' });
      K.handlers.set(method, fn);
      return function () { K.handlers.delete(method); };
    }

    // Outbound (plugin→host) credit-pumped byte streams (rev4 §D4).
    function openOutbound(meta) {
      var streamId = nextId('str');
      var st = { credit: 0, queue: [], queued: 0, seq: 0, ended: false, errored: false, drain: [], pump: pump };
      K.outStreams.set(streamId, st);
      sendEnv({ kind: 'stream.open', streamId: streamId, direction: 'plugin-to-host', meta: meta });
      function pump() {
        while (st.credit > 0 && st.queue.length > 0) {
          var chunk = st.queue[0];
          if (chunk.byteLength > st.credit) break;
          st.queue.shift();
          st.queued -= chunk.byteLength;
          var s = st.seq;
          st.seq += 1;
          var buf = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
          try { kport.postMessage({ kind: 'stream.chunk', streamId: streamId, seq: s, buffer: buf }, [buf]); } catch (e) {}
        }
        if (st.ended && st.queue.length === 0) {
          sendEnv({ kind: 'stream.end', streamId: streamId });
          K.outStreams.delete(streamId);
          return;
        }
        if (st.queued <= BUF / 2) { for (var w of st.drain.splice(0)) w(); }
      }
      function waitDrain() {
        if (st.errored) return Promise.reject(kerr('STREAM_FAILED'));
        return new Promise(function (r) { st.drain.push(r); });
      }
      return {
        streamId: streamId,
        write: function (chunk) {
          if (st.ended || st.errored) return Promise.reject(kerr('STREAM_FAILED', { reason: 'closed' }));
          if (chunk.byteLength > WIN) return Promise.reject(kerr('PLUGIN_QUOTA_EXCEEDED', { limit: 'streams.maxInFlightBytes' }));
          return Promise.resolve().then(function () {
            if (st.queued + chunk.byteLength > BUF) return waitDrain();
          }).then(function () {
            st.queue.push(chunk);
            st.queued += chunk.byteLength;
            pump();
            if (st.queued > BUF) return waitDrain();
          });
        },
        end: function () {
          if (st.ended || st.errored) return;
          st.ended = true;
          if (st.queue.length > 0) return; // pump() sends the deferred end
          sendEnv({ kind: 'stream.end', streamId: streamId });
          K.outStreams.delete(streamId);
        },
        fail: function (error) {
          if (st.errored || st.ended) return;
          st.errored = true;
          sendEnv({ kind: 'stream.error', streamId: streamId, error: toWire(error) });
          K.outStreams.delete(streamId);
        },
      };
    }

    // Inbound (host→plugin) reader; credit replenished after each read chunk.
    function readInbound(streamId) {
      var st = K.inStreams.get(streamId);
      if (!st) { st = { chunks: [], nextSeq: 0, ended: false, error: null, waiters: [], granted: 0, meta: {} }; K.inStreams.set(streamId, st); }
      function topUp() {
        var outstanding = WIN - st.granted;
        if (outstanding <= 0) return;
        st.granted += outstanding;
        sendEnv({ kind: 'stream.credit', streamId: streamId, bytes: outstanding });
      }
      return {
        meta: st.meta,
        pull: function () {
          if (st.error) { K.inStreams.delete(streamId); return Promise.reject(st.error); }
          if (st.chunks.length > 0) {
            var chunk = st.chunks.shift();
            topUp();
            return Promise.resolve(chunk);
          }
          if (st.ended) { K.inStreams.delete(streamId); return Promise.resolve(null); }
          return new Promise(function (resolve, reject) { st.waiters.push({ resolve: resolve, reject: reject }); });
        },
        readAll: function () {
          var self = this;
          var parts = [];
          var total = 0;
          function loop() {
            return self.pull().then(function (chunk) {
              if (!chunk) {
                var all = new Uint8Array(total);
                var off = 0;
                for (var part of parts) { all.set(part, off); off += part.byteLength; }
                return all;
              }
              parts.push(chunk);
              total += chunk.byteLength;
              return loop();
            });
          }
          return loop();
        },
        cancel: function () {
          sendEnv({ kind: 'stream.cancel', streamId: streamId });
          K.inStreams.delete(streamId);
        },
      };
    }

    kport.addEventListener('message', function (event) {
      var env = event.data;
      if (!env || typeof env !== 'object') return;
      if (env.type === 'neotavern.kernel.host-handshake') { applyHandshake(env); return; }
      switch (env.kind) {
        case 'rpc.request': {
          var fn = K.handlers.get(env.method);
          var ac = new AbortController();
          K.remote.set(env.id, ac);
          var deadlineTimer = null;
          if (typeof env.deadline === 'number') {
            var remaining = env.deadline - Date.now();
            if (remaining <= 0) {
              K.remote.delete(env.id);
              sendEnv({ kind: 'rpc.response', id: env.id, ok: false, error: toWire(kerr('OPERATION_DEADLINE')) });
              return;
            }
            deadlineTimer = setTimeout(function () { ac.abort(); }, remaining);
          }
          Promise.resolve()
            .then(function () {
              if (!fn) throw kerr('PROTOCOL_UNSUPPORTED', { method: env.method });
              return fn(env.params, { signal: ac.signal });
            })
            .then(function (result) {
              clearTimeout(deadlineTimer);
              K.remote.delete(env.id);
              if (ac.signal.aborted) sendEnv({ kind: 'rpc.response', id: env.id, ok: false, error: toWire(kerr('OPERATION_ABORTED')) });
              else sendEnv({ kind: 'rpc.response', id: env.id, ok: true, result: result });
            })
            .catch(function (error) {
              clearTimeout(deadlineTimer);
              K.remote.delete(env.id);
              sendEnv({ kind: 'rpc.response', id: env.id, ok: false, error: toWire(error) });
            });
          return;
        }
        case 'rpc.response': {
          var p = K.pending.get(env.id);
          if (!p) return;
          clearTimeout(p.timer);
          K.pending.delete(env.id);
          if (env.ok) p.resolve(env.result);
          else p.reject(fromWire(env.error));
          return;
        }
        case 'rpc.cancel': {
          var remote = K.remote.get(env.id);
          if (remote) { K.remote.delete(env.id); remote.abort(); }
          return;
        }
        case 'stream.open': {
          var inState = K.inStreams.get(env.streamId) || { chunks: [], nextSeq: 0, ended: false, error: null, waiters: [], granted: 0, meta: {} };
          inState.meta = env.meta || {};
          K.inStreams.set(env.streamId, inState);
          inState.granted = WIN;
          sendEnv({ kind: 'stream.credit', streamId: env.streamId, bytes: WIN });
          for (var listener of [...K.openListeners]) { try { listener(env.streamId, inState.meta); } catch (e) {} }
          return;
        }
        case 'stream.credit': {
          var out = K.outStreams.get(env.streamId);
          if (!out) return;
          out.credit += env.bytes;
          out.pump();
          return;
        }
        case 'stream.chunk': {
          var st = K.inStreams.get(env.streamId);
          if (!st || st.ended || st.error) return;
          if (env.seq !== st.nextSeq) return;
          st.nextSeq += 1;
          st.granted = Math.max(0, st.granted - env.buffer.byteLength);
          var chunk = new Uint8Array(env.buffer);
          var waiter = st.waiters.shift();
          if (waiter) waiter.resolve(chunk);
          else st.chunks.push(chunk);
          return;
        }
        case 'stream.end': {
          var endState = K.inStreams.get(env.streamId);
          if (!endState) return;
          endState.ended = true;
          for (var w of endState.waiters.splice(0)) w.resolve(null);
          return;
        }
        case 'stream.error': {
          var errState = K.inStreams.get(env.streamId);
          if (!errState) return;
          errState.error = fromWire(env.error);
          for (var ew of errState.waiters.splice(0)) ew.reject(errState.error);
          return;
        }
        case 'stream.cancel': {
          var cancelled = K.outStreams.get(env.streamId);
          if (!cancelled) return;
          cancelled.errored = true;
          for (var d of cancelled.drain.splice(0)) d();
          K.outStreams.delete(env.streamId);
          return;
        }
        case 'capability.revoked': {
          K.grants = K.grants.filter(function (g) { return g && g.name !== env.name; });
          for (var rl of [...K.revokedListeners]) { try { rl(env.name, env.revision); } catch (e) {} }
          if (typeof onCapabilityRevoked === 'function') { try { onCapabilityRevoked(env.name, env.revision); } catch (e) {} }
          return;
        }
        case 'evt.emit': {
          var rev4Subscribers = typeof eventSubscribers !== 'undefined' ? eventSubscribers.get(env.event) : null;
          if (rev4Subscribers) for (var r4 of [...rev4Subscribers]) { try { r4(env.payload); } catch (e) {} }
          var rev4Local = typeof eventLocalHandlers !== 'undefined' ? eventLocalHandlers.get(env.event) : null;
          if (rev4Local) for (var rl of [...rev4Local]) { try { rl(env.payload); } catch (e) {} }
          var rev4Streams = typeof eventStreams !== 'undefined' ? eventStreams.get(env.event) : null;
          if (rev4Streams) {
            var envelope = { payload: env.payload, event: env.event, eventId: env.eventId, cursor: env.cursor, sequence: env.sequence };
            for (var rs of [...rev4Streams]) { try { rs(envelope); } catch (e) {} }
          }
          var handlers = typeof eventHandlers !== 'undefined' ? eventHandlers.get(env.event) : null;
          if (handlers) for (var h of [...handlers]) { try { h(env.payload); } catch (e) {} }
          return;
        }
        default:
          return;
      }
    });
    kport.start && kport.start();

    // ── api extensions (rev4 §A3) ───────────────────────────────────────────
    api.runtime = {
      supports: K.supports,
      limits: function () { return K.limits; },
      protocolVersion: '2.0.0',
      sdkVersion: '1.0.0',
    };
    api.limits = function () { return K.limits; };
    api.events.onKernelRevoked = K.onRevoked;

/* ===SECTION:NOTIFY=== */
    var notifySeq = 0;
    function kernelNotify(notification) {
      notification = notification || {};
      var params = { title: String(notification.title == null ? '' : notification.title) };
      if (notification.description != null) params.description = String(notification.description);
      if (notification.variant != null) params.variant = String(notification.variant);
      if (typeof notification.timeoutMs === 'number') params.timeoutMs = notification.timeoutMs;
      notifySeq += 1;
      params.registrationId = 'knotify:' + notifySeq;
      K.call('notifications.show', params).catch(function () {});
      return function () {
        K.call('notifications.dismiss', { registrationId: params.registrationId }).catch(function () {});
      };
    }
    api.notify = kernelNotify;
    api.notifications = {
      show: kernelNotify,
      dismiss: function (registrationId) {
        return K.call('notifications.dismiss', { registrationId: String(registrationId) });
      },
    };
/* ===SECTION:NOTIFY:END=== */

/* ===SECTION:CAPABILITIES=== */
    api.capabilities = {
      list: function () {
        return K.call('capabilities.list', {}).then(function (res) { return (res && res.grants) || []; });
      },
      granted: function (name) {
        for (var g of K.grants) { if (g && g.name === name) return true; }
        return false;
      },
      // Runtime grant requests ride the host consent UI round-trip (rev4 §B2):
      // the host validates, shows the consent dialog, persists the grant and
      // returns it; denied requests reject with CAPABILITY_DENIED.
      request: function (request) {
        if (!request || typeof request !== 'object' || typeof request.name !== 'string') {
          return Promise.reject(kerr('VALIDATION_FAILED', { reason: 'capability-name-required' }));
        }
        return K.call('capabilities.request', { name: request.name, scope: request.scope }).then(function (res) {
          if (!res || !res.grant) throw kerr('PROTOCOL_INVALID', { method: 'capabilities.request' });
          var grant = res.grant;
          var idx = -1;
          for (var i = 0; i < K.grants.length; i++) { if (K.grants[i] && K.grants[i].name === grant.name) { idx = i; break; } }
          if (idx >= 0) K.grants.splice(idx, 1);
          K.grants.push(grant);
          return grant;
        });
      },
      onRevoked: K.onRevoked,
    };
/* ===SECTION:CAPABILITIES:END=== */

/* ===SECTION:DIAGNOSTICS=== */
    api.diagnostics = {
      // Read-only snapshot of the plugin's own runtime state. The host
      // builds it from public registry fields only — never secrets.
      get: function () {
        return K.call('diagnostics.get', {}).then(function (res) {
          if (!res || typeof res.snapshot !== 'object' || res.snapshot === null) {
            throw kerr('PROTOCOL_INVALID', { method: 'diagnostics.get' });
          }
          return res.snapshot;
        });
      },
    };
/* ===SECTION:DIAGNOSTICS:END=== */

/* ===SECTION:PING=== */
    // rev4 §M3: liveness probe — the host pings every live session on an
    // interval; a sandbox whose main thread stops answering (hung or
    // crashed) is restarted under the restart budget and finally disabled.
    // A hung thread never reaches this handler, so the host-side deadline
    // is the actual detector; this just answers healthy pings.
    K.handle('kernel.ping', function () {
      return { ok: true };
    });
/* ===SECTION:PING:END=== */

/* ===SECTION:AUTH=== */
    // OAuth connections (rev4 §K5). Metadata only — tokens never reach the
    // sandbox; authenticated calls go through network.fetch + connectionId.
    api.auth = {
      list: function () {
        return K.call('auth.list', {}).then(function (res) {
          if (!res || !Array.isArray(res.connections)) throw kerr('PROTOCOL_INVALID', { method: 'auth.list' });
          return res.connections;
        });
      },
      get: function (connectionId) {
        return K.call('auth.get', { connectionId: String(connectionId) }).then(function (res) {
          if (!res || typeof res !== 'object' || res.connection === undefined) throw kerr('PROTOCOL_INVALID', { method: 'auth.get' });
          return res.connection;
        });
      },
      connect: function (serviceId, opts) {
        opts = opts || {};
        var params = { serviceId: String(serviceId) };
        if (opts.scopes != null) params.scopes = opts.scopes;
        return K.call('auth.connect', params).then(function (res) {
          if (!res || typeof res.connectionId !== 'string' || typeof res.status !== 'string') {
            throw kerr('PROTOCOL_INVALID', { method: 'auth.connect' });
          }
          return res;
        });
      },
      revoke: function (connectionId) {
        return K.call('auth.revoke', { connectionId: String(connectionId) }).then(function () {
          return { ok: true };
        });
      },
    };
/* ===SECTION:AUTH:END=== */

/* ===SECTION:SERVICES=== */
    // Cross-plugin services (rev4 §D). Handlers stay in this realm; the host
    // routes consumer calls back through K.handle('services.invoke'). The
    // published serviceId is host-prefixed ('<pluginId>.<name>').
    var serviceHandlers = new Map();
    api.services = {
      provide: function (opts) {
        opts = opts || {};
        return K.call('services.provide', {
          name: opts.name,
          methods: opts.methods,
          version: opts.version,
          description: opts.description,
          timeoutMs: opts.timeoutMs,
        }).then(function (res) {
          var serviceId = res.serviceId;
          if (typeof opts.handle === 'function') serviceHandlers.set(serviceId, opts.handle);
          return {
            serviceId: serviceId,
            dispose: function () {
              serviceHandlers.delete(serviceId);
              return K.call('services.unprovide', { serviceId: serviceId });
            },
          };
        });
      },
      list: function () {
        return K.call('services.list', {}).then(function (res) {
          if (!res || !Array.isArray(res.items)) throw kerr('PROTOCOL_INVALID', { method: 'services.list' });
          return res.items;
        });
      },
      connect: function (serviceId) {
        return K.call('services.connect', { serviceId: String(serviceId) }).then(function (res) {
          if (!res || typeof res.connectionId !== 'string' || !Array.isArray(res.methods)) {
            throw kerr('PROTOCOL_INVALID', { method: 'services.connect' });
          }
          return res;
        });
      },
      invoke: function (connectionId, method, params, opts) {
        return K.call('services.invoke', {
          connectionId: String(connectionId),
          method: String(method),
          params: params,
        }, { signal: opts && opts.signal });
      },
      disconnect: function (connectionId) {
        return K.call('services.disconnect', { connectionId: String(connectionId) });
      },
    };
    K.handle('services.invoke', function (params, opts) {
      var serviceId = params && params.serviceId;
      var handle = serviceHandlers.get(serviceId);
      if (typeof handle !== 'function') throw kerr('SERVICE_NOT_FOUND', { serviceId: serviceId });
      return Promise.resolve(handle({
        callerPluginId: params.callerPluginId,
        method: params.method,
        params: params.params,
        signal: opts && opts.signal,
      }));
    });
/* ===SECTION:SERVICES:END=== */

/* ===SECTION:EVENTS=== */
    var eventSubscribers = new Map();
    var eventLocalHandlers = new Map();
    var eventStreams = new Map();
    api.events.subscribe = function (event, cb) {
      if (typeof event !== 'string' || event.length === 0 || event.length > 200) throw kerr('VALIDATION_FAILED', { field: 'event' });
      // rev4 §J1: subscribe(event, options) — no callback — returns the
      // async-iterator stream (cursor replay, at-least-once, backpressure).
      if (typeof cb !== 'function') return eventStreamIterator(event, cb || {});
      var subs = eventSubscribers.get(event);
      if (!subs) { subs = new Set(); eventSubscribers.set(event, subs); }
      subs.add(cb);
      return K.call('events.subscribe', { event: event }).then(function () {
        return function () {
          var current = eventSubscribers.get(event);
          if (!current) return Promise.resolve();
          current.delete(cb);
          if (current.size === 0) eventSubscribers.delete(event);
          return K.call('events.unsubscribe', { event: event }).catch(function () {});
        };
      }).catch(function (error) {
        var current = eventSubscribers.get(event);
        if (current) { current.delete(cb); if (current.size === 0) eventSubscribers.delete(event); }
        throw error;
      });
    };
    api.events.unsubscribe = function (event, cb) {
      var current = eventSubscribers.get(event);
      if (current) { current.delete(cb); if (current.size === 0) eventSubscribers.delete(event); }
      return K.call('events.unsubscribe', { event: event }).catch(function () {});
    };
    // rev4 §J3: local-only listener for host-generated envelopes (window
    // role transitions, lifecycle pushes). No RPC: these events never pass
    // the events.subscribe allowlist — they arrive as evt.emit directly.
    api.events.on = function (event, cb) {
      if (typeof event !== 'string' || event.length === 0) throw kerr('VALIDATION_FAILED', { field: 'event' });
      if (typeof cb !== 'function') throw kerr('VALIDATION_FAILED', { field: 'callback' });
      var subs = eventLocalHandlers.get(event);
      if (!subs) { subs = new Set(); eventLocalHandlers.set(event, subs); }
      subs.add(cb);
      return function () {
        var current = eventLocalHandlers.get(event);
        if (!current) return;
        current.delete(cb);
        if (current.size === 0) eventLocalHandlers.delete(event);
      };
    };
    // rev4 §J1: async-iterator surface. The iterator acks the previously
    // delivered event when next() is called — the consumer has finished
    // handling it (at-least-once). return() unsubscribes; signal aborts.
    function eventStreamIterator(event, options) {
      var queue = [];
      var waiters = [];
      var closed = false;
      var deliveredSeq = null;
      var doneResult = { value: undefined, done: true };
      function ackDelivered() {
        if (deliveredSeq === null) return;
        var seq = deliveredSeq;
        deliveredSeq = null;
        K.call('events.ack', { event: event, sequence: seq }).catch(function () {});
      }
      function push(envelope) {
        if (closed) return;
        var waiter = waiters.shift();
        if (waiter) { deliveredSeq = envelope.sequence; waiter({ value: envelope, done: false }); return; }
        queue.push(envelope);
      }
      function openStream() {
        var subs = eventStreams.get(event);
        if (!subs) { subs = new Set(); eventStreams.set(event, subs); }
        subs.add(push);
        var params = { event: event };
        if (options && options.cursor != null) params.cursor = String(options.cursor);
        if (options && options.maxInFlight != null) params.maxInFlight = Number(options.maxInFlight);
        return K.call('events.subscribe', params).catch(function (error) {
          var current = eventStreams.get(event);
          if (current) { current.delete(push); if (current.size === 0) eventStreams.delete(event); }
          throw error;
        });
      }
      function closeStream() {
        if (closed) return;
        closed = true;
        var current = eventStreams.get(event);
        if (current) { current.delete(push); if (current.size === 0) eventStreams.delete(event); }
        for (var w; (w = waiters.shift()); ) w(doneResult);
        if (options && options.signal) { try { options.signal.removeEventListener('abort', abortHandler); } catch (e) {} }
        K.call('events.unsubscribe', { event: event }).catch(function () {});
      }
      function abortHandler() { closeStream(); }
      var openPromise = openStream();
      var iterator = {
        next: function () {
          ackDelivered();
          if (closed) return Promise.resolve(doneResult);
          var item = queue.shift();
          if (item) { deliveredSeq = item.sequence; return Promise.resolve({ value: item, done: false }); }
          return openPromise.then(function () {
            var item2 = queue.shift();
            if (item2) { deliveredSeq = item2.sequence; return { value: item2, done: false }; }
            if (closed) return doneResult;
            return new Promise(function (resolve) { waiters.push(resolve); });
          }).catch(function (error) {
            closeStream();
            throw error;
          });
        },
        return: function () { closeStream(); return Promise.resolve(doneResult); },
      };
      if (typeof Symbol !== 'undefined' && Symbol.asyncIterator) iterator[Symbol.asyncIterator] = function () { return iterator; };
      if (options && options.signal) {
        if (options.signal.aborted) { closeStream(); }
        else { try { options.signal.addEventListener('abort', abortHandler, { once: true }); } catch (e) {} }
      }
      return iterator;
    }
    api.events.stream = eventStreamIterator;
/* ===SECTION:EVENTS:END=== */

/* ===SECTION:WINDOWS=== */
    // rev4 §J3: host-elected background-role per installation. The plugin
    // UI runs in every window; background consumers (listeners, polling,
    // job triggers) must run only in the primary window. Role transitions
    // arrive as evt.emit 'window.background.changed' — listen via
    // api.events.on (host-generated event, no capability).
    api.windows = {
      role: function () { return K.call('windows.role', {}); },
      isBackground: function () {
        return K.call('windows.isBackground', {}).then(function (result) { return !!result.isBackground; });
      },
    };
/* ===SECTION:WINDOWS:END=== */

/* ===SECTION:STORAGE=== */
  var BLOB_CHUNK = 65536;
  function blobPut(name, contentType, bytes) {
    var data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var out = K.openOutbound({ kind: 'blobs.put', name: name, contentType: contentType });
    var offset = 0;
    function writeNext() {
      if (offset >= data.byteLength) { out.end(); return Promise.resolve(); }
      var end = Math.min(offset + BLOB_CHUNK, data.byteLength);
      var piece = data.subarray(offset, end);
      offset = end;
      return out.write(piece).then(writeNext);
    }
    return writeNext().then(function () {
      return K.call('storage.blobs.put', { streamId: out.streamId, name: name, contentType: contentType, size: data.byteLength });
    }).catch(function (error) { out.fail(error); throw error; });
  }
  function blobGet(blobId) {
    return K.call('storage.blobs.get', { blobId: blobId }).then(function (result) {
      return K.readInbound(result.streamId).readAll().then(function (bytes) {
        return { bytes: bytes, contentType: result.contentType, size: result.size };
      });
    });
  }
  api.storage = {
    kv: {
      get: function (scope, key) { return K.call('storage.kv.get', { scope: scope, key: key }); },
      set: function (scope, key, value, expectedRevision) {
        var params = { scope: scope, key: key, value: value };
        if (expectedRevision !== undefined) params.expectedRevision = expectedRevision;
        return K.call('storage.kv.set', params);
      },
      delete: function (scope, key) { return K.call('storage.kv.delete', { scope: scope, key: key }); },
      list: function (scope) { return K.call('storage.kv.list', { scope: scope }); },
    },
    blobs: {
      put: blobPut,
      get: blobGet,
      list: function () { return K.call('storage.blobs.list', {}); },
      delete: function (blobId) { return K.call('storage.blobs.delete', { blobId: blobId }); },
    },
  };
/* ===SECTION:STORAGE:END=== */

/* ===SECTION:BACKEND=== */
  function backendRequest(path, opts) {
    opts = opts || {};
    var params = { path: String(path), method: String(opts.method == null ? 'GET' : opts.method).toUpperCase() };
    if (opts.headers && typeof opts.headers === 'object') params.headers = opts.headers;
    var steps = [];
    if (opts.body != null) {
      var body = opts.body instanceof Uint8Array ? opts.body : new Uint8Array(opts.body);
      var out = K.openOutbound({ kind: 'backend.body' });
      params.bodyStreamId = out.streamId;
      steps.push(out.write(body).then(function () { out.end(); }));
    }
    steps.push(K.call('backend.request', params, { signal: opts.signal }));
    return Promise.all(steps).then(function (settled) {
      return settled[settled.length - 1];
    }).then(function (res) {
      return { status: res.status, headers: res.headers || {}, body: K.readInbound(res.streamId) };
    });
  }
  function backendInvoke(path, input, opts) {
    opts = opts || {};
    var params = { path: String(path), input: input };
    if (opts.method != null) params.method = String(opts.method).toUpperCase();
    return K.call('backend.invoke', params, { signal: opts.signal });
  }
  api.backend = { request: backendRequest, invoke: backendInvoke };
/* ===SECTION:BACKEND:END=== */

/* ===SECTION:COMMANDS=== */
    var commandRunners = new Map();
    api.commands = {
      register: function (id, def, runner, opts) {
        def = def || {};
        return K.call('commands.register', { id: id, title: def.title, description: def.description, category: def.category, kernel: opts && opts.kernel === true }).then(function (res) {
          var commandId = res.commandId;
          commandRunners.set(commandId, runner);
          return {
            commandId: commandId,
            dispose: function () {
              commandRunners.delete(commandId);
              return K.call('commands.unregister', { commandId: commandId });
            },
          };
        });
      },
      unregister: function (commandId) {
        commandRunners.delete(commandId);
        return K.call('commands.unregister', { commandId: commandId });
      },
    };
    K.handle('commands.run', function (params) {
      var commandId = params && params.commandId;
      var runner = commandRunners.get(commandId);
      if (typeof runner !== 'function') throw kerr('NOT_FOUND', { commandId: commandId });
      return Promise.resolve(runner(params.context));
    });
/* ===SECTION:COMMANDS:END=== */

/* ===SECTION:SURFACES=== */
    var surfaceRunners = new Map();
    var surfaceAbortControllers = new Map();
    api.surfaces = {
      register: function (kind, definition, runner, opts) {
        return K.call('surfaces.register', { kind: kind, definition: definition, kernel: opts && opts.kernel === true }).then(function (res) {
          surfaceRunners.set(res.surfaceId, runner);
          return {
            surfaceId: res.surfaceId,
            dispose: function () {
              surfaceRunners.delete(res.surfaceId);
              return K.call('surfaces.unregister', { surfaceId: res.surfaceId });
            },
          };
        });
      },
      unregister: function (surfaceId) {
        surfaceRunners.delete(surfaceId);
        return K.call('surfaces.unregister', { surfaceId: surfaceId });
      },
    };
    K.handle('surfaces.run', function (params) {
      var surfaceId = params && params.surfaceId;
      var runner = surfaceRunners.get(surfaceId);
      if (typeof runner !== 'function') throw kerr('NOT_FOUND', { surfaceId: surfaceId });
      var context = params.context || {};
      var invocationId = typeof context.invocationId === 'string' ? context.invocationId : null;
      var controller = null;
      if (invocationId) {
        controller = new AbortController();
        surfaceAbortControllers.set(invocationId, controller);
      }
      var ctx = invocationId ? Object.assign({}, context, { signal: controller.signal }) : context;
      return Promise.resolve(runner(ctx)).then(function (value) {
        if (invocationId) surfaceAbortControllers.delete(invocationId);
        return value;
      }, function (error) {
        if (invocationId) surfaceAbortControllers.delete(invocationId);
        throw error;
      });
    });
    K.handle('surfaces.abort', function (params) {
      var invocationId = params && params.invocationId;
      var controller = typeof invocationId === 'string' ? surfaceAbortControllers.get(invocationId) : undefined;
      if (controller) {
        controller.abort();
        surfaceAbortControllers.delete(invocationId);
      }
      return {};
    });
/* ===SECTION:SURFACES:END=== */

/* ===SECTION:KERNELSURFACES=== */
    var surfaceContainers = new Map();
    var surfaceCleanups = new Map();
    var surfaceRects = new Map();
    function surfaceApplyRect(surfaceId, rect) {
      var el = surfaceContainers.get(surfaceId);
      if (!el || !rect || typeof rect !== 'object') return;
      var nums = [rect.x, rect.y, rect.width, rect.height];
      for (var i = 0; i < nums.length; i += 1) {
        if (typeof nums[i] !== 'number' || !isFinite(nums[i])) return;
      }
      el.style.position = 'fixed';
      el.style.left = rect.x + 'px';
      el.style.top = rect.y + 'px';
      el.style.width = rect.width + 'px';
      el.style.height = rect.height + 'px';
    }
    K.handle('ui.surface.mount', function (params) {
      var surfaceId = params && params.surfaceId;
      if (typeof surfaceId !== 'string' || surfaceId.length === 0) throw kerr('VALIDATION_FAILED', { field: 'surfaceId' });
      var runner = surfaceRunners.get(surfaceId);
      if (typeof runner !== 'function') throw kerr('NOT_FOUND', { surfaceId: surfaceId });
      var old = surfaceCleanups.get(surfaceId);
      if (typeof old === 'function') { try { old(); } catch (e) {} }
      surfaceCleanups.delete(surfaceId);
      var root = document.getElementById('root');
      if (!root) throw kerr('INTERNAL', { reason: 'no-root' });
      var el = document.createElement('div');
      el.dataset.neotavernRegistration = surfaceId;
      // The container is a geometry scaffold: pointer events pass through to
      // the plugin's own content (children stay interactive — the scaffold
      // itself must never be a hit target).
      el.style.pointerEvents = 'none';
      root.append(el);
      surfaceContainers.set(surfaceId, el);
      surfaceApplyRect(surfaceId, surfaceRects.get(surfaceId));
      return Promise.resolve(runner(el, params && params.context)).then(function (cleanup) {
        if (typeof cleanup === 'function') surfaceCleanups.set(surfaceId, cleanup);
        return {};
      });
    });
    K.handle('ui.surface.unmount', function (params) {
      var surfaceId = params && params.surfaceId;
      var cleanup = surfaceCleanups.get(surfaceId);
      if (typeof cleanup === 'function') { try { cleanup(); } catch (e) {} }
      surfaceCleanups.delete(surfaceId);
      var el = surfaceContainers.get(surfaceId);
      if (el) el.remove();
      surfaceContainers.delete(surfaceId);
      surfaceRects.delete(surfaceId);
      // rev4 §G7: a host-controlled close (chrome button / Escape) must also
      // remove the plugin's overlay DOM — the overlay container shares the
      // registrationId with the surface slot.
      disposeOverlayContainer(surfaceId);
      return {};
    });
    K.handle('ui.surface.layout', function (params) {
      var rects = (params && params.rects) || [];
      for (var r of rects) {
        if (!r || typeof r.registrationId !== 'string') continue;
        surfaceRects.set(r.registrationId, r);
        surfaceApplyRect(r.registrationId, r);
      }
      return {};
    });
/* ===SECTION:KERNELSURFACES:END=== */

/* ===SECTION:LIFECYCLE=== */
    // rev4 §J2: host-driven lifecycle hooks. The bootstrap module owns
    // the plugin definition object; the optional callbacks mirror the
    // J2 lifecycle: suspend/resume (app visibility, host-driven),
    // beforeUpdate/afterUpdate/rollback (package updates) and uninstall.
    // Best-effort by design: a throwing or missing hook never blocks the
    // host state machine (explicit degradation - the plugin is told, not
    // waited on).
    var LIFECYCLE_HOOKS = ['suspend', 'resume', 'beforeUpdate', 'afterUpdate', 'rollback', 'uninstall'];
    K.handle('lifecycle.hook', function (params) {
      var p = params || {};
      var hook = p.hook;
      var callback = null;
      if (typeof hook === 'string' && LIFECYCLE_HOOKS.indexOf(hook) !== -1 && definition) {
        callback = definition[hook];
      }
      if (typeof callback !== 'function') return { handled: false };
      return Promise.resolve()
        .then(function () { return callback(p.detail); })
        .then(function () { return { handled: true }; })
        .catch(function () { return { handled: false }; });
    });
/* ===SECTION:LIFECYCLE:END=== */

/* ===SECTION:OVERLAYS=== */
  var overlayContainers = new Map();
  var overlayPointerHandlers = new Map();
  function overlayContainer(registrationId) {
    var existing = mountContainer(registrationId);
    if (existing) return existing;
    var cached = overlayContainers.get(registrationId);
    if (cached && cached.isConnected) return cached;
    var root = document.getElementById('root');
    if (!root) return null;
    var el = document.createElement('div');
    el.dataset.neotavernRegistration = registrationId;
    el.style.position = 'fixed';
    el.style.left = '0px';
    el.style.top = '0px';
    el.style.width = '0px';
    el.style.height = '0px';
    // Geometry scaffold: never a hit target — the plugin's own content
    // (canvas/DOM) receives pointer events, or the host hit-div forwards
    // packets (proxy), or the iframe is the surface ('full'/'native').
    el.style.pointerEvents = 'none';
    root.append(el);
    overlayContainers.set(registrationId, el);
    return el;
  }
  function disposeOverlayContainer(registrationId) {
    var el = overlayContainers.get(registrationId);
    if (el) el.remove();
    overlayContainers.delete(registrationId);
    overlayPointerHandlers.delete(registrationId);
  }
  api.overlays = {
    register: function (mode, opts) {
      opts = opts || {};
      return K.call('ui.overlay.register', { mode: mode, initialRect: opts.initialRect, hitShapes: opts.hitShapes }).then(function (result) {
        var registrationId = result.registrationId;
        overlayContainer(registrationId);
        return {
          registrationId: registrationId,
          update: function (rect, shapes) {
            return K.call('ui.overlay.update', { registrationId: registrationId, rect: rect, hitShapes: shapes });
          },
          dispose: function () {
            disposeOverlayContainer(registrationId);
            return K.call('ui.overlay.dispose', { registrationId: registrationId }).catch(function () {});
          },
          onPointer: function (cb) {
            overlayPointerHandlers.set(registrationId, cb);
            return function () { overlayPointerHandlers.delete(registrationId); };
          },
        };
      });
    },
  };
  K.handle('ui.overlay.pointer', function (params) {
    var p = params || {};
    var cb = overlayPointerHandlers.get(p.registrationId);
    if (typeof cb === 'function') { try { cb(p.packet); } catch (e) {} }
    return {};
  });
  K.handle('ui.overlay.layout', function (params) {
    var p = params || {};
    var rects = Array.isArray(p.rects) ? p.rects : [];
    for (var i = 0; i < rects.length; i++) {
      var rect = rects[i];
      if (!rect || typeof rect.registrationId !== 'string') continue;
      var el = overlayContainer(rect.registrationId);
      if (!el) continue;
      el.style.left = rect.x + 'px';
      el.style.top = rect.y + 'px';
      el.style.width = rect.width + 'px';
      el.style.height = rect.height + 'px';
    }
    return {};
  });
  K.handle('ui.emergencyClose', function () {
    for (var id of [...overlayContainers.keys()]) disposeOverlayContainer(id);
    return {};
  });
  // rev4 §G7: Escape inside the sandbox is relayed to the host so the
  // host-controlled close of a 'full' overlay works even when focus lives
  // in the plugin document (host window listeners never see iframe keys).
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' || event.keyCode === 27) {
      K.call('ui.overlay.escape', {}).catch(function () {});
    }
  }, true);
/* ===SECTION:OVERLAYS:END=== */

/* ===SECTION:CHATS=== */
  var chatDraftApi = {
    start: function (opts) {
      opts = opts || {};
      var params = {};
      if (opts.chatId !== undefined && opts.chatId !== null) params.chatId = String(opts.chatId);
      return K.call('chat.draft.start', params);
    },
    append: function (draftId, text) {
      return K.call('chat.draft.append', { draftId: String(draftId), text: String(text == null ? '' : text) });
    },
    commit: function (draftId) {
      return K.call('chat.draft.commit', { draftId: String(draftId) });
    },
    abort: function (draftId) {
      return K.call('chat.draft.abort', { draftId: String(draftId) });
    },
  };
  api.chats = {
    current: function () { return K.call('chat.current', {}); },
    listMessages: function (opts) {
      opts = opts || {};
      var params = {};
      if (opts.chatId !== undefined && opts.chatId !== null) params.chatId = String(opts.chatId);
      if (opts.cursor !== undefined && opts.cursor !== null) params.cursor = String(opts.cursor);
      if (typeof opts.limit === 'number') params.limit = opts.limit;
      return K.call('chat.messages.list', params);
    },
    append: function (opts) {
      opts = opts || {};
      var params = { role: 'plugin', content: String(opts.content == null ? '' : opts.content) };
      if (opts.chatId !== undefined && opts.chatId !== null) params.chatId = String(opts.chatId);
      if (opts.idempotencyKey !== undefined && opts.idempotencyKey !== null) {
        params.idempotencyKey = String(opts.idempotencyKey);
      }
      return K.call('chat.messages.append', params);
    },
    draft: chatDraftApi,
  };
/* ===SECTION:CHATS:END=== */

/* ===SECTION:BLOCKS=== */
  var blockRenderers = new Map();
  var blockInstances = new Map();
  function findBlockContainer(blockId) {
    var root = document.getElementById('root');
    if (!root) return null;
    for (var i = 0; i < root.children.length; i++) {
      var child = root.children[i];
      if (child instanceof HTMLElement && child.dataset.neotavernRegistration === blockId) return child;
    }
    return null;
  }
  api.blocks = {
    registerRenderer: function (blockType, def) {
      def = def || {};
      if (typeof blockType !== 'string' || blockType.length === 0 || blockType.length > 100) {
        throw kerr('VALIDATION_FAILED', { field: 'blockType' });
      }
      if (typeof def.mount !== 'function') throw kerr('VALIDATION_FAILED', { field: 'mount' });
      if (blockRenderers.has(blockType)) {
        throw kerr('VALIDATION_FAILED', { reason: 'duplicate-block-type', blockType: blockType });
      }
      var title = def.title == null ? blockType : def.title;
      if (typeof title !== 'string' || title.length === 0 || title.length > 200) {
        throw kerr('VALIDATION_FAILED', { field: 'title' });
      }
      blockRenderers.set(blockType, {
        title: title,
        mount: def.mount,
        serialize: typeof def.serialize === 'function' ? def.serialize : null,
        restore: typeof def.restore === 'function' ? def.restore : null,
      });
      var rendererId = 'blk:' + blockType;
      return K.call('blocks.registerRenderer', { blockType: blockType, title: title }).then(function (result) {
        return {
          rendererId: (result && result.rendererId) || rendererId,
          dispose: function () {
            blockRenderers.delete(blockType);
            return K.call('blocks.unregisterRenderer', { rendererId: rendererId });
          },
        };
      });
    },
    attach: function (messageId, blockType, descriptor) {
      return K.call('blocks.attach', { messageId: messageId, blockType: blockType, descriptor: descriptor });
    },
  };
  K.handle('blocks.mount', function (params) {
    var rendererId = params && params.rendererId;
    var blockId = params && params.blockId;
    if (typeof rendererId !== 'string' || typeof blockId !== 'string') throw kerr('VALIDATION_FAILED');
    var blockType = rendererId.indexOf('blk:') === 0 ? rendererId.slice(4) : rendererId;
    var renderer = blockRenderers.get(blockType);
    if (!renderer) throw kerr('NOT_FOUND', { rendererId: rendererId });
    var existing = blockInstances.get(blockId);
    if (existing) {
      if (typeof existing.cleanup === 'function') { try { existing.cleanup(); } catch (e) {} }
      if (existing.container && existing.container.parentNode) existing.container.parentNode.removeChild(existing.container);
      blockInstances.delete(blockId);
    }
    var container = findBlockContainer(blockId);
    if (!container) {
      var root = document.getElementById('root');
      if (!root) throw kerr('INTERNAL', { reason: 'no-root' });
      container = document.createElement('div');
      container.dataset.neotavernRegistration = blockId;
      root.append(container);
    }
    var mounted = renderer.mount(container, params ? params.descriptor : undefined);
    if (mounted && typeof mounted.then === 'function') {
      return mounted.then(function (fn) {
        blockInstances.set(blockId, { type: blockType, container: container, cleanup: typeof fn === 'function' ? fn : null });
        return {};
      });
    }
    blockInstances.set(blockId, { type: blockType, container: container, cleanup: typeof mounted === 'function' ? mounted : null });
    return {};
  });
  K.handle('blocks.freeze', function (params) {
    var blockId = params && params.blockId;
    var instance = typeof blockId === 'string' ? blockInstances.get(blockId) : undefined;
    if (!instance) return {};
    var renderer = blockRenderers.get(instance.type);
    var state;
    if (renderer && renderer.serialize) {
      try { state = renderer.serialize(instance.container); } catch (e) { state = undefined; }
    }
    if (typeof instance.cleanup === 'function') { try { instance.cleanup(); } catch (e) {} }
    if (instance.container && instance.container.parentNode) instance.container.parentNode.removeChild(instance.container);
    blockInstances.delete(blockId);
    return state === undefined ? {} : { serializedState: state };
  });
  K.handle('blocks.unfreeze', function (params) {
    var blockId = params && params.blockId;
    var state = params && params.state;
    var instance = typeof blockId === 'string' ? blockInstances.get(blockId) : undefined;
    if (!instance) throw kerr('NOT_FOUND', { blockId: blockId });
    var renderer = blockRenderers.get(instance.type);
    if (renderer && renderer.restore) {
      try { renderer.restore(instance.container, state); } catch (e) {}
    }
    return {};
  });
/* ===SECTION:BLOCKS:END=== */

/* ===SECTION:JOBS=== */
var jobsRunCleanup = null;
api.jobs = {
  schedule: function (spec) {
    spec = spec || {};
    var params = { name: spec.name };
    if (spec.runAt != null) params.runAt = spec.runAt;
    if (spec.intervalMs != null) params.intervalMs = spec.intervalMs;
    if (spec.cron != null) params.cron = spec.cron;
    if (spec.payload !== undefined) params.payload = spec.payload;
    if (spec.retries != null) params.retries = spec.retries;
    if (spec.retryDelayMs != null) params.retryDelayMs = spec.retryDelayMs;
    return K.call('jobs.schedule', params).then(function (result) {
      return { jobId: result.jobId };
    });
  },
  cancel: function (jobId) {
    return K.call('jobs.cancel', { jobId: jobId });
  },
  list: function () {
    return K.call('jobs.list', {});
  },
  ack: function (jobId, outcome) {
    outcome = outcome || {};
    var params = { jobId: jobId, ok: !!outcome.ok };
    if (outcome.error !== undefined) params.error = String(outcome.error);
    return K.call('jobs.ack', params);
  },
  retry: function (jobId) {
    return K.call('jobs.retry', { jobId: jobId });
  },
  onRun: function (cb) {
    if (typeof cb !== 'function') throw kerr('VALIDATION_FAILED', { reason: 'callback-required' });
    if (jobsRunCleanup) jobsRunCleanup();
    jobsRunCleanup = K.handle('jobs.run', function (params) {
      return Promise.resolve(cb(params));
    });
    return function () {
      if (jobsRunCleanup) { jobsRunCleanup(); jobsRunCleanup = null; }
    };
  },
};
/* ===SECTION:JOBS:END=== */

/* ===SECTION:NETWORK=== */
api.network = {
  fetch: function (url, opts) {
    opts = opts || {};
    var params = { url: url };
    if (opts.method != null) params.method = opts.method;
    if (opts.headers != null) params.headers = opts.headers;
    if (opts.body != null) params.bodyText = String(opts.body);
    if (opts.authSecretRef != null) params.authSecretRef = opts.authSecretRef;
    if (opts.connectionId != null) params.connectionId = opts.connectionId;
    return K.call('network.fetch', params).then(function (result) {
      return {
        status: result.status,
        headers: result.headers || {},
        bodyText: result.bodyText == null ? '' : String(result.bodyText),
      };
    });
  },
};
/* ===SECTION:NETWORK:END=== */

/* ===SECTION:MODELS=== */
// Provider model discovery (rev4 §2 models). api.models.list(providerId?)
// lists the models of a provider config; an omitted providerId resolves to
// the active provider on the host (the app reports it via the kernel
// models.slice). api.ui.modelMenu mounts a ready-to-use model picker —
// searchable list + load action + status line — that mirrors the host
// ModelMenu component (@neotavern/ui) with the same interaction contract.
api.models = {
  list: function (providerId) {
    if (providerId != null && (typeof providerId !== 'string' || providerId.length > 128)) {
      return Promise.reject(kerr('VALIDATION_FAILED', { field: 'providerId' }));
    }
    var params = {};
    if (providerId != null) params.providerId = providerId;
    return K.call('models.list', params).then(function (res) {
      if (!res || !Array.isArray(res.models)) {
        throw kerr('PROTOCOL_INVALID', { method: 'models.list' });
      }
      return res.models;
    });
  },
};
api.ui.modelMenu = function (container, options) {
  options = options || {};
  if (!container || typeof container.appendChild !== 'function') {
    throw kerr('VALIDATION_FAILED', { field: 'container' });
  }
  var labels = options.labels || {};
  function label(key, fallback) {
    return labels[key] == null ? fallback : String(labels[key]);
  }
  // Host theme tokens (resolved values shipped in the kernel handshake and
  // re-pushed on theme changes). The opaque iframe cannot read host
  // stylesheets, so the widget mirrors the host ModelMenu skin from the
  // snapshot; the built-in palette is only the no-host fallback.
  function themeTokens() {
    var t = globalThis.__neotavernThemeTokens;
    if (!t || typeof t !== 'object') t = K.tokens;
    return t && typeof t === 'object' ? t : null;
  }
  function token(name, fallback) {
    var t = themeTokens();
    var v = t ? t[name] : null;
    return typeof v === 'string' && v.length > 0 ? v : fallback;
  }
  function palette() {
    var t = themeTokens();
    if (t) {
      return {
        surface: token('--st-color-surface-elevated', '#ffffff'),
        surfaceOverlay: token('--st-color-surface-overlay', '#ffffff'),
        border: token('--st-color-border', '#9ca3af'),
        text: token('--st-color-text-primary', '#111827'),
        muted: token('--st-color-text-muted', '#6b7280'),
        highlight: token('--st-color-surface-tertiary', '#f3f4f6'),
        selected: token('--st-color-accent-soft', '#eef4ff'),
        selectedText: token('--st-color-accent-soft-text', '#1e3a8a'),
        accent: token('--st-color-accent', '#2563eb'),
        error: token('--st-color-danger', '#dc2626'),
        radius: token('--st-radius-control', '6px'),
        spaceXs: token('--st-space-xs', '4px'),
        spaceSm: token('--st-space-sm', '8px'),
        spaceMd: token('--st-space-md', '12px'),
        fontSizeSm: token('--st-font-size-sm', '12px'),
        fontSizeMd: token('--st-font-size-md', '14px'),
        fontWeightSemibold: token('--st-font-weight-semibold', '600'),
        controlHeight: token('--st-control-height', '37px'),
        contentMaxHeight: token('--st-size-content-max-height', '240px'),
        shadowFocus: token('--st-shadow-focus', '0 0 0 3px rgba(37, 99, 235, 0.25)'),
        shadowOverlay: token('--st-shadow-overlay', '0 4px 16px rgba(0, 0, 0, 0.25)'),
        layerDropdown: token('--st-layer-dropdown', '1000'),
      };
    }
    var dark =
      typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
    return dark
      ? {
          surface: '#1f2430',
          surfaceOverlay: '#1f2430',
          border: '#4b5563',
          text: '#e5e7eb',
          muted: '#9ca3af',
          highlight: '#3b82f6',
          selected: '#2c3a52',
          selectedText: '#e5e7eb',
          accent: '#3b82f6',
          error: '#f87171',
          radius: '6px',
          spaceXs: '4px',
          spaceSm: '8px',
          spaceMd: '12px',
          fontSizeSm: '12px',
          fontSizeMd: '14px',
          fontWeightSemibold: '600',
          controlHeight: '37px',
          contentMaxHeight: '240px',
          shadowFocus: '0 0 0 3px rgba(59, 130, 246, 0.35)',
          shadowOverlay: '0 4px 16px rgba(0, 0, 0, 0.35)',
          layerDropdown: '1000',
        }
      : {
          surface: '#ffffff',
          surfaceOverlay: '#ffffff',
          border: '#9ca3af',
          text: '#111827',
          muted: '#6b7280',
          highlight: '#2563eb',
          selected: '#eef4ff',
          selectedText: '#1e3a8a',
          accent: '#2563eb',
          error: '#dc2626',
          radius: '6px',
          spaceXs: '4px',
          spaceSm: '8px',
          spaceMd: '12px',
          fontSizeSm: '12px',
          fontSizeMd: '14px',
          fontWeightSemibold: '600',
          controlHeight: '37px',
          contentMaxHeight: '240px',
          shadowFocus: '0 0 0 3px rgba(37, 99, 235, 0.25)',
          shadowOverlay: '0 4px 16px rgba(0, 0, 0, 0.25)',
          layerDropdown: '1000',
        };
  }
  var state = {
    value: options.value == null ? '' : String(options.value),
    models: [],
    loaded: false,
    loading: false,
    open: false,
    query: '',
    active: 0,
    disposed: false,
  };
  var pointerFlag = { active: false };

  var wrapper = document.createElement('div');
  wrapper.dataset.component = 'model-menu';
  wrapper.style.position = 'relative';
  wrapper.style.font = '14px system-ui';
  var row = document.createElement('div');
  row.dataset.part = 'control-row';
  row.style.display = 'flex';
  row.style.alignItems = 'center';
  row.style.gap = '8px';
  var input = document.createElement('input');
  input.type = 'text';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-label', options.ariaLabel || 'Model');
  input.setAttribute('aria-expanded', 'false');
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.style.flex = '1 1 auto';
  input.style.minWidth = '0';
  input.style.font = 'inherit';
  input.value = state.value;
  var loadButton = document.createElement('button');
  loadButton.type = 'button';
  loadButton.textContent = label('load', 'Load models');
  loadButton.style.font = 'inherit';
  loadButton.style.cursor = 'pointer';
  var listbox = document.createElement('div');
  listbox.setAttribute('role', 'listbox');
  listbox.style.display = 'none';
  listbox.style.position = 'absolute';
  listbox.style.top = 'calc(100% + 4px)';
  listbox.style.left = '0';
  listbox.style.right = '0';
  listbox.style.overflowY = 'auto';
  var status = document.createElement('small');
  status.dataset.part = 'status';
  status.style.display = 'block';
  status.style.marginTop = '4px';
  row.appendChild(input);
  row.appendChild(loadButton);
  wrapper.appendChild(row);
  wrapper.appendChild(listbox);
  wrapper.appendChild(status);
  container.appendChild(wrapper);

  // Token-derived skin: applied at creation and re-applied whenever the host
  // pushes a theme change, so plugin UI follows the active theme live.
  function applyTheme() {
    var c = palette();
    wrapper.style.gap = c.spaceXs;
    row.style.gap = c.spaceSm;
    input.style.minHeight = c.controlHeight;
    input.style.padding = c.spaceSm + ' ' + c.spaceMd;
    input.style.border = '1px solid ' + c.border;
    input.style.borderRadius = c.radius;
    input.style.background = c.surface;
    input.style.color = c.text;
    input.style.fontSize = c.fontSizeMd;
    loadButton.style.padding = c.spaceSm + ' ' + c.spaceMd;
    loadButton.style.border = '1px solid ' + c.border;
    loadButton.style.borderRadius = c.radius;
    loadButton.style.background = c.surface;
    loadButton.style.color = c.text;
    loadButton.style.fontSize = c.fontSizeMd;
    listbox.style.maxHeight = 'min(' + c.contentMaxHeight + ', 60vh)';
    listbox.style.border = '1px solid ' + c.border;
    listbox.style.borderRadius = c.radius;
    listbox.style.background = c.surfaceOverlay;
    listbox.style.boxShadow = c.shadowOverlay;
    listbox.style.zIndex = c.layerDropdown;
    status.style.fontSize = c.fontSizeSm;
    status.style.color = c.muted;
    if (input === document.activeElement) applyFocus(true);
  }
  function applyFocus(focused) {
    var c = palette();
    input.style.borderColor = focused ? c.accent : c.border;
    input.style.boxShadow = focused ? c.shadowFocus : 'none';
  }
  applyTheme();

  function setStatus(text, isError) {
    status.textContent = text;
    status.style.color = isError ? palette().error : palette().muted;
    if (isError) status.setAttribute('data-tone', 'error');
    else status.removeAttribute('data-tone');
  }
  // Only the load button is disabled while discovery runs. Disabling the
  // focused input would blur it, which commits and closes the open list
  // (the browser drops focus from a disabled element) — the menu would
  // never survive its first open-with-load.
  function setControls(disabled) {
    loadButton.disabled = disabled;
  }
  function optionLabelFor(model) {
    var text =
      model && typeof model.name === 'string' ? model.name : String(model && model.id != null ? model.id : '');
    if (model && typeof model.contextLimit === 'number' && isFinite(model.contextLimit)) {
      text = text + ' (' + model.contextLimit.toLocaleString() + ')';
    }
    return text;
  }
  function selectedLabel() {
    for (var i = 0; i < state.models.length; i++) {
      if (state.models[i] && state.models[i].id === state.value) {
        return optionLabelFor(state.models[i]);
      }
    }
    return null;
  }
  function filtered() {
    var q = state.query.toLowerCase();
    var out = [];
    for (var i = 0; i < state.models.length; i++) {
      var model = state.models[i];
      if (!model || typeof model.id !== 'string') continue;
      if (q.length === 0) {
        out.push(model);
        continue;
      }
      var hay = (typeof model.name === 'string' ? model.name : '') + ' ' + model.id;
      if (hay.toLowerCase().indexOf(q) !== -1) out.push(model);
    }
    return out;
  }
  function render() {
    if (state.disposed) return;
    input.value = state.open ? state.query : selectedLabel() || state.value;
    input.setAttribute('aria-expanded', state.open ? 'true' : 'false');
    listbox.textContent = '';
    if (!state.open) {
      listbox.style.display = 'none';
      return;
    }
    listbox.style.display = 'block';
    var c = palette();
    var list = filtered();
    if (state.models.length === 0) {
      var emptyEl = document.createElement('div');
      emptyEl.style.padding = c.spaceSm + ' ' + c.spaceMd;
      emptyEl.style.color = c.muted;
      emptyEl.style.fontSize = c.fontSizeSm;
      emptyEl.textContent = label('empty', 'No models loaded yet.');
      listbox.appendChild(emptyEl);
      return;
    }
    if (list.length === 0) {
      var noRes = document.createElement('div');
      noRes.style.padding = c.spaceSm + ' ' + c.spaceMd;
      noRes.style.color = c.muted;
      noRes.style.fontSize = c.fontSizeSm;
      noRes.textContent = label('noResults', 'No matching models.');
      listbox.appendChild(noRes);
      return;
    }
    if (state.active > list.length - 1) state.active = list.length - 1;
    if (state.active < 0) state.active = 0;
    for (var i = 0; i < list.length; i++) {
      var model = list[i];
      var option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', model.id === state.value ? 'true' : 'false');
      option.style.padding = c.spaceSm + ' ' + c.spaceMd;
      option.style.cursor = 'pointer';
      option.style.color = c.text;
      option.style.fontSize = c.fontSizeMd;
      option.style.borderRadius = 'calc(' + c.radius + ' - 4px)';
      option.style.overflowWrap = 'anywhere';
      if (model.id === state.value) {
        option.style.background = c.selected;
        option.style.color = c.selectedText;
        option.style.fontWeight = c.fontWeightSemibold;
      } else if (i === state.active) {
        option.style.background = c.highlight;
      }
      option.textContent = optionLabelFor(model);
      option.addEventListener(
        'mouseenter',
        (function (index) {
          return function () {
            if (state.active === index) return;
            state.active = index;
            render();
          };
        })(i),
      );
      option.addEventListener('mousedown', function (event) {
        event.preventDefault();
        pointerFlag.active = true;
      });
      option.addEventListener(
        'click',
        (function (id) {
          return function () {
            pointerFlag.active = false;
            commit(id);
          };
        })(model.id),
      );
      listbox.appendChild(option);
    }
  }
  function commit(text) {
    state.value = text;
    state.query = text;
    state.open = false;
    render();
    if (typeof options.onValueChange === 'function') options.onValueChange(text);
  }
  function openList() {
    state.query = state.value;
    state.active = 0;
    state.open = true;
    render();
    if (!state.loaded && !state.loading) load();
  }
  function load() {
    if (state.loading || state.disposed) return;
    state.loading = true;
    state.error = null;
    setControls(true);
    setStatus(label('loading', 'Loading…'), false);
    var finished = false;
    function finishLoading() {
      if (finished) return;
      finished = true;
      state.loading = false;
      setControls(false);
    }
    api.models.list(options.providerId).then(
      function (models) {
        finishLoading();
        if (state.disposed) return;
        state.models = Array.isArray(models) ? models : [];
        state.loaded = true;
        if (state.models.length === 0) {
          setStatus(label('empty', 'No models loaded yet.'), false);
        } else {
          setStatus(
            label('loaded', '{n} models loaded.').replace('{n}', String(state.models.length)),
            false,
          );
        }
        render();
      },
      function (err) {
        finishLoading();
        if (state.disposed) return;
        var code = err && err.code ? err.code : 'INTERNAL';
        setStatus(label('error', 'Model discovery unavailable') + ' (' + code + ')', true);
        render();
      },
    );
    // Hard deadline: a dead host session must not leave the widget spinning
    // on an unanswered envelope (K.call here carries no deadline).
    setTimeout(function () {
      if (state.disposed || !state.loading) return;
      finishLoading();
      setStatus(label('error', 'Model discovery unavailable') + ' (OPERATION_DEADLINE)', true);
      render();
    }, 10000);
  }
  function onDocPointerDown(event) {
    if (state.disposed) return;
    var target = event.target;
    if (target && wrapper.contains(target)) return;
    if (state.open) {
      state.open = false;
      render();
    }
  }
  document.addEventListener('pointerdown', onDocPointerDown);

  input.addEventListener('focus', openList);
  input.addEventListener('click', function () {
    if (!state.open) openList();
  });
  input.addEventListener('input', function () {
    state.query = input.value;
    state.active = 0;
    if (!state.open) state.open = true;
    render();
  });
  input.addEventListener('blur', function () {
    if (pointerFlag.active) return;
    var typed = state.query.trim();
    commit(typed.length > 0 ? typed : state.value);
  });
  input.addEventListener('keydown', function (event) {
    if (!state.open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') {
        openList();
        event.preventDefault();
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      state.active = Math.min(state.active + 1, filtered().length - 1);
      render();
      event.preventDefault();
    } else if (event.key === 'ArrowUp') {
      state.active = Math.max(state.active - 1, 0);
      render();
      event.preventDefault();
    } else if (event.key === 'Home') {
      state.active = 0;
      render();
      event.preventDefault();
    } else if (event.key === 'End') {
      state.active = Math.max(filtered().length - 1, 0);
      render();
      event.preventDefault();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      var list = filtered();
      if (list[state.active]) commit(list[state.active].id);
      else commit(state.query);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      state.open = false;
      render();
    }
  });
  loadButton.addEventListener('click', load);
  input.addEventListener('focusin', function () { applyFocus(true); });
  input.addEventListener('focusout', function () { applyFocus(false); });

  function onThemeTokens() {
    applyTheme();
    render();
  }
  document.addEventListener('neotavern-theme-tokens', onThemeTokens);

  function setValue(value) {
    state.value = value == null ? '' : String(value);
    state.query = state.value;
    state.open = false;
    render();
  }
  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    document.removeEventListener('pointerdown', onDocPointerDown);
    document.removeEventListener('neotavern-theme-tokens', onThemeTokens);
    wrapper.remove();
  }
  setStatus(label('loadHint', 'Load models from the provider.'), false);
  return { dispose: dispose, setValue: setValue };
};
/* ===SECTION:MODELS:END=== */

/* ===SECTION:ACTIONS=== */
api.actions = {
  perform: function (action, params) {
    return K.call('actions.perform', {
      action: String(action),
      params: params == null ? {} : params,
    });
  },
};
/* ===SECTION:ACTIONS:END=== */

/* ===SECTION:WORKERS=== */
    // Isolated compute workers (rev4 §C2): the Worker is constructed HERE, in
    // the plugin's opaque-origin sandbox, from a host-verified bundle that
    // (worker-src blob: data:, script-src … blob: data:, connect-src 'none')
    // — compute without data authority (rev4 §0 invariant 3). When the iframe
    // realm dies (disable/uninstall/navigation) the workers die with it; the
    // host keeps its quota ledger honest via the workers.exited /
    // workers.error reports.
    var MAX_WORKER_BUNDLE_BYTES = 2 * 1024 * 1024;
    var MAX_MODULE_BUNDLE_BYTES = 1.5 * 1024 * 1024;
    if (K.limits && K.limits.workers) {
      if (typeof K.limits.workers.maxBundleBytes === 'number') MAX_WORKER_BUNDLE_BYTES = K.limits.workers.maxBundleBytes;
      if (typeof K.limits.workers.maxModuleDataUrlBytes === 'number') MAX_MODULE_BUNDLE_BYTES = K.limits.workers.maxModuleDataUrlBytes;
    }
    var liveWorkers = new Map(); // workerId -> { worker, url, msg, err, close }
    // The worker kind follows the entry extension: .mjs entries become
    // module workers, .js classic. Module workers cannot load blob: entries
    // inside an opaque origin — the entry fetch happens in the worker's own
    // opaque origin, which cannot resolve the iframe-scoped blob URL — so
    // module bundles ride data: URLs (no origin scoping; verified in the
    // 2026-08 dbg-csp probe). Chromium rejects data: scripts above ~2 MiB,
    // hence the tighter module cap; classic entries keep blob:. The earlier
    // "empty bundle" kernel stream race stays fixed by the deferred
    // stream.end in session.ts (ADR-0018).
    function workerFinish(workerId, rec, reportExit) {
      if (!liveWorkers.delete(workerId)) return;
      try { rec.worker.terminate(); } catch (e) {}
      try { URL.revokeObjectURL(rec.url); } catch (e) {}
      rec.close();
      if (reportExit) K.call('workers.exited', { workerId: workerId }).catch(function () {});
    }
    function bytesToBase64(bytes) {
      var bin = '';
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }
    api.workers = {
      spawn: function (options) {
        options = options || {};
        if (typeof options.entry !== 'string' || options.entry.length === 0) {
          return Promise.reject(kerr('VALIDATION_FAILED', { field: 'entry' }));
        }
        var signal = options.signal || null;
        if (signal && signal.aborted) return Promise.reject(kerr('OPERATION_ABORTED'));
        return K.call('workers.spawn', { entry: options.entry }, {}).then(function (res) {
          if (!res || typeof res.streamId !== 'string' || typeof res.workerId !== 'string') {
            throw kerr('PROTOCOL_INVALID', { method: 'workers.spawn' });
          }
          var workerId = res.workerId;
          return K.readInbound(res.streamId).readAll().then(function (bytes) {
            if (bytes.byteLength > MAX_WORKER_BUNDLE_BYTES) {
              throw kerr('PLUGIN_QUOTA_EXCEEDED', { limit: 'workers.maxBundleBytes' });
            }
            var isModule = /\\.mjs$/.test(options.entry);
            if (isModule && bytes.byteLength > MAX_MODULE_BUNDLE_BYTES) {
              throw kerr('PLUGIN_QUOTA_EXCEEDED', { limit: 'workers.maxModuleDataUrlBytes' });
            }
            var url;
            if (isModule) {
              url = 'data:text/javascript;base64,' + bytesToBase64(bytes);
            } else {
              url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
            }
            var worker;
            try {
              worker = /\\.mjs$/.test(options.entry) ? new Worker(url, { type: 'module' }) : new Worker(url);
            } catch (error) {
              try { URL.revokeObjectURL(url); } catch (e) {}
              K.call('workers.error', { workerId: workerId, message: String(error) }).catch(function () {});
              throw kerr('WORKER_SPAWN_FAILED', { entry: options.entry, message: String(error) });
            }
            var msg = new Set();
            var err = new Set();
            var closeFn = null;
            var closed = new Promise(function (resolve) { closeFn = resolve; });
            var rec = { worker: worker, url: url, msg: msg, err: err, close: closeFn };
            liveWorkers.set(workerId, rec);
            worker.onmessage = function (event) {
              var listeners = Array.from(msg);
              for (var i = 0; i < listeners.length; i++) { try { listeners[i](event.data); } catch (e) {} }
            };
            worker.onerror = function (event) {
              var message = String((event && event.message) || 'worker error');
              var listeners = Array.from(err);
              for (var j = 0; j < listeners.length; j++) { try { listeners[j](message); } catch (e) {} }
              workerFinish(workerId, rec, true);
              K.call('workers.error', { workerId: workerId, message: message }).catch(function () {});
            };
            if (signal) signal.addEventListener('abort', function () { workerFinish(workerId, rec, true); }, { once: true });
            return {
              workerId: workerId,
              postMessage: function (message, transfer) {
                if (!liveWorkers.has(workerId)) throw kerr('OPERATION_ABORTED', { workerId: workerId });
                if (transfer) worker.postMessage(message, transfer); else worker.postMessage(message);
              },
              onMessage: function (listener) { msg.add(listener); return function () { msg.delete(listener); }; },
              onError: function (listener) { err.add(listener); return function () { err.delete(listener); }; },
              closed: closed,
              terminate: function () {
                workerFinish(workerId, rec, false);
                return K.call('workers.terminate', { workerId: workerId }).catch(function () {});
              },
            };
          });
        });
      },
    };
    // Host-initiated termination (capability revocation / session teardown).
    K.handle('workers.terminate', function (params) {
      var workerId = params && params.workerId;
      var rec = typeof workerId === 'string' ? liveWorkers.get(workerId) : undefined;
      if (rec) workerFinish(workerId, rec, true);
      return {};
    });
/* ===SECTION:WORKERS:END=== */
  }
  if (globalThis.__neotavernKernelPort) boot();
  else addEventListener('neotavern-kernel-port-ready', boot, { once: true });
})();
`;
}
