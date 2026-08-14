/**
 * Unit tests for the §29.1 / ТЗ §SEC-03 network policy helpers
 * (netPolicy.ts): IP literal normalization (bracketed IPv6, IPv4-mapped
 * dotted/hex forms) and the post-connect remoteAddress verification.
 */
import { describe, expect, it } from 'vitest';
import {
  assertApprovedRemote,
  mappedIpv4,
  normalizeIpLiteral,
  remoteAddressVariants,
  VerifiedIpMismatchError,
} from './netPolicy.js';

describe('normalizeIpLiteral', () => {
  it('strips the brackets WHATWG URL keeps on IPv6 hosts', () => {
    expect(normalizeIpLiteral('[::1]')).toBe('::1');
    expect(normalizeIpLiteral('[::ffff:7f00:1]')).toBe('::ffff:7f00:1');
    expect(normalizeIpLiteral('[2001:db8::1]')).toBe('2001:db8::1');
  });

  it('leaves bare IPv4 and bare IPv6 untouched', () => {
    expect(normalizeIpLiteral('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIpLiteral('::1')).toBe('::1');
    expect(normalizeIpLiteral('10.0.0.5')).toBe('10.0.0.5');
  });
});

describe('mappedIpv4', () => {
  it('decodes the dotted-quad mapped form', () => {
    expect(mappedIpv4('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(mappedIpv4('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(mappedIpv4('[::ffff:192.168.1.1]')).toBe('192.168.1.1');
  });

  it('decodes the hex mapped form (what URL parsing produces)', () => {
    expect(mappedIpv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(mappedIpv4('::ffff:a00:1')).toBe('10.0.0.1');
    expect(mappedIpv4('[::ffff:7f00:1]')).toBe('127.0.0.1');
    expect(mappedIpv4('::ffff:c0a8:0101')).toBe('192.168.1.1');
  });

  it('returns null for non-mapped addresses', () => {
    expect(mappedIpv4('::1')).toBeNull();
    expect(mappedIpv4('127.0.0.1')).toBeNull();
    expect(mappedIpv4('fe80::1')).toBeNull();
    expect(mappedIpv4('fc00::1')).toBeNull();
    expect(mappedIpv4('2001:db8::1')).toBeNull();
    expect(mappedIpv4('::ffff:zzz:1')).toBeNull();
  });
});

describe('remoteAddressVariants', () => {
  it('lists both spellings for a mapped remote address', () => {
    expect(remoteAddressVariants('::ffff:127.0.0.1')).toEqual(['::ffff:127.0.0.1', '127.0.0.1']);
    expect(remoteAddressVariants('::ffff:7f00:1')).toEqual(['::ffff:7f00:1', '127.0.0.1']);
  });

  it('lists a single variant for plain addresses', () => {
    expect(remoteAddressVariants('127.0.0.1')).toEqual(['127.0.0.1']);
    expect(remoteAddressVariants('::1')).toEqual(['::1']);
  });
});

describe('assertApprovedRemote', () => {
  it('accepts a remote address inside the approved set', () => {
    expect(assertApprovedRemote(['127.0.0.1'], '127.0.0.1')).toBeNull();
    expect(assertApprovedRemote(['::1'], '::1')).toBeNull();
  });

  it('accepts a mapped spelling of an approved IPv4', () => {
    expect(assertApprovedRemote(['127.0.0.1'], '::ffff:127.0.0.1')).toBeNull();
    expect(assertApprovedRemote(['127.0.0.1'], '::ffff:7f00:1')).toBeNull();
  });

  it('rejects an address outside the approved set', () => {
    expect(assertApprovedRemote(['127.0.0.1'], '10.0.0.1')).toContain('10.0.0.1');
    expect(assertApprovedRemote(['93.184.216.34'], '::1')).toContain('::1');
  });

  it('rejects an unavailable remote address', () => {
    expect(assertApprovedRemote(['127.0.0.1'], undefined)).toContain('unavailable');
  });

  it('carries the mismatched address on the marker error', () => {
    const error = new VerifiedIpMismatchError(
      '10.0.0.1',
      'connected address 10.0.0.1 is not in the approved set',
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('VerifiedIpMismatchError');
    expect(error.remoteAddress).toBe('10.0.0.1');
  });
});
