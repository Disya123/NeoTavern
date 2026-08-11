import { describe, expect, it } from 'vitest';
import { extractAuthClients } from './PluginAuthDialog.js';

const VALID = {
  serviceId: 'com.example.api',
  name: 'Example API',
  authorizationUrl: 'https://api.example.com/oauth/authorize',
  tokenUrl: 'https://api.example.com/oauth/token',
  clientId: 'public-client',
  scopes: ['profile.read'],
};

describe('extractAuthClients', () => {
  it('returns an empty array when authClients is missing', () => {
    expect(extractAuthClients({})).toEqual([]);
    expect(extractAuthClients({ authClients: 'not-an-array' })).toEqual([]);
  });

  it('extracts valid clients', () => {
    expect(extractAuthClients({ authClients: [VALID] })).toEqual([VALID]);
  });

  it('drops malformed entries while keeping valid ones', () => {
    const result = extractAuthClients({
      authClients: [
        VALID,
        { serviceId: 'missing-fields' },
        { ...VALID, serviceId: '' },
        { ...VALID, scopes: ['ok', 42] },
        null,
      ],
    });
    expect(result).toEqual([VALID]);
  });

  it('never returns the raw manifest entry', () => {
    const result = extractAuthClients({ authClients: [VALID] });
    expect(result).not.toBe([VALID] as unknown);
  });
});
