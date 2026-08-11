/**
 * vNext Main Host broker host (ADR-0027 §3, ТЗ Plugin SDK vNext v3.2 §10,
 * §15.2; Stage D part 9c).
 *
 * The decision authority in Main Host, wired end to end: host-ward
 * `RPC_REQUEST` frames from the Plugin Runtime (part 9b relay) become
 * submissions to `createCapabilityBrokerCore(createVNextBrokerPolicy(ctx))`,
 * and the core's settlement travels back as an `RPC_RESPONSE` frame.
 * Revocation is host-driven: `revoke` aborts host-side in-flight calls and
 * notifies the runtime with a `BROKER_REVOKE` frame so worker-side pending
 * promises fail fast with CAPABILITY_REVOKED.
 *
 * The transport is injectable (`VNextBrokerTransport`); production binds a
 * `PluginRuntimeClient` via `createPluginRuntimeTransport` /
 * `attachVNextBrokerHost`. Runtime spawn and worker lifecycle land in Stage A;
 * this module is the broker side that Stage A plugs the client into.
 */
import type {
  BrokerCallRequest,
  PluginRuntimeBridgeMessageBody,
  PluginRuntimeBrokerRevokeBody,
  PluginRuntimeRpcRequestBody,
  PluginRuntimeRpcResponseBody,
  SdkEventEnvelope,
  SdkJobRunEnvelope,
  SdkServiceCallEnvelope,
} from '@neotavern/contracts';
import { SdkOperationMethod } from '@neotavern/contracts';
import {
  assertBrokerCallShape,
  BrokerCallError,
  createCapabilityBrokerCore,
  toBrokerError,
  type BrokerPolicy,
  type SecretsProvider,
} from '@neotavern/plugin-runtime';
import {
  createVNextBrokerPolicy,
  type VNextBrokerHost,
  type VNextBrokerOptions,
} from './vnextBroker.js';

/** Host-ward frame sink: the Runtime transport (production: PluginRuntimeClient). */
export interface VNextBrokerTransport {
  sendRpcResponse(body: PluginRuntimeRpcResponseBody): void;
  sendBrokerRevoke(body: PluginRuntimeBrokerRevokeBody): void;
  /** Push an app-level bridge message to a worker (Stage F live delivery). */
  sendHostBridgeMessage(body: PluginRuntimeBridgeMessageBody): void;
}

/** Structural guard for the decoded RPC_REQUEST frame body (trust boundary). */
function isRpcRequestBody(value: unknown): value is PluginRuntimeRpcRequestBody {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['workerId'] === 'number' &&
    typeof record['workerEpoch'] === 'number' &&
    typeof record['call'] === 'object' &&
    record['call'] !== null
  );
}

/**
 * §33 Secrets API: Main Host-side provider backed by the OAuth connections
 * repo (`authConnections.ts`). The token value never leaves this module —
 * `use` returns the bound origin plus the resolved Authorization header,
 * `reveal` returns the raw token only under the trusted-only grant (the
 * executor gates the trust level before this is reachable). The bound
 * origin comes from the plugin manifest's declared `authClients`
 * authorization endpoint, or from an injected resolver (tests).
 */
function createHostSecretsProvider(
  ctx: VNextBrokerHost,
  originResolver: ((pluginId: string, serviceId: string) => string | null) | undefined,
): SecretsProvider {
  const connections = ctx.database.repos.authConnections;
  const originOf =
    originResolver ??
    ((pluginId: string, serviceId: string): string | null => {
      const plugin = ctx.database.repos.plugins.getById(pluginId);
      const manifest = plugin?.manifest as
        { authClients?: Array<{ serviceId: string; authorizationUrl: string }> } | undefined;
      const client = manifest?.authClients?.find((item) => item.serviceId === serviceId);
      if (client === undefined) return null;
      try {
        return new URL(client.authorizationUrl).origin;
      } catch {
        return null;
      }
    });
  const tokenPayload = (entry: {
    token: unknown;
  }): {
    accessToken: string;
    tokenType?: string;
    expiresAt?: number | null;
  } => {
    const payload = entry.token as Record<string, unknown>;
    if (typeof payload['accessToken'] !== 'string' || payload['accessToken'].length === 0) {
      throw new BrokerCallError('AUTH_TOKEN_INVALID', { message: 'stored token is invalid' });
    }
    return {
      accessToken: payload['accessToken'],
      tokenType:
        typeof payload['tokenType'] === 'string' && payload['tokenType'].length > 0
          ? payload['tokenType']
          : undefined,
      expiresAt: typeof payload['expiresAt'] === 'number' ? payload['expiresAt'] : null,
    };
  };
  const entryOf = (pluginId: string, connectionId: string) => {
    const entry = connections.getById(pluginId, connectionId);
    if (entry === null || entry === undefined) {
      throw new BrokerCallError('AUTH_CONNECTION_NOT_FOUND', {
        message: 'unknown connection',
        details: { connectionId },
      });
    }
    return entry;
  };
  return {
    async use(pluginId, connectionId) {
      const entry = entryOf(pluginId, connectionId);
      if (entry.status === 'revoked') {
        throw new BrokerCallError('AUTH_REVOKED', { message: 'connection is revoked' });
      }
      if (entry.status !== 'connected' || entry.token === null) {
        throw new BrokerCallError('AUTH_NOT_CONNECTED', {
          message: 'connection is not connected',
        });
      }
      const payload = tokenPayload(entry);
      if (typeof payload.expiresAt === 'number' && payload.expiresAt <= Date.now()) {
        connections.markExpired(entry.id, Date.now());
        throw new BrokerCallError('AUTH_EXPIRED', { message: 'token expired' });
      }
      const origin = originOf(pluginId, entry.serviceId);
      if (origin === null) {
        throw new BrokerCallError('AUTH_ORIGIN_UNKNOWN', {
          message: 'no bound origin for the service',
          details: { serviceId: entry.serviceId },
        });
      }
      return {
        serviceId: entry.serviceId,
        origin,
        headers: { Authorization: `${payload.tokenType ?? 'Bearer'} ${payload.accessToken}` },
        expiresAt: payload.expiresAt,
      };
    },
    async manageOwn(pluginId) {
      return connections.list(pluginId).map((entry) => ({
        connectionId: entry.id,
        serviceId: entry.serviceId,
        serviceName: entry.serviceName,
        scopes: entry.scopes,
        status: entry.status,
      }));
    },
    async reveal(pluginId, connectionId) {
      const entry = entryOf(pluginId, connectionId);
      if (entry.status !== 'connected' || entry.token === null) {
        throw new BrokerCallError('AUTH_NOT_CONNECTED', {
          message: 'connection is not connected',
        });
      }
      const payload = tokenPayload(entry);
      return {
        accessToken: payload.accessToken,
        ...(payload.tokenType === undefined ? {} : { tokenType: payload.tokenType }),
        ...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt }),
      };
    },
  };
}

export interface VNextBrokerHostOptions extends VNextBrokerOptions {
  /** Cap on concurrent host-side decisions; excess fails with
   * SERVICE_UNAVAILABLE (defense in depth — the runtime caps its own relay). */
  maxInflight?: number;
  /**
   * §33 Secrets API: host-side provider. Defaults to the OAuth-repo-backed
   * provider (createHostSecretsProvider) — tests inject a stub.
   */
  secretsProvider?: SecretsProvider;
  /**
   * §33: bound-origin resolver (serviceId → origin). Defaults to reading
   * the plugin manifest's declared `authClients` authorization URL.
   */
  secretOriginResolver?: (pluginId: string, serviceId: string) => string | null;
}

export interface VNextBrokerHostService {
  /** The policy in use (diagnostics, tests). */
  readonly policy: BrokerPolicy;
  /** Handle one host-ward RPC_REQUEST frame; replies over the transport. */
  handleRpcRequest(body: unknown): void;
  /**
   * Host-initiated revocation: abort matching host-side in-flight calls and
   * tell the runtime to do the same worker-side. Returns the aborted count.
   */
  revoke(pluginId: string, name?: string, reason?: string): number;
  /** True when the plugin/capability pair is revoked. */
  isRevoked(pluginId: string, name: string): boolean;
  /** In-flight host-side decision count (diagnostics, §40). */
  pendingCount(): number;
  /** Emit an event into the §18 core; live subscriptions are pushed. */
  emitEvent(name: string, payload: unknown): SdkEventEnvelope;
  /** Prune subscriptions that belonged to a terminated worker. */
  workerTerminated(workerId: number): void;
  /** Abort every in-flight decision (runtime shutdown). */
  shutdown(): void;
}

const DEFAULT_MAX_INFLIGHT = 1024;

/** Transport adapter over a PluginRuntimeClient (structural; tests can fake it). */
export function createPluginRuntimeTransport(client: {
  sendRpcResponse(body: PluginRuntimeRpcResponseBody): void;
  sendBrokerRevoke(body: PluginRuntimeBrokerRevokeBody): void;
  sendHostBridgeMessage(body: PluginRuntimeBridgeMessageBody): void;
}): VNextBrokerTransport {
  return {
    sendRpcResponse: (body) => client.sendRpcResponse(body),
    sendBrokerRevoke: (body) => client.sendBrokerRevoke(body),
    sendHostBridgeMessage: (body) => client.sendHostBridgeMessage(body),
  };
}

/** Subscribe a client's `rpcRequest` events to the broker host; returns detach. */
export function attachVNextBrokerHost(
  client: {
    on(event: 'rpcRequest', listener: (body: unknown) => void): unknown;
    off(event: 'rpcRequest', listener: (body: unknown) => void): unknown;
  },
  host: VNextBrokerHostService,
): () => void {
  const listener = (body: unknown): void => host.handleRpcRequest(body);
  client.on('rpcRequest', listener);
  return () => {
    client.off('rpcRequest', listener);
  };
}

export function createVNextBrokerHost(
  ctx: VNextBrokerHost,
  transport: VNextBrokerTransport,
  options: VNextBrokerHostOptions = {},
): VNextBrokerHostService {
  const maxInflight = options.maxInflight ?? DEFAULT_MAX_INFLIGHT;
  // §18 live delivery: subscription id → owning worker. The executor decides
  // admission; this map is the routing table for the push sink.
  const subscriptions = new Map<string, { workerId: number; workerEpoch: number }>();
  const eventPushSink = (subscriptionId: string, envelope: SdkEventEnvelope): boolean => {
    const ref = subscriptions.get(subscriptionId);
    if (ref === undefined) return false;
    try {
      transport.sendHostBridgeMessage({
        workerId: ref.workerId,
        workerEpoch: ref.workerEpoch,
        message: { kind: 'event-push', subscriptionId, envelope },
      });
      return true;
    } catch {
      // Transport went away (runtime shut down mid-flight): drop the
      // subscription so the executor stops pushing to a dead worker.
      return false;
    }
  };
  // §19/§27 Jobs API + §34 Services API (Stage E): pluginId → owning
  // worker for job-run / service-call pushes. Registered when a worker's
  // `jobs.register` / `services.provide` RPC succeeds; pruned when the
  // worker terminates so stale pushes never reach a dead worker.
  const workerByPlugin = new Map<string, { workerId: number; workerEpoch: number }>();
  const jobPushSink = (pluginId: string, envelope: SdkJobRunEnvelope): boolean => {
    const ref = workerByPlugin.get(pluginId);
    if (ref === undefined) return false;
    try {
      transport.sendHostBridgeMessage({
        workerId: ref.workerId,
        workerEpoch: ref.workerEpoch,
        message: { kind: 'job-run', envelope },
      });
      return true;
    } catch {
      return false;
    }
  };
  const serviceCallSink = (pluginId: string, envelope: SdkServiceCallEnvelope): boolean => {
    const ref = workerByPlugin.get(pluginId);
    if (ref === undefined) return false;
    try {
      transport.sendHostBridgeMessage({
        workerId: ref.workerId,
        workerEpoch: ref.workerEpoch,
        message: { kind: 'service-call', envelope },
      });
      return true;
    } catch {
      return false;
    }
  };
  const policy = createVNextBrokerPolicy(ctx, {
    ...options,
    eventPushSink,
    jobPushSink,
    serviceCallSink,
    secretsProvider:
      options.secretsProvider ?? createHostSecretsProvider(ctx, options.secretOriginResolver),
  });
  const core = createCapabilityBrokerCore(policy);

  function respond(
    workerId: number,
    workerEpoch: number,
    requestId: string,
    ok: boolean,
    resultOrError?: unknown,
  ): void {
    if (ok) {
      transport.sendRpcResponse({ workerId, workerEpoch, requestId, ok, result: resultOrError });
    } else {
      transport.sendRpcResponse({
        workerId,
        workerEpoch,
        requestId,
        ok,
        error: toBrokerError(resultOrError),
      });
    }
  }

  function rejectAdmission(
    workerId: number,
    workerEpoch: number,
    requestId: string,
    code: string,
    message: string,
  ): void {
    respond(workerId, workerEpoch, requestId, false, new BrokerCallError(code, { message }));
  }

  function handleRpcRequest(value: unknown): void {
    if (!isRpcRequestBody(value)) {
      // Malformed frame body: answer with an unmatchable requestId — the
      // runtime's forwarding core drops responses for unknown requestIds, so
      // this can never poison another call.
      transport.sendRpcResponse({
        workerId: 0,
        workerEpoch: 0,
        requestId: 'malformed-frame',
        ok: false,
        error: toBrokerError(
          new BrokerCallError('VALIDATION_FAILED', { message: 'malformed RPC_REQUEST frame body' }),
        ),
      });
      return;
    }
    const { workerId, workerEpoch } = value;
    const call = value.call;
    if (!assertBrokerCallShape(call)) {
      rejectAdmission(
        workerId,
        workerEpoch,
        'malformed-call',
        'VALIDATION_FAILED',
        'malformed broker call envelope',
      );
      return;
    }
    if (core.pendingCount() >= maxInflight) {
      rejectAdmission(
        workerId,
        workerEpoch,
        call.requestId,
        'SERVICE_UNAVAILABLE',
        'broker decision capacity reached',
      );
      return;
    }
    let handle;
    try {
      handle = core.submit(call as BrokerCallRequest, { workerId, workerEpoch });
    } catch (error) {
      respond(workerId, workerEpoch, call.requestId, false, error);
      return;
    }
    handle.promise.then(
      (result) => {
        // §18 live delivery bookkeeping: remember the owning worker for
        // subscriptions and forget it on unsubscribe, so the push sink can
        // route `event-push` messages and self-clean when a worker dies.
        if (call.method === SdkOperationMethod.EVENTS_SUBSCRIBE) {
          const id =
            result !== null && typeof result === 'object'
              ? (result as Record<string, unknown>)['subscriptionId']
              : undefined;
          if (typeof id === 'string' && id.length >= 8 && id.length <= 64) {
            subscriptions.set(id, { workerId, workerEpoch });
          }
        } else if (call.method === SdkOperationMethod.EVENTS_UNSUBSCRIBE) {
          const args = call.args as Record<string, unknown> | undefined;
          const id = args?.['subscriptionId'];
          if (typeof id === 'string') subscriptions.delete(id);
        } else if (call.method === SdkOperationMethod.JOBS_REGISTER) {
          // §19: remember the owning worker so job-run pushes reach it.
          workerByPlugin.set(call.caller.pluginId, { workerId, workerEpoch });
        } else if (call.method === SdkOperationMethod.SERVICES_PROVIDE) {
          // §34: remember the owning worker so service-call pushes reach it.
          workerByPlugin.set(call.caller.pluginId, { workerId, workerEpoch });
        }
        respond(workerId, workerEpoch, call.requestId, true, result);
      },
      (error) => respond(workerId, workerEpoch, call.requestId, false, error),
    );
  }

  return {
    policy,
    handleRpcRequest,
    revoke(pluginId, name, reason) {
      const aborted = core.revoke(pluginId, name, reason);
      transport.sendBrokerRevoke({ pluginId, name, reason });
      return aborted;
    },
    isRevoked(pluginId, name) {
      return core.isRevoked(pluginId, name);
    },
    pendingCount() {
      return core.pendingCount();
    },
    emitEvent(name, payload) {
      return policy.emit(name, payload);
    },
    workerTerminated(workerId) {
      for (const [id, ref] of subscriptions) {
        if (ref.workerId === workerId) subscriptions.delete(id);
      }
      for (const [pluginId, ref] of workerByPlugin) {
        if (ref.workerId === workerId) workerByPlugin.delete(pluginId);
      }
    },
    shutdown() {
      core.shutdown();
      policy.close();
      subscriptions.clear();
      workerByPlugin.clear();
    },
  };
}
