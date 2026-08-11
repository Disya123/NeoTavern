/**
 * SHA-256 helper shared by the module-graph builder and loader.
 * Digests cover the UTF-8 module source (§6.2 "digest", §8.1 canonical
 * package is source).
 */
import { createHash } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
