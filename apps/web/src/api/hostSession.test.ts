import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_CONNECT_EVENT,
  canChangeHost,
  clearHostSession,
  needsHostConnect,
  openHostConnect,
  readConnectQuery,
  readHostSession,
  readRemoteToken,
  writeHostSession,
  writeRemoteToken,
} from './hostSession.js';

afterEach(() => {
  clearHostSession();
  window.history.pushState({}, '', '/');
});

describe('hostSession storage', () => {
  it('round-trips a local session in localStorage and never writes the token there', () => {
    writeHostSession({ kind: 'local' });
    expect(readHostSession()).toEqual({ kind: 'local' });
    writeRemoteToken('pairing-secret');
    expect(readRemoteToken()).toBe('pairing-secret');
    expect(localStorage.getItem('neotavern.remoteToken')).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain('pairing-secret');
  });

  it('stores a remote URL without embedding the bearer', () => {
    writeHostSession({ kind: 'remote', url: 'http://192.168.1.10:8080' });
    writeRemoteToken('once');
    expect(readHostSession()).toEqual({ kind: 'remote', url: 'http://192.168.1.10:8080' });
    expect(localStorage.getItem('neotavern.hostSession')).not.toContain('once');
  });

  it('clearHostSession drops both the profile and the session token', () => {
    writeHostSession({ kind: 'remote', url: 'http://127.0.0.1:8080' });
    writeRemoteToken('x');
    clearHostSession();
    expect(readHostSession()).toBeNull();
    expect(readRemoteToken()).toBeUndefined();
  });
});

describe('readConnectQuery / needsHostConnect', () => {
  it('reads connect from the document search string', () => {
    window.history.pushState({}, '', '/?connect=http://127.0.0.1:8080');
    expect(readConnectQuery()).toBe('http://127.0.0.1:8080');
    expect(needsHostConnect()).toBe(true);
  });

  it('openHostConnect dispatches the reopen event without clearing the session', () => {
    writeHostSession({ kind: 'local' });
    const seen = vi.fn();
    window.addEventListener(HOST_CONNECT_EVENT, seen);
    openHostConnect();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(readHostSession()).toEqual({ kind: 'local' });
    window.removeEventListener(HOST_CONNECT_EVENT, seen);
  });

  it('canChangeHost is false in a plain browser origin', () => {
    expect(canChangeHost()).toBe(false);
  });
});
