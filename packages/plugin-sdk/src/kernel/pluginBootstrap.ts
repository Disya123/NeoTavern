/**
 * Plugin SDK revision-4 kernel: plugin-side bootstrap (rev4 §A1).
 *
 * Runs inside the sandboxed iframe: listens for exactly ONE bootstrap
 * message carrying the MessagePort + nonce, ACKs with the plugin handshake,
 * then tears down the global listener. All subsequent SDK traffic goes
 * through the port.
 */
import { KERNEL_SDK_VERSION, PROTOCOL_VERSION, type HostHandshake } from './protocol.js';

export interface PluginBootstrapInfo {
  pluginId: string;
  installationId: string;
  instanceId: string;
  requestedFeatures: string[];
}

export interface PluginBootstrapResult {
  port: MessagePort;
  nonce: string;
  hostHandshake: Promise<HostHandshake>;
}

function isBootstrapMessage(data: unknown): {
  pluginId: string;
  nonce: string;
} | null {
  if (typeof data !== 'object' || data === null) return null;
  if (!('type' in data) || data.type !== 'neotavern.kernel.bootstrap') return null;
  if (!('pluginId' in data) || typeof data.pluginId !== 'string') return null;
  const nonce = 'nonce' in data && typeof data.nonce === 'string' ? data.nonce : '';
  return { pluginId: data.pluginId, nonce };
}

function isHostHandshake(payload: unknown): payload is HostHandshake {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'type' in payload &&
    payload.type === 'neotavern.kernel.host-handshake'
  );
}

/**
 * Wait for the host bootstrap. `window.addEventListener('message', …)` is
 * used exactly once and removed immediately after the port arrives — a
 * replayed or spoofed bootstrap is rejected by the nonce check on the host
 * side, and nothing accepts SDK commands on the global listener afterwards.
 */
export function pluginBootstrap(
  info: PluginBootstrapInfo,
  timeoutMs = 5_000,
): Promise<PluginBootstrapResult> {
  const { promise, resolve, reject } = Promise.withResolvers<PluginBootstrapResult>();
  const timer = setTimeout(() => {
    window.removeEventListener('message', onMessage);
    reject(new Error('PLUGIN_BOOTSTRAP_TIMEOUT'));
  }, timeoutMs);

  const onMessage = (event: MessageEvent): void => {
    const bootstrap = isBootstrapMessage(event.data);
    if (!bootstrap) return;
    if (bootstrap.pluginId !== info.pluginId) return;
    const port = event.ports[0];
    if (!port) return;
    window.removeEventListener('message', onMessage);
    clearTimeout(timer);

    // ACK on the port itself — the host validates the nonce there.
    port.postMessage({
      nonce: bootstrap.nonce,
      protocolVersion: PROTOCOL_VERSION,
      sdkVersion: KERNEL_SDK_VERSION,
      pluginId: info.pluginId,
      installationId: info.installationId,
      instanceId: info.instanceId,
      requestedFeatures: info.requestedFeatures,
    });

    const handshake = Promise.withResolvers<HostHandshake>();
    const handshakeTimeout = setTimeout(() => {
      handshake.reject(new Error('PLUGIN_BOOTSTRAP_TIMEOUT'));
    }, timeoutMs);
    port.addEventListener('message', function awaitHostHandshake(messageEvent: MessageEvent) {
      if (!isHostHandshake(messageEvent.data)) return;
      clearTimeout(handshakeTimeout);
      port.removeEventListener('message', awaitHostHandshake);
      handshake.resolve(messageEvent.data);
    });
    port.start();
    resolve({ port, nonce: bootstrap.nonce, hostHandshake: handshake.promise });
  };

  window.addEventListener('message', onMessage);
  return promise;
}
