/**
 * Rev4 kernel cross-plugin services (rev4 §D): host-mediated RPC between
 * sandboxed plugins.
 *
 * Security/isolation model (ADR-0017): services are RPC boundaries, not shared
 * memory. The host never forwards function objects — the consumer calls through
 * the kernel port, the host validates the connection, then routes the call to
 * the PROVIDER's own session (`services.invoke`), which dispatches to a handler
 * living entirely in the provider's realm.
 *
 * Service identities are host-prefixed: a plugin provides a short `name` and
 * the host publishes `'<pluginId>.<name>'`, so one plugin cannot squat another
 * plugin's service id. Capabilities: `services.provide` (provider),
 * `services.connect` (consumer; also gates `list()`).
 */

/** Public metadata of a published service (what `list()` returns). */
export interface KernelServiceDescriptor {
  /** Host-prefixed identity: `'<providerPluginId>.<name>'`. */
  serviceId: string;
  providerPluginId: string;
  /** The short name the provider registered. */
  name: string;
  /** Declared method names (the stable public contract of the service). */
  methods: string[];
  version?: string;
  description?: string;
}

/** A consumer's binding to a service; `connectionId` is opaque and short. */
export interface KernelServiceConnection {
  connectionId: string;
  serviceId: string;
  methods: string[];
}

/** The invocation context the provider's handler receives. */
export interface KernelServiceCall {
  /** Plugin id of the caller (for provider-side authorization). */
  callerPluginId: string;
  method: string;
  params: unknown;
  /** Cancels when the consumer aborts or the call deadline fires. */
  signal: AbortSignal;
}

export type KernelServiceHandler = (call: KernelServiceCall) => unknown | Promise<unknown>;

export interface KernelServiceProvideOptions {
  /** Short service name; the host publishes `'<pluginId>.<name>'`. */
  name: string;
  /** Declared methods; calls to undeclared methods fail fast. */
  methods: string[];
  handle: KernelServiceHandler;
  version?: string;
  description?: string;
  /** Per-call deadline override (host caps it); default 10 000 ms. */
  timeoutMs?: number;
}

export interface KernelServiceHandle {
  /** The published full service id. */
  readonly serviceId: string;
  /** Unregister the service; open consumer connections fail afterwards. */
  dispose(): Promise<unknown>;
}

export interface KernelServicesApi {
  /** Publish a service (capability `services.provide`). */
  provide(options: KernelServiceProvideOptions): Promise<KernelServiceHandle>;
  /**
   * List published services (capability `services.connect`). Only metadata is
   * returned; services of disabled/deactivated providers are absent.
   */
  list(): Promise<KernelServiceDescriptor[]>;
  /** Bind to a service; resolves with its method list (capability `services.connect`). */
  connect(serviceId: string): Promise<KernelServiceConnection>;
  /**
   * Invoke a method through the host proxy. The provider's handler runs in its
   * own sandbox; errors surface as `SERVICE_ERROR` (details.providerCode keeps
   * the provider's original code). An `AbortSignal` cancels the call.
   */
  invoke(
    connectionId: string,
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  /** Release the connection. */
  disconnect(connectionId: string): Promise<unknown>;
}

/** Marker for the host feature flag (`api.runtime.supports('services')`). */
export const SERVICES_FEATURE = 'services';
