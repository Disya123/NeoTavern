/**
 * Rev4 kernel: services.* host handlers for web sandboxes (rev4 §D,
 * cross-plugin RPC).
 *
 * The host owns the registry and every binding. A provider registers service
 * metadata (`services.provide`); consumer calls (`connect`/`invoke`) are
 * routed to the PROVIDER's own session, so handlers execute inside the
 * provider's sandbox realm and never cross as function objects. Consumers and
 * providers are separate capability holders: `services.provide` vs
 * `services.connect` — one plugin can hold both.
 */
import { kernel } from '@neotavern/plugin-sdk';
import type { KernelHostContext } from './types.js';

const { KernelError, KernelErrorCode } = kernel;
type KernelError = InstanceType<typeof KernelError>;

const MAX_SERVICES_PER_PLUGIN = 16;
const MAX_METHODS_PER_SERVICE = 64;
const MAX_CONNECTIONS_PER_CONSUMER = 64;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_SERVICE_TIMEOUT_MS = 10_000;
const MAX_SERVICE_TIMEOUT_MS = 60_000;

/** Service/method name: letters, digits, underscore, dot; starts with a letter. */
const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.]{0,63}$/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failParams(reason: string, extra?: Record<string, unknown>): KernelError {
  return new KernelError(KernelErrorCode.VALIDATION_FAILED, { details: { reason, ...extra } });
}

function denied(ctx: KernelHostContext, capability: string): KernelError {
  return new KernelError(KernelErrorCode.CAPABILITY_DENIED, { details: { capability } });
}

function serviceError(
  serviceId: string,
  method: string,
  providerCode: string,
  message?: string,
): KernelError {
  return new KernelError(KernelErrorCode.SERVICE_ERROR, {
    details: { serviceId, method, providerCode, ...(message ? { message } : {}) },
  });
}

/** Payloads are JSON-safe and bounded; reject functions/cycles/oversize. */
function assertPayload(value: unknown, label: string, method: string): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw failParams('payload-not-json-safe', { field: label, method });
  }
  if (serialized !== undefined && serialized.length > MAX_PAYLOAD_BYTES) {
    throw new KernelError(KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
      details: { limit: `services.${label}`, maxBytes: MAX_PAYLOAD_BYTES, method },
    });
  }
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
  method: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw failParams('invalid-field', { field: key, method });
  }
  return value;
}

export function attachServices(ctx: KernelHostContext): void {
  const { session } = ctx;
  const requireProvide = (): void => {
    if (!ctx.hasCapability('services.provide')) throw denied(ctx, 'services.provide');
  };
  const requireConnect = (): void => {
    if (!ctx.hasCapability('services.connect')) throw denied(ctx, 'services.connect');
  };
  const providerAlive = (serviceId: string): boolean => {
    const entry = ctx.runtime.kernelServiceGet(serviceId);
    if (!entry) return false;
    const frame = ctx.runtime.kernelGetFrame(entry.providerPluginId);
    return Boolean(frame?.session && !frame.session.isDisposed);
  };

  session.handle('services.provide', ({ params }) => {
    requireProvide();
    const method = 'services.provide';
    if (!isPlainRecord(params)) throw failParams('params-not-object', { method });
    const name = params['name'];
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw failParams('invalid-name', { method });
    }
    const rawMethods = params['methods'];
    if (!Array.isArray(rawMethods) || rawMethods.length === 0) {
      throw failParams('methods-required', { method });
    }
    if (rawMethods.length > MAX_METHODS_PER_SERVICE) {
      throw failParams('methods-too-many', { max: MAX_METHODS_PER_SERVICE, method });
    }
    const methods: string[] = [];
    const seen = new Set<string>();
    for (const raw of rawMethods) {
      if (typeof raw !== 'string' || !NAME_RE.test(raw) || seen.has(raw)) {
        throw failParams('invalid-methods', { method });
      }
      seen.add(raw);
      methods.push(raw);
    }
    const version = optionalString(params, 'version', 32, method);
    const description = optionalString(params, 'description', 200, method);
    let timeoutMs = DEFAULT_SERVICE_TIMEOUT_MS;
    if (params['timeoutMs'] !== undefined && params['timeoutMs'] !== null) {
      if (typeof params['timeoutMs'] !== 'number' || !Number.isFinite(params['timeoutMs'])) {
        throw failParams('invalid-field', { field: 'timeoutMs', method });
      }
      timeoutMs = Math.min(Math.max(1000, params['timeoutMs']), MAX_SERVICE_TIMEOUT_MS);
    }
    const providerServices = ctx.runtime
      .kernelServiceList()
      .filter((entry) => entry.providerPluginId === ctx.pluginId).length;
    if (providerServices >= MAX_SERVICES_PER_PLUGIN) {
      throw new KernelError(KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
        details: { limit: 'services.perPlugin', max: MAX_SERVICES_PER_PLUGIN, method },
      });
    }
    const serviceId = `${ctx.pluginId}.${name}`;
    const registered = ctx.runtime.kernelServiceRegister({
      serviceId,
      providerPluginId: ctx.pluginId,
      name,
      methods,
      ...(version === undefined ? {} : { version }),
      ...(description === undefined ? {} : { description }),
      timeoutMs,
    });
    if (!registered) throw failParams('service-already-provided', { serviceId, method });
    return { serviceId };
  });

  session.handle('services.unprovide', ({ params }) => {
    requireProvide();
    const method = 'services.unprovide';
    if (!isPlainRecord(params) || typeof params['serviceId'] !== 'string') {
      throw failParams('serviceId-required', { method });
    }
    ctx.runtime.kernelServiceRemoveService(params['serviceId'], ctx.pluginId);
    return {};
  });

  session.handle('services.list', () => {
    requireConnect();
    return {
      items: ctx.runtime.kernelServiceList().map((entry) => ({
        serviceId: entry.serviceId,
        providerPluginId: entry.providerPluginId,
        name: entry.name,
        methods: [...entry.methods],
        ...(entry.version === undefined ? {} : { version: entry.version }),
        ...(entry.description === undefined ? {} : { description: entry.description }),
      })),
    };
  });

  session.handle('services.connect', ({ params }) => {
    requireConnect();
    const method = 'services.connect';
    if (!isPlainRecord(params) || typeof params['serviceId'] !== 'string') {
      throw failParams('serviceId-required', { method });
    }
    const serviceId = params['serviceId'];
    const entry = ctx.runtime.kernelServiceGet(serviceId);
    if (!entry) {
      throw new KernelError(KernelErrorCode.SERVICE_NOT_FOUND, { details: { serviceId } });
    }
    if (!providerAlive(serviceId)) {
      throw new KernelError(KernelErrorCode.SERVICE_UNAVAILABLE, { details: { serviceId } });
    }
    if (ctx.runtime.kernelServiceConnectionCount(ctx.pluginId) >= MAX_CONNECTIONS_PER_CONSUMER) {
      throw new KernelError(KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
        details: { limit: 'services.perConsumer', max: MAX_CONNECTIONS_PER_CONSUMER, method },
      });
    }
    const connectionId = ctx.runtime.kernelServiceCreateConnection(ctx.pluginId, serviceId);
    if (connectionId === null) {
      throw new KernelError(KernelErrorCode.PLUGIN_QUOTA_EXCEEDED, {
        details: { limit: 'services.hostTotal', method },
      });
    }
    return { connectionId, serviceId, methods: [...entry.methods] };
  });

  session.handle('services.invoke', async (request) => {
    requireConnect();
    const method = 'services.invoke';
    const params = request.params;
    if (!isPlainRecord(params)) throw failParams('params-not-object', { method });
    const connectionId = params['connectionId'];
    const invokeMethod = params['method'];
    if (typeof connectionId !== 'string' || connectionId.length === 0) {
      throw failParams('connectionId-required', { method });
    }
    if (typeof invokeMethod !== 'string' || !NAME_RE.test(invokeMethod)) {
      throw failParams('invalid-method', { method });
    }
    const connection = ctx.runtime.kernelServiceGetConnection(ctx.pluginId, connectionId);
    if (!connection) {
      throw new KernelError(KernelErrorCode.SERVICE_NOT_FOUND, { details: { method } });
    }
    const entry = ctx.runtime.kernelServiceGet(connection.serviceId);
    if (!entry) {
      throw new KernelError(KernelErrorCode.SERVICE_UNAVAILABLE, {
        details: { serviceId: connection.serviceId },
      });
    }
    if (!entry.methods.includes(invokeMethod)) {
      throw new KernelError(KernelErrorCode.SERVICE_METHOD_NOT_FOUND, {
        details: { serviceId: entry.serviceId, method: invokeMethod },
      });
    }
    const providerFrame = ctx.runtime.kernelGetFrame(entry.providerPluginId);
    if (!providerFrame?.session || providerFrame.session.isDisposed) {
      throw new KernelError(KernelErrorCode.SERVICE_UNAVAILABLE, {
        details: { serviceId: entry.serviceId },
      });
    }
    const callParams = params['params'];
    assertPayload(callParams, 'params', method);
    try {
      const result = await providerFrame.session.call(
        'services.invoke',
        {
          serviceId: entry.serviceId,
          method: invokeMethod,
          params: callParams,
          callerPluginId: ctx.pluginId,
        },
        { deadlineMs: entry.timeoutMs, signal: request.signal },
      );
      assertPayload(result, 'result', method);
      return result;
    } catch (error) {
      if (request.signal.aborted) {
        throw new KernelError(KernelErrorCode.OPERATION_ABORTED);
      }
      if (error instanceof KernelError && error.code === KernelErrorCode.OPERATION_DEADLINE) {
        throw new KernelError(KernelErrorCode.SERVICE_TIMEOUT, {
          details: { serviceId: entry.serviceId, method: invokeMethod, timeoutMs: entry.timeoutMs },
        });
      }
      if (error instanceof KernelError && error.code === KernelErrorCode.OPERATION_ABORTED) {
        throw new KernelError(KernelErrorCode.SERVICE_UNAVAILABLE, {
          details: { serviceId: entry.serviceId },
        });
      }
      const providerCode =
        error instanceof KernelError && typeof error.code === 'string'
          ? error.code
          : KernelErrorCode.INTERNAL;
      const message =
        error instanceof Error && typeof error.message === 'string'
          ? error.message.slice(0, 500)
          : undefined;
      throw serviceError(entry.serviceId, invokeMethod, providerCode, message);
    }
  });

  session.handle('services.disconnect', ({ params }) => {
    requireConnect();
    const method = 'services.disconnect';
    if (!isPlainRecord(params) || typeof params['connectionId'] !== 'string') {
      throw failParams('connectionId-required', { method });
    }
    ctx.runtime.kernelServiceRemoveConnection(ctx.pluginId, params['connectionId']);
    return {};
  });
}
