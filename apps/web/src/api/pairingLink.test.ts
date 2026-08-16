import { describe, expect, it } from 'vitest';
import { formatPairingLink, parsePairingLink } from './pairingLink.js';

describe('parsePairingLink', () => {
  it('accepts a bare http(s) host and strips a trailing slash', () => {
    expect(parsePairingLink('http://192.168.31.226:8080/')).toEqual({
      baseUrl: 'http://192.168.31.226:8080',
    });
    expect(parsePairingLink('https://tavern.example')).toEqual({
      baseUrl: 'https://tavern.example',
    });
  });

  it('extracts token / access_token and drops them from the base URL', () => {
    expect(parsePairingLink('http://127.0.0.1:8080/?token=secret-one')).toEqual({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret-one',
    });
    expect(parsePairingLink('http://127.0.0.1:8080/?access_token=alt')).toEqual({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'alt',
    });
  });

  it('unwraps the neotavern://connect wrapper', () => {
    expect(
      parsePairingLink(
        'neotavern://connect?url=http%3A%2F%2F10.0.0.8%3A8080%2F&token=pair-token',
      ),
    ).toEqual({
      baseUrl: 'http://10.0.0.8:8080',
      token: 'pair-token',
    });
  });

  it('rejects empty, non-http, and malformed input', () => {
    expect(parsePairingLink('')).toBeNull();
    expect(parsePairingLink('   ')).toBeNull();
    expect(parsePairingLink('ftp://example.com')).toBeNull();
    expect(parsePairingLink('not a url')).toBeNull();
  });
});

describe('formatPairingLink', () => {
  it('round-trips a token onto the query string', () => {
    const link = formatPairingLink('http://192.168.1.10:8080', 'once');
    expect(parsePairingLink(link)).toEqual({
      baseUrl: 'http://192.168.1.10:8080',
      token: 'once',
    });
  });
});
