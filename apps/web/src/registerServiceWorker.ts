/** Register the production-only Web Client shell cache. API/SSE requests are excluded in sw.js. */
import { isMobileShell } from './lib/mobile.js';
import { isPackagedWebView } from './lib/routing.js';

export function shouldRegisterServiceWorker(options: {
  production: boolean;
  serviceWorkerSupported: boolean;
  packagedOrMobileShell: boolean;
}): boolean {
  return options.production && options.serviceWorkerSupported && !options.packagedOrMobileShell;
}

export function registerServiceWorker(): void {
  if (
    !shouldRegisterServiceWorker({
      production: import.meta.env.PROD,
      serviceWorkerSupported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
      packagedOrMobileShell: isMobileShell() || isPackagedWebView(),
    })
  ) {
    return;
  }

  window.addEventListener(
    'load',
    () => {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error: unknown) => {
        console.warn('Service worker registration failed', error);
      });
    },
    { once: true },
  );
}
