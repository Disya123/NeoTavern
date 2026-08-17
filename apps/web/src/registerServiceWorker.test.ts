import { describe, expect, it } from 'vitest';
import { shouldRegisterServiceWorker } from './registerServiceWorker.js';

describe('shouldRegisterServiceWorker', () => {
  it('registers only for the production browser Web Client', () => {
    expect(
      shouldRegisterServiceWorker({
        production: true,
        serviceWorkerSupported: true,
        packagedOrMobileShell: false,
      }),
    ).toBe(true);
  });

  it('does not register inside the Android shell or packaged WebView', () => {
    expect(
      shouldRegisterServiceWorker({
        production: true,
        serviceWorkerSupported: true,
        packagedOrMobileShell: true,
      }),
    ).toBe(false);
  });

  it('does not register in development', () => {
    expect(
      shouldRegisterServiceWorker({
        production: false,
        serviceWorkerSupported: true,
        packagedOrMobileShell: false,
      }),
    ).toBe(false);
  });
});
