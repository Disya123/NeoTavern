import { afterEach, describe, expect, it } from 'vitest';
import { isPackagedWebView, usesHashRouting } from './routing.js';

function stubLocation(protocol: string, hostname: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { protocol, hostname },
  });
}

describe('isPackagedWebView', () => {
  afterEach(() => {
    stubLocation('http:', 'localhost');
    delete (window as unknown as { __neotavernMobile?: unknown }).__neotavernMobile;
  });

  it('detects the file protocol used by the production Android host', () => {
    stubLocation('file:', '');
    expect(isPackagedWebView()).toBe(true);
  });

  it('detects the WebViewAssetLoader host used by M-1 Track B', () => {
    stubLocation('https:', 'appassets.androidplatform.net');
    expect(isPackagedWebView()).toBe(true);
  });

  it('does not treat a normal https origin as packaged', () => {
    stubLocation('https:', 'localhost');
    expect(isPackagedWebView()).toBe(false);
    expect(usesHashRouting()).toBe(false);
  });

  it('uses hash routing in the mobile shell even on http', () => {
    stubLocation('http:', 'localhost');
    (window as unknown as { __neotavernMobile: object }).__neotavernMobile = {};
    expect(usesHashRouting()).toBe(true);
  });
});
