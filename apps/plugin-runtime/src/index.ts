/**
 * @neotavern/plugin-runtime — Plugin Runtime process infrastructure (ТЗ Plugin SDK
 * vNext v3.2, Stage A prototype).
 *
 * Public surface for host and test consumers: the Worker supervisor and the
 * host-side `PluginRuntimeClient`. The wire protocol itself lives in
 * `@neotavern/contracts` (pluginRuntime.ts) and is the single source of truth.
 */
export {
  WorkerSupervisor,
  type SpawnWorkerOptions,
  type SupervisorListener,
  type SupervisorStats,
  type WorkerExitInfo,
  type WorkerLogEntry,
  type WorkerReadyInfo,
  type WorkerRecord,
} from './supervisor.js';
export {
  PluginRuntimeClient,
  type PluginRuntimeClientEventName,
  type PluginRuntimeClientEvents,
  type PluginRuntimeClientOptions,
  type PluginRuntimeWorkerTarget,
} from './host/runtimeClient.js';
export { parseRuntimeEnv, minimalWorkerEnv, type PluginRuntimeSpawnEnv } from './env.js';
export {
  buildModuleGraph,
  type BuildModuleGraphOptions,
  type ModuleGraphBuildResult,
  type PluginPackageSource,
} from './graph/moduleGraphBuilder.js';
export {
  loadModuleGraph,
  moduleDescriptorFor,
  prepareModuleGraph,
  resolveGraphSpecifier,
  type LoadModuleGraphOptions,
  type LoadModuleGraphResult,
  type PreparedModuleGraph,
} from './graph/moduleGraphLoader.js';
export { sha256Hex } from './graph/digest.js';
export {
  ModuleMapDiskCache,
  moduleMapCacheKey,
  packageSourceDigest,
  resolveModuleMapVersions,
  type ModuleMapCacheVersions,
  type StoredModuleMap,
} from './graph/moduleMapCache.js';
export {
  createCapabilityBrokerCore,
  assertBrokerCallShape,
  toBrokerError,
  BrokerCallError,
  BrokerErrorCode,
  type BrokerCallHandle,
  type BrokerDecision,
  type BrokerErrorCodeValue,
  type BrokerPolicy,
  type BrokerWorkerRef,
  type CapabilityBrokerCore,
} from './broker/capabilityBroker.js';
export { createBrokerGateway, type BrokerGateway } from './broker/brokerGateway.js';
export {
  createHostForwardingCore,
  type HostForwardingCore,
  type HostForwardingOptions,
} from './broker/hostForwardingCore.js';
export {
  createMemoryHostExecutor,
  type MemoryHostExecutor,
  type MemoryHostOptions,
  type NetworkSecret,
  type SecretsProvider,
} from './host/memoryHost.js';
export {
  createNetworkPool,
  type NetworkPool,
  type NetworkPoolMetrics,
  type NetworkPoolOptions,
} from './host/networkPool.js';
