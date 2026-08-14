/**
 * §29.1 / ТЗ §SEC-03 network policy helpers shared by the fetch transport
 * (networkPool.ts), the reference executor (memoryHost.ts) and the socket
 * registry (socketHandles.ts).
 *
 * Every IP literal is normalized before classification: the WHATWG URL keeps
 * brackets on IPv6 hosts (`"[::1]"`), and DNS lookup results may come back as
 * dotted-quad or hex IPv4-mapped forms (`"::ffff:127.0.0.1"` /
 * `"::ffff:7f00:1"`). A classifier that misses these forms mislabels loopback
 * and link-local addresses as `public` — a direct SSRF bypass (ТЗ §SEC-03:
 * URLs and addresses are normalized, including bracketed IPv6 and IPv4-mapped
 * IPv6).
 *
 * `assertApprovedRemote` is the post-connect verification (ТЗ §SEC-03: "после
 * connect проверяется remoteAddress"): the address a connection actually
 * landed on must be one of the policy-approved addresses, so a DNS-rebinding /
 * agent-reuse mismatch is rejected even when the pre-connect policy check
 * passed.
 */

/** A request that landed on an address outside the approved set. The executor
 * maps this to `NETWORK_DESTINATION_DENIED` (stable broker error). */
export class VerifiedIpMismatchError extends Error {
  constructor(
    public readonly remoteAddress: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'VerifiedIpMismatchError';
  }
}

/** Strip the brackets WHATWG URL keeps on IPv6 hosts (`"[::1]"` → `"::1"`). */
export function normalizeIpLiteral(ip: string): string {
  return ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
}

/**
 * Dotted-quad form of an IPv4-mapped IPv6 literal, or `null` when the address
 * is not an IPv4-mapped form. Handles both spellings DNS / URL parsers
 * produce: `::ffff:127.0.0.1` and the hex `::ffff:7f00:1`.
 */
export function mappedIpv4(ip: string): string | null {
  const lower = normalizeIpLiteral(ip).toLowerCase();
  if (!lower.startsWith('::ffff:')) return null;
  const tail = lower.slice('::ffff:'.length);
  const dotted = tail.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted !== null) {
    return `${Number(dotted[1])}.${Number(dotted[2])}.${Number(dotted[3])}.${Number(dotted[4])}`;
  }
  const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex === null || hex[1] === undefined || hex[2] === undefined) return null;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** Every spelling a socket's `remoteAddress` may take for the same peer. */
export function remoteAddressVariants(remote: string): string[] {
  const mapped = mappedIpv4(remote);
  return mapped === null ? [remote] : [remote, mapped];
}

/**
 * Post-connect verification: the actually connected address must be one of the
 * policy-approved addresses. Returns a mismatch description, or `null` when
 * the connection landed where the policy said it would.
 */
export function assertApprovedRemote(
  approved: readonly string[],
  remote: string | undefined,
): string | null {
  if (remote === undefined) return 'remote address unavailable after connect';
  if (remoteAddressVariants(remote).some((candidate) => approved.includes(candidate))) return null;
  return `connected address ${remote} is not in the approved set`;
}
