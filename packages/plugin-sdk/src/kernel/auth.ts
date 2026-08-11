/**
 * Rev4 kernel OAuth connections (contract §2, rev4 §K5): host-managed
 * external-service authentication.
 *
 * Security model (rev4 §K4 heritage): tokens NEVER leave the server. The
 * plugin only ever sees connection metadata — `list/get/connect/revoke` —
 * and uses the connection through `api.network.fetch(url, {connectionId})`,
 * which the host proxies server-side and signs with the stored token.
 * There is no way to resolve the token value inside the sandbox.
 *
 * v1 supports public OAuth clients with PKCE only (no clientSecret — plugin
 * code lives in the sandbox and cannot hold one). OAuth client descriptors
 * are declared statically in the manifest (`authClients`) and change only by
 * reinstalling the plugin.
 */
export interface KernelAuthConnection {
  connectionId: string;
  serviceId: string;
  serviceName: string;
  scopes: string[];
  status: 'pending' | 'connected' | 'expired' | 'revoked';
  createdAt: number;
  updatedAt: number;
}

export interface KernelAuthConnectResult {
  status: 'pending' | 'connected';
  connectionId: string;
  /** Host page that starts the OAuth dance; shown to the user by the host. */
  authorizationUrl: string | null;
}

export interface KernelAuthApi {
  /** All connections of this plugin (metadata only, never tokens). */
  list(): Promise<KernelAuthConnection[]>;
  /** One connection by id; `null` when absent or not owned by the plugin. */
  get(connectionId: string): Promise<KernelAuthConnection | null>;
  /**
   * Start (or reuse) a connection. Already-connected services resolve
   * immediately to `{status:'connected'}`. A new connection lands in
   * `pending` with an `authorizationUrl` the user opens in a browser; the
   * host flips it to `connected` after the OAuth callback and emits
   * `plugin.auth.connected` (subscribe via `api.events.subscribe`).
   */
  connect(serviceId: string, opts?: { scopes?: string[] }): Promise<KernelAuthConnectResult>;
  /** Revoke a connection; the server forgets the token and emits the event. */
  revoke(connectionId: string): Promise<{ ok: true }>;
}
