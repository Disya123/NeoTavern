/**
 * Shared worker e2e harness for broker/SDK tests (Stage C/D).
 *
 * Spawns a real Worker through the supervisor with a broker gateway wired to
 * an injected policy, loads a module graph on demand and resolves on the
 * terminal module-graph message (loaded or error).
 */
import { WorkerSupervisor, type WorkerReadyInfo } from '../supervisor.js';
import { buildModuleGraph } from '../graph/moduleGraphBuilder.js';
import { createBrokerGateway, type BrokerGateway } from './brokerGateway.js';
import {
  createCapabilityBrokerCore,
  toBrokerError,
  type BrokerPolicy,
  type CapabilityBrokerCore,
} from './capabilityBroker.js';
import { createHostForwardingCore } from './hostForwardingCore.js';

export interface ModuleGraphLoaded {
  kind: 'module-graph-loaded';
  workerId: number;
  workerEpoch: number;
  exportNames: string[];
  snapshot: Record<string, unknown>;
}

export interface ModuleGraphError {
  kind: 'module-graph-error';
  workerId: number;
  workerEpoch: number;
  code: string;
  message: string;
  stack: string | null;
}

export function isModuleGraphLoaded(value: unknown): value is ModuleGraphLoaded {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as Record<string, unknown>)['kind'] === 'module-graph-loaded'
  );
}

export function isModuleGraphError(value: unknown): value is ModuleGraphError {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as Record<string, unknown>)['kind'] === 'module-graph-error'
  );
}

export interface WithBrokerWorkerContext {
  record: ReturnType<WorkerSupervisor['spawnWorker']>;
  ready: WorkerReadyInfo;
  gateway: BrokerGateway;
  load: () => Promise<ModuleGraphLoaded | ModuleGraphError>;
}

export async function withBrokerWorker(
  files: Record<string, string>,
  policy: BrokerPolicy,
  options: { trustLevel?: 'sandbox' | 'extended' | 'trusted'; workerId?: number } = {},
  run: (context: WithBrokerWorkerContext) => Promise<unknown>,
): Promise<unknown> {
  const built = buildModuleGraph({
    pluginId: 'test.broker',
    entry: 'src/index.js',
    files: new Map(Object.entries(files)),
  });
  const gateway = createBrokerGateway(createCapabilityBrokerCore(policy));

  let resolveReady: (info: WorkerReadyInfo) => void = () => undefined;
  const readyPromise = new Promise<WorkerReadyInfo>((resolveReadyNow) => {
    resolveReady = resolveReadyNow;
  });
  const supervisor = new WorkerSupervisor(
    { onWorkerReady: (info: WorkerReadyInfo) => resolveReady(info) },
    { onBridgeMessage: gateway.handleBridgeMessage },
  );

  const record = supervisor.spawnWorker({
    workerId: options.workerId ?? 21,
    pluginId: 'test.broker',
    installationId: 'inst-broker',
    trustLevel: options.trustLevel,
  });

  const ready = await readyPromise;

  const resultPromise = new Promise<ModuleGraphLoaded | ModuleGraphError>((resolveResult) => {
    record.control.on('message', (message: unknown) => {
      if (isModuleGraphLoaded(message) || isModuleGraphError(message)) {
        resolveResult(message);
      }
    });
  });

  try {
    return await run({
      record,
      ready,
      gateway,
      load: () => {
        record.control.postMessage({ kind: 'load-module-graph', graph: built.graph });
        return resultPromise;
      },
    });
  } finally {
    gateway.shutdown();
    await supervisor.terminateAll();
  }
}

export interface WithForwardingWorkerContext {
  record: ReturnType<WorkerSupervisor['spawnWorker']>;
  ready: WorkerReadyInfo;
  /** Runtime-side gateway (the object runtime-main wires on the supervisor). */
  gateway: BrokerGateway;
  /** Simulated Main Host broker core; the decision authority (part 9b). */
  hostCore: CapabilityBrokerCore;
  load: () => Promise<ModuleGraphLoaded | ModuleGraphError>;
}

/**
 * Worker e2e harness for the host-ward relay path (Stage D part 9b): the
 * worker bridge call travels runtime gateway → forwarding core → simulated
 * Main Host (reference core with the injected policy) and the host's decision
 * travels back as an RPC_RESPONSE, mirroring the real wire shape (§15.2).
 */
export async function withForwardingWorker(
  files: Record<string, string>,
  policy: BrokerPolicy,
  options: { trustLevel?: 'sandbox' | 'extended' | 'trusted'; workerId?: number } = {},
  run: (context: WithForwardingWorkerContext) => Promise<unknown>,
): Promise<unknown> {
  const built = buildModuleGraph({
    pluginId: 'test.broker',
    entry: 'src/index.js',
    files: new Map(Object.entries(files)),
  });
  const hostCore = createCapabilityBrokerCore(policy);
  const forwardingCore = createHostForwardingCore({
    sendRpcRequest: (body) => {
      try {
        hostCore.submit(body.call).promise.then(
          (result) => {
            forwardingCore.handleRpcResponse({
              workerId: body.workerId,
              workerEpoch: body.workerEpoch,
              requestId: body.call.requestId,
              ok: true,
              result,
            });
          },
          (error) => {
            forwardingCore.handleRpcResponse({
              workerId: body.workerId,
              workerEpoch: body.workerEpoch,
              requestId: body.call.requestId,
              ok: false,
              error: toBrokerError(error),
            });
          },
        );
      } catch (error) {
        forwardingCore.handleRpcResponse({
          workerId: body.workerId,
          workerEpoch: body.workerEpoch,
          requestId: body.call.requestId,
          ok: false,
          error: toBrokerError(error),
        });
      }
    },
  });
  const gateway = createBrokerGateway(forwardingCore);

  let resolveReady: (info: WorkerReadyInfo) => void = () => undefined;
  const readyPromise = new Promise<WorkerReadyInfo>((resolveReadyNow) => {
    resolveReady = resolveReadyNow;
  });
  const supervisor = new WorkerSupervisor(
    { onWorkerReady: (info: WorkerReadyInfo) => resolveReady(info) },
    { onBridgeMessage: gateway.handleBridgeMessage },
  );

  const record = supervisor.spawnWorker({
    workerId: options.workerId ?? 21,
    pluginId: 'test.broker',
    installationId: 'inst-broker',
    trustLevel: options.trustLevel,
  });

  const ready = await readyPromise;

  const resultPromise = new Promise<ModuleGraphLoaded | ModuleGraphError>((resolveResult) => {
    record.control.on('message', (message: unknown) => {
      if (isModuleGraphLoaded(message) || isModuleGraphError(message)) {
        resolveResult(message);
      }
    });
  });

  try {
    return await run({
      record,
      ready,
      gateway,
      hostCore,
      load: () => {
        record.control.postMessage({ kind: 'load-module-graph', graph: built.graph });
        return resultPromise;
      },
    });
  } finally {
    gateway.shutdown();
    forwardingCore.shutdown();
    await supervisor.terminateAll();
  }
}
