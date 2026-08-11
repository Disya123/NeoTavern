/**
 * Plugin SDK revision-4 kernel: host-side bootstrap handshake (rev4 §A1).
 *
 * The host creates a MessageChannel, posts `port2` plus a one-time nonce to
 * the plugin frame's contentWindow, and waits for the plugin's handshake ACK
 * on `port1`. After the ACK the global `message` listener must never accept
 * SDK traffic again — everything rides the port.
 *
 * This module is DOM-agnostic: the caller supplies `postBootstrap`, so the
 * same code serves the browser host and unit tests.
 */
import { KernelError, KernelErrorCode } from './errors.js';
import {
  PROTOCOL_VERSION,
  validatePluginHandshake,
  type HostHandshake,
  type PluginHandshake,
} from './protocol.js';

export interface BootstrapOptions {
  pluginId: string;
  /** Host version reported to the plugin (rev4 §A1). */
  hostVersion: string;
  /** Handshake timeout; defaults to 5 s. */
  timeoutMs?: number;
  /** Random token generator; injectable for tests. */
  randomToken?: (length: number) => string;
  clock?: () => number;
}

export interface BootstrapResult {
  session: {
    port: MessagePort;
    nonce: string;
    handshake: PluginHandshake;
  };
}

/**
 * Perform the host half of the handshake.
 *
 * `postBootstrap(message, ports)` must deliver the bootstrap message to the
 * plugin frame (usually `iframe.contentWindow.postMessage(msg, '*', ports)`);
 * returning it lets tests intercept the wire. The returned promise rejects
 * with HANDSHAKE_REJECTED on nonce mismatch, timeout or malformed handshake.
 */
export async function hostBootstrap(
  postBootstrap: (message: Record<string, unknown>, transfer: MessagePort[]) => void,
  buildHostHandshake: (plugin: PluginHandshake) => HostHandshake,
  options: BootstrapOptions,
): Promise<BootstrapResult['session']> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const randomToken = options.randomToken ?? defaultRandomToken;
  const channel = new MessageChannel();
  const nonce = randomToken(24);

  const handshakePromise = new Promise<PluginHandshake>((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(
        new KernelError(KernelErrorCode.HANDSHAKE_REJECTED, { details: { reason: 'timeout' } }),
      );
    }, timeoutMs);
    channel.port1.onmessage = (event: MessageEvent) => {
      try {
        const handshake = validatePluginHandshake(event.data, nonce);
        clearTimeout(timer);
        channel.port1.onmessage = null;
        resolve(handshake);
      } catch (error) {
        clearTimeout(timer);
        channel.port1.close();
        reject(error);
      }
    };
  });

  postBootstrap(
    {
      type: 'neotavern.kernel.bootstrap',
      pluginId: options.pluginId,
      nonce,
      protocolVersion: PROTOCOL_VERSION,
    },
    [channel.port2],
  );

  const handshake = await handshakePromise;
  if (handshake.protocolVersion.split('.')[0] !== PROTOCOL_VERSION.split('.')[0]) {
    channel.port1.close();
    throw new KernelError(KernelErrorCode.HANDSHAKE_REJECTED, {
      details: { reason: 'protocol-major-mismatch', protocol: handshake.protocolVersion },
    });
  }
  // Deliver the host's side of the negotiation on the established port.
  channel.port1.postMessage({
    type: 'neotavern.kernel.host-handshake',
    ...buildHostHandshake(handshake),
  });
  return { port: channel.port1, nonce, handshake };
}

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function defaultRandomToken(length: number): string {
  const bytes = new Uint8Array(length);
  // globalThis.crypto exists in browsers and Node 24.
  globalThis.crypto.getRandomValues(bytes);
  let token = '';
  for (const byte of bytes) token += TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length];
  return token;
}
